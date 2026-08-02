// Service-role access to Supabase. Everything here bypasses RLS, so it stays
// confined to the two operations the browser genuinely cannot perform:
// creating and destroying the auth user behind an invitation.

export interface InvitationRow {
  id: string
  email: string
  invited_user_id: string | null
  status: string
}

const INVITATION_COLUMNS = 'id,email,invited_user_id,status'

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
  const { id, email, status, invited_user_id: invitedUserId } = record

  if (typeof id !== 'string' || typeof email !== 'string' || typeof status !== 'string') return null
  if (invitedUserId !== null && typeof invitedUserId !== 'string') return null

  return { id, email, status, invited_user_id: invitedUserId }
}

async function firstRow(response: Response): Promise<InvitationRow | null> {
  if (!response.ok) return null
  const body: unknown = await response.json()
  return Array.isArray(body) && body.length > 0 ? toInvitationRow(body[0]) : null
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
  | { ok: false; code: 'already_member' | 'invite_failed' }

export async function inviteUser(env: Env, email: string): Promise<InviteOutcome> {
  const url = new URL(`${env.SUPABASE_URL}/auth/v1/invite`)
  url.searchParams.set('redirect_to', env.ALLOWED_ORIGIN)

  const response = await fetch(url, {
    method: 'POST',
    headers: serviceHeaders(env),
    body: JSON.stringify({ email }),
  })

  const body: unknown = await response.json()

  if (!response.ok) {
    // Supabase Auth already refuses to invite a confirmed account, so this is
    // the "already a member" check -- there is no email column on
    // public.members to ask instead.
    const errorCode =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).error_code
        : undefined
    return { ok: false, code: errorCode === 'email_exists' ? 'already_member' : 'invite_failed' }
  }

  const userId =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined
  return typeof userId === 'string' ? { ok: true, userId } : { ok: false, code: 'invite_failed' }
}

export async function deleteAuthUser(env: Env, userId: string): Promise<boolean> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: serviceHeaders(env),
  })
  // A user that is already gone is the state we wanted anyway.
  return response.ok || response.status === 404
}

export async function findPendingInvitation(
  env: Env,
  email: string,
): Promise<InvitationRow | null> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('select', INVITATION_COLUMNS)
  url.searchParams.set('email', `eq.${email}`)
  url.searchParams.set('status', 'eq.pending')
  url.searchParams.set('limit', '1')

  return firstRow(await fetch(url, { headers: serviceHeaders(env) }))
}

export async function findInvitation(env: Env, id: string): Promise<InvitationRow | null> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('select', INVITATION_COLUMNS)
  url.searchParams.set('id', `eq.${id}`)
  url.searchParams.set('limit', '1')

  return firstRow(await fetch(url, { headers: serviceHeaders(env) }))
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
    return { ok: false, conflict: response.status === 409 }
  }

  const row = await firstRow(response)
  return row ? { ok: true, id: row.id } : { ok: false, conflict: false }
}

export async function markInvitationCancelled(env: Env, id: string): Promise<boolean> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/invitations`)
  url.searchParams.set('id', `eq.${id}`)

  const response = await fetch(url, {
    method: 'PATCH',
    headers: serviceHeaders(env),
    body: JSON.stringify({ status: 'cancelled' }),
  })

  return response.ok
}
