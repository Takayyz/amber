import { createRemoteJWKSet, jwtVerify } from 'jose'

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

// Callers either get the verified user id or a ready-to-return rejection --
// the invite endpoint needs the id for invited_by, so a bare null-on-success
// return would leave it re-parsing the token it just handed over.
export type AuthResult = { ok: true; userId: string } | { ok: false; response: Response }

export async function requireAuth(request: Request, env: Env): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization')
  const token = authHeader?.match(/^Bearer (.+)$/)?.[1]

  if (!token) {
    return { ok: false, response: Response.json({ error: 'missing bearer token' }, { status: 401 }) }
  }

  jwks ??= createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`))

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    })

    if (!payload.sub) {
      return { ok: false, response: Response.json({ error: 'invalid token' }, { status: 401 }) }
    }

    return { ok: true, userId: payload.sub }
  } catch {
    return { ok: false, response: Response.json({ error: 'invalid token' }, { status: 401 }) }
  }
}
