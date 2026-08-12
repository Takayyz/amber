import { SELF, env, fetchMock } from 'cloudflare:test'
import { expect } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { JWK } from 'jose'
import type { InvitationRow } from '../src/lib/supabase'

// The worker never sees this host -- SELF routes by path -- but fetch needs an
// absolute URL and a real-looking one keeps the failures readable.
const WORKER_ORIGIN = 'https://api.test'

// Relative paths have no origin of their own, and URL needs one to parse the
// query string an interceptor is matching on.
const PATH_PARSE_BASE = 'http://interceptor.invalid'

export const JWKS_PATH = '/auth/v1/.well-known/jwks.json'
export const REST_INVITATIONS_PATH = '/rest/v1/invitations'
export const AUTH_INVITE_PATH = '/auth/v1/invite'
export const AUTH_ADMIN_USERS_PATH = '/auth/v1/admin/users'

const SIGNING_ALG = 'ES256'
const KEY_ID = 'test-signing-key'
const TOKEN_LIFETIME = '5m'

export const MEMBER_ID = '11111111-1111-4111-8111-111111111111'
export const INVITED_USER_ID = '22222222-2222-4222-8222-222222222222'
export const INVITATION_ID = '33333333-3333-4333-8333-333333333333'
export const INVITEE_EMAIL = 'invitee@example.com'

// The worker refuses a re-send within a minute of the last one. Tests pick a
// last_sent_at on one side or the other rather than moving the clock: in
// workerd time only advances at an I/O boundary, so fake timers are a poor fit.
export const RESEND_COOLDOWN_MS = 60_000
const WELL_BEFORE_COOLDOWN_MS = 5 * RESEND_COOLDOWN_MS

type Interceptable = ReturnType<typeof fetchMock.get>

// undici's mock pools have carried cleanMocks() since v7; the types bundled
// with cloudflare:test predate it. Dropping the interceptors between tests is
// what stops a failure from cascading -- one left behind by a broken
// expectation would otherwise match the next test's request.
interface CleanableMockPool {
  cleanMocks(): void
}

let signingKey: CryptoKey | undefined
let verificationJwk: JWK | undefined

/**
 * Turns on the mock agent and publishes the key set the worker verifies tokens
 * against. Call it once per file, in `beforeAll`.
 *
 * `disableNetConnect` is what gives the negative assertions teeth: a request no
 * test declared -- deleting an auth account that should have been left alone --
 * throws inside the handler instead of quietly going out.
 */
export async function mockNetwork(): Promise<void> {
  // Repeated from vitest.config.mts on purpose: matching it here is what
  // catches the suite quietly falling back to the real secrets in .dev.vars.
  expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe('test-service-role-key')

  fetchMock.activate()
  fetchMock.disableNetConnect()

  const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALG, { extractable: true })
  signingKey = privateKey
  verificationJwk = await exportJWK(publicKey)
  interceptJwks()
}

// Persisted because jose caches the key set: the fetch happens once per file,
// and which test triggers it depends on the order they run in.
function interceptJwks(): void {
  if (!verificationJwk) throw new Error('call mockNetwork() before publishing the key set')

  supabase()
    .intercept({ method: 'GET', path: JWKS_PATH })
    .reply(200, { keys: [{ ...verificationJwk, kid: KEY_ID, alg: SIGNING_ALG, use: 'sig' }] })
    .persist()
}

/**
 * Checks the test's declared calls all happened, then clears the interceptors
 * so nothing survives into the next one. Use it as the `afterEach`.
 */
export function endOfTest(): void {
  try {
    assertAllCallsMade()
  } finally {
    ;(supabase() as unknown as CleanableMockPool).cleanMocks()
    interceptJwks()
  }
}

export function supabase(): Interceptable {
  return fetchMock.get(env.SUPABASE_URL)
}

/**
 * Every interceptor a test registers is expected to be used. One left over
 * means a call the worker was supposed to make never happened -- which is the
 * assertion for "it re-scoped the update to pending" or "it revoked the
 * account", since a request that fails to match simply leaves it unconsumed.
 */
export function assertAllCallsMade(): void {
  const pending = fetchMock.pendingInterceptors().filter((interceptor) => interceptor.path !== JWKS_PATH)
  expect(pending.map((interceptor) => `${interceptor.method} ${String(interceptor.path)}`)).toEqual([])
}

// The pending-interceptor report prints the matcher itself, so each one carries
// a readable label instead of its own source text.
function labelled<T extends (input: string) => boolean>(label: string, match: T): T {
  match.toString = () => label
  return match
}

/**
 * Matches a PostgREST request on the invitations table whose query carries at
 * least `expected`. Anything the worker leaves out fails to match, so the
 * scoping a handler relies on -- `status=eq.pending` on a claim, say -- is part
 * of what the interceptor asserts rather than something checked separately.
 */
export function invitationQuery(expected: Record<string, string>): (path: string) => boolean {
  const label = `${REST_INVITATIONS_PATH}?${new URLSearchParams(expected).toString()}`

  return labelled(label, (path) => {
    const url = new URL(path, PATH_PARSE_BASE)
    if (url.pathname !== REST_INVITATIONS_PATH) return false
    return Object.entries(expected).every(([key, value]) => url.searchParams.get(key) === value)
  })
}

/** Matches on the pathname alone, ignoring whatever query the worker appends. */
export function pathIs(pathname: string): (path: string) => boolean {
  return labelled(pathname, (path) => new URL(path, PATH_PARSE_BASE).pathname === pathname)
}

/** Matches a JSON request body carrying at least these fields. */
export function bodyWith(expected: Record<string, string>): (body: string) => boolean {
  const label = JSON.stringify(expected)

  return labelled(label, (body) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return false
    }
    if (typeof parsed !== 'object' || parsed === null) return false
    const record = parsed as Record<string, unknown>
    return Object.entries(expected).every(([key, value]) => record[key] === value)
  })
}

export function invitationRow(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: INVITATION_ID,
    email: INVITEE_EMAIL,
    invited_user_id: INVITED_USER_ID,
    status: 'pending',
    last_sent_at: new Date(Date.now() - WELL_BEFORE_COOLDOWN_MS).toISOString(),
    ...overrides,
  }
}

/** A `last_sent_at` recent enough that another re-send has to be refused. */
export function justSentAt(): string {
  return new Date().toISOString()
}

export async function bearerToken(userId: string = MEMBER_ID): Promise<string> {
  if (!signingKey) throw new Error('call mockNetwork() before signing a token')

  return new SignJWT({})
    .setProtectedHeader({ alg: SIGNING_ALG, kid: KEY_ID })
    .setIssuer(`${env.SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_LIFETIME)
    .sign(signingKey)
}

export function request(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${WORKER_ORIGIN}${path}`, init)
}

export async function authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${await bearerToken()}`)
  return request(path, { ...init, headers })
}

export async function errorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => null)
  if (typeof body !== 'object' || body === null) return undefined
  const { error } = body as Record<string, unknown>
  return typeof error === 'string' ? error : undefined
}
