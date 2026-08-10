// Service-role access to Supabase. Everything here bypasses RLS, so it stays
// confined to the two operations the browser genuinely cannot perform:
// creating and destroying the auth user behind an invitation.

export interface InvitationRow {
  id: string
  email: string
  invited_user_id: string | null
  status: string
  last_sent_at: string
}

const INVITATION_COLUMNS = 'id,email,invited_user_id,status,last_sent_at'

function serviceHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  }
}

function toInvitationRow(value: unknown): InvitationRow | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const { id, email, status, invited_user_id: invitedUserId, last_sent_at: lastSentAt } = record

  if (typeof id !== 'string' || typeof email !== 'string' || typeof status !== 'string') return null
  if (typeof lastSentAt !== 'string') return null
  if (invitedUserId !== null && typeof invitedUserId !== 'string') return null

  return { id, email, status, invited_user_id: invitedUserId, last_sent_at: lastSentAt }
}

// "No such row" and "the lookup failed" have to stay distinguishable: the
// invite path treats the first as permission to go ahead, and going ahead on
// a failed lookup is what lets it delete somebody else's account.
export type LookupResult =
  | { ok: true; row: InvitationRow | null }
  | { ok: false }

async function firstRow(response: Response): Promise<LookupResult> {
  if (!response.ok) return { ok: false }

  const body: unknown = await response.json().catch(() => null)
  if (!Array.isArray(body)) return { ok: false }

  return { ok: true, row: body.length > 0 ? toInvitationRow(body[0]) : null }
}

// Emails are stored lowercased so PostgREST can match them with eq. rather
// than ilike, whose `_` wildcard would silently match unrelated addresses
// (`foo_bar@` vs `fooXbar@`) and reject legitimate invitations.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export type InviteOutcome =
  | { ok: true; userId: string }
  | { ok: false; code: 'already_member' | 'rate_limited' | 'invite_failed' }

export async function inviteUser(env: Env, email: string): Promise<InviteOutcome> {
  const url = new URL(`${env.SUPABASE_URL}/auth/v1/invite`)
  url.searchParams.set('redirect_to', env.ALLOWED_ORIGIN)

  const response = await fetch(url, {
    method: 'POST',
    headers: serviceHeaders(env),
    body: JSON.stringify({ email }),
  })

  // A proxy or a crash can answer with HTML or nothing at all; letting that
  // throw would escape the CORS wrapper and surface in the browser as a
  // network error with no message to show.
  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    // Supabase Auth already refuses to invite a confirmed account, so
    // email_exists is the "already a member" check -- there is no email
    // column on public.members to ask instead.
    const errorCode =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).error_code
        : undefined

    if (errorCode === 'email_exists') return { ok: false, code: 'already_member' }
    if (errorCode === 'over_email_send_rate_limit' || response.status === 429) {
      return { ok: false, code: 'rate_limited' }
    }
    return { ok: false, code: 'invite_failed' }
  }

  const userId =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined
  return typeof userId === 'string' ? { ok: true, userId } : { ok: false, code: 'invite_failed' }
}

// Written after every re-send. last_sent_at drives the cooldown, and
// invited_user_id has to be refreshed alongside it because the column is
// `on delete set null`: it empties whenever the account goes away while the
// row is still pending, and the re-invite then created a fresh account whose
// id is the only thing that can revoke it later.
export async function recordInvitationSent(
  env: Env,
  id: string,
  userId: string,
): Promise<boolean> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('id', `eq.${id}`)

  const response = await fetch(url, {
    method: 'PATCH',
    headers: serviceHeaders(env),
    body: JSON.stringify({ invited_user_id: userId, last_sent_at: new Date().toISOString() }),
  })

  return response.ok
}

export async function deleteAuthUser(env: Env, userId: string): Promise<boolean> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: serviceHeaders(env),
  })
  // A user that is already gone is the state we wanted anyway.
  return response.ok || response.status === 404
}

export type AuthUserLookup = { ok: true; userId: string | null } | { ok: false }

// The fallback for a row whose invited_user_id was emptied: the address is
// the only handle left on the account, and cancelling has to find it or it
// reports success while leaving the account able to log in.
export async function findAuthUserIdByEmail(env: Env, email: string): Promise<AuthUserLookup> {
  const url = new URL(`${env.SUPABASE_URL}/auth/v1/admin/users`)
  url.searchParams.set('filter', email)
  url.searchParams.set('per_page', '50')

  const response = await fetch(url, { headers: serviceHeaders(env) })
  if (!response.ok) return { ok: false }

  const body: unknown = await response.json().catch(() => null)
  if (typeof body !== 'object' || body === null) return { ok: false }

  const users = (body as Record<string, unknown>).users
  if (!Array.isArray(users)) return { ok: false }

  // `filter` is a substring search, so the exact address has to be picked out.
  for (const user of users) {
    if (typeof user !== 'object' || user === null) continue
    const record = user as Record<string, unknown>
    if (typeof record.email === 'string' && record.email.toLowerCase() === email) {
      return { ok: true, userId: typeof record.id === 'string' ? record.id : null }
    }
  }

  return { ok: true, userId: null }
}

export async function findPendingInvitation(env: Env, email: string): Promise<LookupResult> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('select', INVITATION_COLUMNS)
  url.searchParams.set('email', `eq.${email}`)
  url.searchParams.set('status', 'eq.pending')
  url.searchParams.set('limit', '1')

  return firstRow(await fetch(url, { headers: serviceHeaders(env) }))
}

export async function findInvitation(env: Env, id: string): Promise<LookupResult> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('select', INVITATION_COLUMNS)
  url.searchParams.set('id', `eq.${id}`)
  url.searchParams.set('limit', '1')

  return firstRow(await fetch(url, { headers: serviceHeaders(env) }))
}

// PostgREST answers 409 for a unique violation and a foreign-key violation
// alike, so the status alone would report "already invited" for an invite
// sent by someone whose own members row is missing. The SQLSTATE in the body
// is what tells them apart.
async function isUniqueViolation(response: Response): Promise<boolean> {
  if (response.status !== 409) return false
  const body: unknown = await response.json().catch(() => null)
  if (typeof body !== 'object' || body === null) return false
  return (body as Record<string, unknown>).code === '23505'
}

export type InsertOutcome = { ok: true; id: string } | { ok: false; conflict: boolean }

export async function insertInvitation(
  env: Env,
  invitation: { email: string; invitedBy: string; invitedUserId: string },
): Promise<InsertOutcome> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('select', INVITATION_COLUMNS)

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...serviceHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify({
      email: invitation.email,
      invited_by: invitation.invitedBy,
      invited_user_id: invitation.invitedUserId,
    }),
  })

  if (!response.ok) {
    // The partial unique index on pending emails is the race-proof duplicate
    // check; the lookup before the invite is only there to avoid mailing
    // someone twice in the common case.
    return { ok: false, conflict: await isUniqueViolation(response) }
  }

  const lookup = await firstRow(response)
  return lookup.ok && lookup.row ? { ok: true, id: lookup.row.id } : { ok: false, conflict: false }
}

// Scoped to pending so a confirmation that lands mid-cancel wins: the trigger
// will have moved the row to accepted, and this must not drag it back to
// cancelled after the account is already gone.
export async function markInvitationCancelled(env: Env, id: string): Promise<boolean> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('id', `eq.${id}`)
  url.searchParams.set('status', 'eq.pending')

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { ...serviceHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'cancelled' }),
  })

  // Zero rows back means it stopped being pending in between.
  const lookup = await firstRow(response)
  return lookup.ok && lookup.row !== null
}
