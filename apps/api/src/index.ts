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
  markInvitationCancelled,
  normalizeEmail,
  setInvitedUserId,
} from './lib/supabase'

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

// Shared by sending and re-sending so the same refusal does not come back as
// 502 from one route and 429 from the other.
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

function r2ObjectUrl(env: Env, key: string) {
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`)
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

  const classification = classifyMedia(contentType)
  if (!classification) {
    return Response.json({ error: 'unsupported content type' }, { status: 400 })
  }
  if (fileSize > classification.maxBytes) {
    return Response.json({ error: 'file exceeds the size limit' }, { status: 400 })
  }

  const storageKey = `${albumId}/${crypto.randomUUID()}.${classification.extension}`

  const signed = await r2Client(env).sign(
    new Request(r2ObjectUrl(env, storageKey), {
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

async function handlePresignGet(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  const key = new URL(request.url).searchParams.get('key')
  if (!key) {
    return Response.json({ error: 'key is required' }, { status: 400 })
  }

  const signed = await r2Client(env).sign(new Request(r2ObjectUrl(env, key), { method: 'GET' }), {
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

// The invite link expires long before the invitation does, and with
// self-signup off the recipient cannot ask for a replacement themselves --
// so somebody already inside has to send one.
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

  const invited = await inviteUser(env, lookup.row.email)
  if (!invited.ok) {
    return invitationError(invited.code, inviteFailureStatus(invited.code))
  }

  // Usually Supabase Auth hands back the same unconfirmed user and this is a
  // no-op. It is not when invited_user_id was emptied by the account being
  // deleted out from under a still-pending row: the re-invite then creates a
  // new account, and without writing its id back nothing could revoke it --
  // cancel would find no pointer, skip the delete, and report success.
  if (invited.userId !== lookup.row.invited_user_id) {
    if (!(await setInvitedUserId(env, id, invited.userId))) {
      return invitationError('invite_failed', 502)
    }
  }

  return new Response(null, { status: 204 })
}

async function handleCancelInvitation(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  const lookup = await findInvitation(env, id)
  if (!lookup.ok) {
    // Reporting a lookup failure as "already cancelled" would tell the member
    // the job is done when nothing has happened yet.
    return invitationError('invite_failed', 502)
  }
  const invitation = lookup.row
  if (!invitation) {
    return invitationError('not_pending', 404)
  }
  if (invitation.status !== 'pending') {
    return invitationError('not_pending', 409)
  }

  // A missing pointer means it was lost, not that there is nothing to revoke:
  // invited_user_id empties on its own if the account is deleted while the
  // row is still pending. Fall back to the address before concluding the
  // cancellation has nothing to do.
  let invitedUserId = invitation.invited_user_id
  if (!invitedUserId) {
    const byEmail = await findAuthUserIdByEmail(env, invitation.email)
    if (!byEmail.ok) {
      return invitationError('invite_failed', 502)
    }
    invitedUserId = byEmail.userId
  }

  // Delete the account before touching the ledger: the row is the only
  // pointer to it, so flipping the status first would strand the account with
  // its access intact if this then failed.
  if (invitedUserId && !(await deleteAuthUser(env, invitedUserId))) {
    return invitationError('invite_failed', 502)
  }

  if (!(await markInvitationCancelled(env, id))) {
    return invitationError('invite_failed', 502)
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
