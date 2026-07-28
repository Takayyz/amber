import { createRemoteJWKSet, jwtVerify } from 'jose'

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  const authHeader = request.headers.get('Authorization')
  const token = authHeader?.match(/^Bearer (.+)$/)?.[1]

  if (!token) {
    return Response.json({ error: 'missing bearer token' }, { status: 401 })
  }

  jwks ??= createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`))

  try {
    await jwtVerify(token, jwks, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    })
    return null
  } catch {
    return Response.json({ error: 'invalid token' }, { status: 401 })
  }
}
