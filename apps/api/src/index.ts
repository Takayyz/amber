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
  findInvitation,
  findPendingInvitation,
  insertInvitation,
  inviteUser,
  isValidEmail,
  markInvitationCancelled,
  normalizeEmail,
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

  if (await findPendingInvitation(env, email)) {
    return invitationError('already_invited', 409)
  }

  const invited = await inviteUser(env, email)
  if (!invited.ok) {
    return invitationError(invited.code, invited.code === 'already_member' ? 409 : 502)
  }

  const inserted = await insertInvitation(env, {
    email,
    invitedBy: auth.userId,
    invitedUserId: invited.userId,
  })

  if (!inserted.ok) {
    // The invite went out but the ledger did not take it. Drop the auth user
    // so the address is not left silently holding access with nothing on
    // screen to cancel.
    await deleteAuthUser(env, invited.userId)
    return inserted.conflict
      ? invitationError('already_invited', 409)
      : invitationError('invite_failed', 502)
  }

  const result: InvitationResult = { invitationId: inserted.id }
  return Response.json(result, { status: 201 })
}

async function handleCancelInvitation(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireAuth(request, env)
  if (!auth.ok) return auth.response

  const invitation = await findInvitation(env, id)
  if (!invitation) {
    return invitationError('not_pending', 404)
  }
  if (invitation.status !== 'pending') {
    return invitationError('not_pending', 409)
  }

  // Delete the account before touching the ledger: the row is the only
  // pointer to it, so flipping the status first would strand the account with
  // its access intact if this then failed.
  if (invitation.invited_user_id && !(await deleteAuthUser(env, invitation.invited_user_id))) {
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
    let response: Response

    if (request.method === 'POST' && url.pathname === '/uploads/presign-put') {
      response = await handlePresignPut(request, env)
    } else if (request.method === 'GET' && url.pathname === '/media/presign-get') {
      response = await handlePresignGet(request, env)
    } else if (request.method === 'POST' && url.pathname === '/invitations') {
      response = await handleCreateInvitation(request, env)
    } else if (request.method === 'DELETE' && invitationId) {
      response = await handleCancelInvitation(request, env, invitationId)
    } else {
      response = new Response('Not Found', { status: 404 })
    }

    return withCors(response, env)
  },
} satisfies ExportedHandler<Env>
