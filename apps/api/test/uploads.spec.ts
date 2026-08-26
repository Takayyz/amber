import { env } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PHOTO_MAX_BYTES, VIDEO_MAX_BYTES } from '@amber/shared'
import { authedRequest, endOfTest, mockNetwork } from './helpers'

const ALBUM_ID = '55555555-5555-4555-8555-555555555555'
const SMALL_ENOUGH = 1024

// Signing happens locally, so these never leave the worker -- the assertions
// read the URL the browser would have been handed.
async function signedUrl(response: Response): Promise<URL> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) throw new Error('expected a JSON object')
  const { url, uploadUrl } = body as Record<string, unknown>
  const target = url ?? uploadUrl
  if (typeof target !== 'string') throw new Error('expected a signed URL')
  return new URL(target)
}

function presignPut(body: unknown) {
  return authedRequest('/uploads/presign-put', { method: 'POST', body: JSON.stringify(body) })
}

function presignGet(query: string) {
  return authedRequest(`/media/presign-get?${query}`)
}

describe('uploads', () => {
  beforeAll(mockNetwork)
  afterEach(endOfTest)

  describe('POST /uploads/presign-put', () => {
    it('requires the album, content type and size', async () => {
      const response = await presignPut({ albumId: ALBUM_ID })

      expect(response.status).toBe(400)
    })

    it('refuses a content type the album cannot hold', async () => {
      const response = await presignPut({ albumId: ALBUM_ID, contentType: 'application/pdf', fileSize: SMALL_ENOUGH })

      expect(response.status).toBe(400)
    })

    it('refuses a photo over the size limit', async () => {
      const response = await presignPut({
        albumId: ALBUM_ID,
        contentType: 'image/jpeg',
        fileSize: PHOTO_MAX_BYTES + 1,
      })

      expect(response.status).toBe(400)
    })

    // The limits differ per kind, so a video just over the photo cap is fine.
    it('allows a video larger than the photo limit', async () => {
      const response = await presignPut({
        albumId: ALBUM_ID,
        contentType: 'video/mp4',
        fileSize: PHOTO_MAX_BYTES + 1,
      })

      expect(response.status).toBe(200)
      expect(await response.clone().json()).toMatchObject({ mediaType: 'video' })
      expect((await signedUrl(response)).pathname).toMatch(/\.mp4$/)
    })

    it('refuses a video over its own limit', async () => {
      const response = await presignPut({
        albumId: ALBUM_ID,
        contentType: 'video/mp4',
        fileSize: VIDEO_MAX_BYTES + 1,
      })

      expect(response.status).toBe(400)
    })

    // The album id is the first segment of the key, and the bucket is the
    // segment before it. An id that walks upwards would sign a write against
    // a different bucket, so only the shape a real id has gets through.
    it.each([
      ['a parent segment', '../other-bucket'],
      ['an encoded parent segment', '%2e%2e/other-bucket'],
      ['a bare parent', '..'],
      ['an absolute path', '/other-bucket'],
      ['anything that is not a uuid', 'not-a-uuid'],
    ])('refuses an album id that is %s', async (_label, albumId) => {
      const response = await presignPut({ albumId, contentType: 'image/jpeg', fileSize: SMALL_ENOUGH })

      expect(response.status).toBe(400)
    })

    // The key is filed under the album and carries the extension for the type
    // the caller declared, not one taken from a filename.
    it('files the object under the album with a signed PUT url', async () => {
      const response = await presignPut({ albumId: ALBUM_ID, contentType: 'image/jpeg', fileSize: SMALL_ENOUGH })

      expect(response.status).toBe(200)
      const body: unknown = await response.clone().json()
      expect(body).toMatchObject({ mediaType: 'photo' })
      expect((body as { storageKey: string }).storageKey).toMatch(new RegExp(`^${ALBUM_ID}/[0-9a-f-]+\\.jpg$`))

      const url = await signedUrl(response)
      expect(url.host).toBe(`${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    })
  })

  describe('GET /media/presign-get', () => {
    const KEY = `${ALBUM_ID}/abcdef.jpg`

    it('requires a key', async () => {
      const response = await presignGet('')

      expect(response.status).toBe(400)
    })

    // The bucket is the first path segment, so a key that climbs out of it
    // would be signed against whatever bucket it landed in. Every spelling
    // below is the same double-dot segment once the URL parser normalises it,
    // which is why the check runs on the normalised path rather than the key.
    it.each([
      ['a parent segment', '../other-bucket/x.jpg'],
      ['an encoded parent segment', '%2e%2e/other-bucket/x.jpg'],
      ['an upper case encoded parent', '%2E%2E/other-bucket/x.jpg'],
      ['a half-encoded parent', '.%2e/other-bucket/x.jpg'],
      ['a parent buried mid-key', `${ALBUM_ID}/../../other-bucket/x.jpg`],
    ])('refuses a key with %s', async (_label, key) => {
      const response = await presignGet(`key=${encodeURIComponent(key)}`)

      expect(response.status).toBe(400)
    })

    // Viewing is the default. Only asking for a filename turns it into a save.
    it('signs a plain read with no disposition', async () => {
      const url = await signedUrl(await presignGet(`key=${encodeURIComponent(KEY)}`))

      expect(url.searchParams.get('response-content-disposition')).toBeNull()
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    })

    // An <a download> is ignored across origins and R2 is a different origin,
    // so the disposition is what actually makes the browser save the file.
    it('adds an attachment disposition when a filename is asked for', async () => {
      const url = await signedUrl(await presignGet(`key=${encodeURIComponent(KEY)}&filename=holiday.jpg`))

      expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="holiday.jpg"')
    })

    // The name lands inside a signed response header, so it is rebuilt from an
    // allowlist rather than trusted. Dots survive it -- they are legitimate in
    // a filename -- but nothing that could leave the name behind does.
    async function dispositionFor(requested: string): Promise<string> {
      const query = `key=${encodeURIComponent(KEY)}&filename=${encodeURIComponent(requested)}`
      const url = await signedUrl(await presignGet(query))
      return url.searchParams.get('response-content-disposition') ?? ''
    }

    it('drops the separators out of a traversal', async () => {
      const disposition = await dispositionFor('../../etc/passwd')

      expect(disposition).not.toContain('/')
      expect(disposition).toBe('attachment; filename="....jpg"')
    })

    it('takes the extension from the stored object', async () => {
      expect(await dispositionFor('photo.exe')).toBe('attachment; filename="photo.jpg"')
    })

    // A quote would end the header's filename early and let the rest of the
    // string be read as further disposition parameters.
    it('drops quotes that would break out of the header', async () => {
      const disposition = await dispositionFor('a"; attachment; x="')

      expect(disposition).toBe('attachment; filename="aattachmentx.jpg"')
    })

    it('falls back when nothing survives the allowlist', async () => {
      expect(await dispositionFor('###')).toBe('attachment; filename="amber.jpg"')
    })

    it('falls back on an empty name', async () => {
      expect(await dispositionFor('')).toBe('attachment; filename="amber.jpg"')
    })

    it('caps a very long name', async () => {
      const disposition = await dispositionFor(`${'x'.repeat(300)}.jpg`)

      expect(disposition).toBe(`attachment; filename="${'x'.repeat(100)}.jpg"`)
    })

    // lastIndexOf rather than split().pop(), which returns the whole key when
    // there is no dot and so could never fall back.
    it('falls back to a generic extension for a key that has none', async () => {
      const url = await signedUrl(await presignGet(`key=${encodeURIComponent(`${ALBUM_ID}/noextension`)}&filename=x`))

      expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="x.bin"')
    })
  })
})
