import { AwsClient } from 'aws4fetch'
import {
  classifyMedia,
  type InvitationErrorCode,
  type InvitationRequest,
  type InvitationResult,
  type PresignPutRequest,
  type PresignPutResult,
  type PresignGetResult,
} from '@amber/shared'
import { requireAuth } from './lib/auth'
import {
  deleteAuthUser,
  findAuthUserIdByEmail,
  findInvitation,
  findPendingInvitation,
  insertInvitation,
  inviteUser,
  isValidEmail,
  normalizeEmail,
  recordInvitationSent,
  transitionInvitation,
} from './lib/supabase'

const RESEND_COOLDOWN_MS = 60_000

function corsHeaders(env: Env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(corsHeaders(env))) {
    headers.set(key, value)
  }
  return new Response(response.body, { status: response.status, headers })
}

function invitationError(code: InvitationErrorCode, status: number): Response {
  return Response.json({ error: code }, { status })
}

/**
 * Shared by sending and re-sending so the same refusal does not come back as
 * 502 from one route and 429 from the other.
 */
function inviteFailureStatus(code: 'already_member' | 'rate_limited' | 'invite_failed'): number {
  if (code === 'already_member') return 409
  if (code === 'rate_limited') return 429
  return 502
}

function r2Client(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  })
}

// Every album id is a uuid from the database; nothing legitimate sends
// anything else.
const ALBUM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The signed URL for an object, or null if the key does not stay inside the
 * bucket.
 *
 * The key is interpolated into a URL whose first path segment is the bucket,
 * so a key that walks upwards signs a request against a different bucket
 * entirely. The R2 token is scoped to this one and would refuse it, but that
 * is a dashboard setting nothing here can assert, so the boundary is checked
 * in code as well.
 *
 * The check runs on the normalised path rather than on the key, because
 * `..`, `%2e%2e`, `%2E%2E` and `.%2e` are all the same double-dot segment to
 * the URL parser: no string comparison sees every spelling, while whatever
 * survives normalisation is exactly what R2 will be asked for.
 */
function r2ObjectUrl(env: Env, key: string): URL | null {
  const prefix = `/${env.R2_BUCKET_NAME}/`
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com${prefix}${key}`)

  if (!url.pathname.startsWith(prefix)) return null

  url.searchParams.set('X-Amz-Expires', '3600')
  return url
}

async function handlePresignPut(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  const body = await request.json<Partial<PresignPutRequest>>()
  const { albumId, contentType, fileSize } = body

  if (!albumId || !contentType || typeof fileSize !== 'number') {
    return Response.json({ error: 'albumId, contentType, and fileSize are required' }, { status: 400 })
  }

  // The album id becomes the first segment of the key, so it is checked for
  // the shape it is supposed to have rather than passed through. r2ObjectUrl
  // catches an escape either way; this is what makes the refusal legible.
  if (!ALBUM_ID_PATTERN.test(albumId)) {
    return Response.json({ error: 'albumId must be a uuid' }, { status: 400 })
  }

  const classification = classifyMedia(contentType)
  if (!classification) {
    return Response.json({ error: 'unsupported content type' }, { status: 400 })
  }
  if (fileSize > classification.maxBytes) {
    return Response.json({ error: 'file exceeds the size limit' }, { status: 400 })
  }

  const storageKey = `${albumId}/${crypto.randomUUID()}.${classification.extension}`

  const objectUrl = r2ObjectUrl(env, storageKey)
  if (!objectUrl) {
    return Response.json({ error: 'invalid storage key' }, { status: 400 })
  }

  const signed = await r2Client(env).sign(
    new Request(objectUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
    }),
    { aws: { signQuery: true } },
  )

  const result: PresignPutResult = {
    uploadUrl: signed.url,
    storageKey,
    mediaType: classification.mediaType,
  }
  return Response.json(result)
}

// The name ends up inside a signed response header, so it is rebuilt here
// rather than trusted: an allowlist of plain filename characters, a length
// cap, and the extension taken from the stored object rather than the caller.
const FILENAME_ALLOWED = /[^A-Za-z0-9._-]/g
const EXTENSION_ALLOWED = /[^A-Za-z0-9]/g
const FILENAME_MAX_LENGTH = 100
const FILENAME_FALLBACK = 'amber'
const EXTENSION_FALLBACK = 'bin'

function downloadFilename(storageKey: string, requested: string): string {
  // lastIndexOf rather than split().pop(), which returns the whole key when
  // there is no dot and so can never fall back.
  const dot = storageKey.lastIndexOf('.')
  const extension = dot === -1 ? EXTENSION_FALLBACK : storageKey.slice(dot + 1)
  const base = requested
    .replace(/\.[^.]*$/, '')
    .replace(FILENAME_ALLOWED, '')
    .slice(0, FILENAME_MAX_LENGTH)

  return `${base || FILENAME_FALLBACK}.${extension.replace(EXTENSION_ALLOWED, '')}`
}

async function handlePresignGet(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  const params = new URL(request.url).searchParams
  const key = params.get('key')
  if (!key) {
    return Response.json({ error: 'key is required' }, { status: 400 })
  }

  const url = r2ObjectUrl(env, key)
  if (!url) {
    return Response.json({ error: 'invalid key' }, { status: 400 })
  }

  // Asking for a filename is what marks the request as a download -- there is
  // no separate flag, since a download is exactly the case that needs a name.
  const requestedFilename = params.get('filename')
  if (requestedFilename !== null) {
    // The disposition is what makes the browser save the file. An <a download>
    // is ignored on a cross-origin URL, and R2 is a different origin.
    const filename = downloadFilename(key, requestedFilename)
    url.searchParams.set('response-content-disposition', `attachment; filename="${filename}"`)
  }

  const signed = await r2Client(env).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  })

  const result: PresignGetResult = { url: signed.url }
  return Response.json(result)
}

async function handleCreateInvitation(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  const body = await request.json<Partial<InvitationRequest>>()
  const email = normalizeEmail(body.email ?? '')

  if (!isValidEmail(email)) {
    return invitationError('invalid_email', 400)
  }

  const existing = await findPendingInvitation(env, email)
  if (!existing.ok) {
    // Stop rather than guess. Reading a failed lookup as "no invitation yet"
    // is what would send a second invite for an address that already has one.
    return invitationError('invite_failed', 502)
  }
  if (existing.row) {
    return invitationError('already_invited', 409)
  }

  const invited = await inviteUser(env, email)
  if (!invited.ok) {
    return invitationError(invited.code, inviteFailureStatus(invited.code))
  }

  const inserted = await insertInvitation(env, {
    email,
    invitedBy: auth.userId,
    invitedUserId: invited.userId,
  })

  if (inserted.ok) {
    const result: InvitationResult = { invitationId: inserted.id }
    return Response.json(result, { status: 201 })
  }

  if (inserted.conflict) {
    // Someone else's invite for this address won the race. Supabase Auth
    // hands back the *existing* unconfirmed user rather than making a new
    // one, so deleting it here would destroy the account belonging to the
    // invitation that got in first.
    return invitationError('already_invited', 409)
  }

  // The invite went out but the ledger did not take it. This user really is
  // ours -- no pending row claims it -- so drop it rather than leave the
  // address silently holding access with nothing on screen to cancel.
  await deleteAuthUser(env, invited.userId)
  return invitationError('invite_failed', 502)
}

/**
 * The invite link expires long before the invitation does, and with
 * self-signup off the recipient cannot ask for a replacement themselves --
 * so somebody already inside has to send one.
 */
async function handleResendInvitation(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  const lookup = await findInvitation(env, id)
  if (!lookup.ok) {
    return invitationError('invite_failed', 502)
  }
  if (!lookup.row) {
    return invitationError('not_pending', 404)
  }
  if (lookup.row.status !== 'pending') {
    return invitationError('not_pending', 409)
  }

  // Checked here rather than left to the provider's cap, which is a
  // service-wide hourly budget shared with magic-link login -- spending it on
  // re-sends would lock existing members out of signing in.
  const sinceLastSent = Date.now() - Date.parse(lookup.row.last_sent_at)
  if (Number.isFinite(sinceLastSent) && sinceLastSent < RESEND_COOLDOWN_MS) {
    return invitationError('resend_too_soon', 429)
  }

  const invited = await inviteUser(env, lookup.row.email)
  if (!invited.ok) {
    return invitationError(invited.code, inviteFailureStatus(invited.code))
  }

  // Stamps the cooldown, and refreshes invited_user_id in the same write.
  // Usually the id is unchanged, but not when the column had been emptied by
  // the account going away under a still-pending row: the re-invite made a
  // new account, and without writing its id back nothing could revoke it --
  // cancel would find no pointer, skip the delete, and report success.
  const recorded = await recordInvitationSent(env, id, invited.userId)
  if (!recorded.ok) {
    return invitationError('invite_failed', 502)
  }
  if (!recorded.row) {
    // Cancelled while the mail was going out. The account the re-invite just
    // created belongs to nothing now, and a cancelled row is not listed
    // anywhere, so take it back out rather than leave it able to log in.
    await deleteAuthUser(env, invited.userId)
    return invitationError('not_pending', 409)
  }

  return new Response(null, { status: 204 })
}

/**
 * Undoes the claim so the invitation reappears in the dialog. Leaving it
 * cancelled would hide an account that still works from the only screen able
 * to revoke it.
 */
async function abandonCancel(env: Env, id: string): Promise<Response> {
  await transitionInvitation(env, id, 'cancelled', 'pending')
  return invitationError('invite_failed', 502)
}

async function handleCancelInvitation(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  // Claim the row first. The status flip is the only atomic step available,
  // so winning it is what earns the right to delete the account. Checking
  // first and deleting after would let a confirmation land in between and
  // destroy an account that had just legitimately become a member.
  const claim = await transitionInvitation(env, id, 'pending', 'cancelled')
  if (!claim.ok) {
    // Reporting a failed write as "already cancelled" would tell the member
    // the job is done when nothing has happened yet.
    return invitationError('invite_failed', 502)
  }
  if (!claim.row) {
    return invitationError('not_pending', 409)
  }

  // A missing pointer means it was lost, not that there is nothing to revoke:
  // invited_user_id empties on its own if the account is deleted while the
  // row is still pending. Fall back to the address before concluding the
  // cancellation has nothing to do.
  let invitedUserId = claim.row.invited_user_id
  if (!invitedUserId) {
    const byEmail = await findAuthUserIdByEmail(env, claim.row.email)
    // A failed lookup is not proof there is nothing to delete, and answering
    // 204 on one would report the access revoked while it still works.
    if (!byEmail.ok) return abandonCancel(env, id)
    invitedUserId = byEmail.userId
  }

  if (invitedUserId && !(await deleteAuthUser(env, invitedUserId))) {
    return abandonCancel(env, id)
  }

  return new Response(null, { status: 204 })
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) })
    }

    const url = new URL(request.url)
    const invitationId = url.pathname.match(/^\/invitations\/([^/]+)$/)?.[1]
    const resendId = url.pathname.match(/^\/invitations\/([^/]+)\/resend$/)?.[1]
    let response: Response

    try {
      if (request.method === 'POST' && url.pathname === '/uploads/presign-put') {
        response = await handlePresignPut(request, env)
      } else if (request.method === 'GET' && url.pathname === '/media/presign-get') {
        response = await handlePresignGet(request, env)
      } else if (request.method === 'POST' && url.pathname === '/invitations') {
        response = await handleCreateInvitation(request, env)
      } else if (request.method === 'POST' && resendId) {
        response = await handleResendInvitation(request, env, resendId)
      } else if (request.method === 'DELETE' && invitationId) {
        response = await handleCancelInvitation(request, env, invitationId)
      } else {
        response = new Response('Not Found', { status: 404 })
      }
    } catch (error: unknown) {
      // Anything escaping a handler -- a malformed request body, a dependency
      // answering with HTML -- would otherwise become a 500 that skips
      // withCors below, which the browser reports as a network failure with
      // no readable body. A 500 the client can actually read is better.
      console.error('unhandled error', error)
      response = Response.json({ error: 'internal error' }, { status: 500 })
    }

    return withCors(response, env)
  },
} satisfies ExportedHandler<Env>
