import { env } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { authedRequest, endOfTest, mockNetwork, request } from './helpers'

// Everything the browser sees passes through the router: the CORS wrapper, the
// catch-all that keeps a thrown handler readable, and the auth gate in front of
// every endpoint.
describe('router', () => {
  beforeAll(mockNetwork)
  afterEach(endOfTest)

  it('answers the preflight with the configured origin', async () => {
    const response = await request('/invitations', { method: 'OPTIONS' })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('DELETE')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
  })

  it('puts CORS headers on a 404 too', async () => {
    const response = await request('/nope')

    expect(response.status).toBe(404)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
  })

  it('refuses a request with no bearer token', async () => {
    const response = await request('/media/presign-get?key=a/b.jpg')

    expect(response.status).toBe(401)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
  })

  it('refuses a token it cannot verify', async () => {
    const response = await request('/media/presign-get?key=a/b.jpg', {
      headers: { Authorization: 'Bearer not.a.jwt' },
    })

    expect(response.status).toBe(401)
  })

  // A handler that throws would otherwise become a 500 that skips the CORS
  // wrapper, which the browser reports as a network failure with no body.
  it('turns a thrown handler into a readable 500', async () => {
    const response = await authedRequest('/invitations', {
      method: 'POST',
      body: 'this is not json',
    })

    expect(response.status).toBe(500)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(env.ALLOWED_ORIGIN)
    expect(await response.json()).toEqual({ error: 'internal error' })
  })
})
