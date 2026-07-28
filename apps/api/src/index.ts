import { AwsClient } from 'aws4fetch'
import { classifyMedia, type PresignPutRequest, type PresignPutResult, type PresignGetResult } from '@amber/shared'
import { requireAuth } from './lib/auth'

function corsHeaders(env: Env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  const authError = await requireAuth(request, env)
  if (authError) return authError

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
  const authError = await requireAuth(request, env)
  if (authError) return authError

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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) })
    }

    const url = new URL(request.url)
    let response: Response

    if (request.method === 'POST' && url.pathname === '/uploads/presign-put') {
      response = await handlePresignPut(request, env)
    } else if (request.method === 'GET' && url.pathname === '/media/presign-get') {
      response = await handlePresignGet(request, env)
    } else {
      response = new Response('Not Found', { status: 404 })
    }

    return withCors(response, env)
  },
} satisfies ExportedHandler<Env>
