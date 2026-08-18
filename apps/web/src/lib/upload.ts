import { classifyMedia } from '@amber/shared'
import { supabase } from '@/lib/supabase'
import { presignPut } from '@/lib/api'
import { extractExif } from '@/lib/exif'

// What a PUT leaves behind. Held onto so a retry after the object is already
// in R2 skips straight to the ledger row: re-uploading would abandon the first
// copy, and nothing purges R2 -- permanent delete is still out of scope.
export interface StoredObject {
  storageKey: string
  mediaType: 'photo' | 'video'
}

// Every message here reaches the tray as-is, so they are written for the member
// rather than for a log. `retryable` says whether waiting and trying again could
// plausibly help: a refused file type answers the same way however long we
// wait, so it fails at once instead of sitting through three attempts.
export class UploadError extends Error {
  readonly retryable: boolean
  readonly stored: StoredObject | undefined

  constructor(message: string, options: { retryable: boolean; stored?: StoredObject }) {
    super(message)
    this.name = 'UploadError'
    this.retryable = options.retryable
    this.stored = options.stored
  }
}

export interface UploadOptions {
  signal: AbortSignal
  // Reports bytes sent so far for this file, not a delta.
  onProgress: (sentBytes: number) => void
  // Set when an earlier attempt got the object into R2 but failed afterwards.
  stored?: StoredObject
}

const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_SERVER_ERROR = 500

// fetch cannot report upload progress -- it has no equivalent of
// upload.onprogress, and the request-body stream that would replace it is
// unsupported in Safari, which rules it out for an app used from an iPhone.
function putWithProgress(url: string, file: File, options: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()

    const abort = () => request.abort()
    options.signal.addEventListener('abort', abort)
    const settle = (finish: () => void) => {
      options.signal.removeEventListener('abort', abort)
      finish()
    }

    request.upload.addEventListener('progress', (event) => options.onProgress(event.loaded))

    request.addEventListener('load', () => {
      settle(() => {
        if (request.status >= 200 && request.status < 300) {
          resolve()
          return
        }
        // A refused signature comes back 4xx and will keep doing so; an
        // overloaded bucket comes back 5xx and might not.
        const retryable = request.status >= HTTP_SERVER_ERROR || request.status === HTTP_TOO_MANY_REQUESTS
        reject(new UploadError('送信に失敗しました', { retryable }))
      })
    })

    request.addEventListener('error', () => {
      settle(() => reject(new UploadError('通信が途切れました', { retryable: true })))
    })
    request.addEventListener('timeout', () => {
      settle(() => reject(new UploadError('時間内に送信できませんでした', { retryable: true })))
    })
    request.addEventListener('abort', () => {
      settle(() => reject(new UploadError('中止しました', { retryable: false })))
    })

    request.open('PUT', url)
    request.setRequestHeader('Content-Type', file.type)
    request.send(file)
  })
}

async function recordMediaItem(
  file: File,
  albumId: string,
  userId: string,
  stored: StoredObject,
): Promise<void> {
  const exif = await extractExif(file)

  const { error } = await supabase.from('media_items').insert({
    album_id: albumId,
    media_type: stored.mediaType,
    storage_key: stored.storageKey,
    captured_at: exif.capturedAt?.toISOString() ?? null,
    gps_lat: exif.gpsLat,
    gps_lng: exif.gpsLng,
    uploaded_by: userId,
  })

  if (error) {
    // The object is in R2 either way, so hand it back: retrying from the top
    // would upload a second copy and leave the first one unreferenced.
    throw new UploadError('アップロード情報の保存に失敗しました', { retryable: true, stored })
  }
}

export async function uploadMediaItem(
  file: File,
  albumId: string,
  userId: string,
  options: UploadOptions,
): Promise<void> {
  if (options.stored) {
    await recordMediaItem(file, albumId, userId, options.stored)
    return
  }

  const classification = classifyMedia(file.type)
  if (!classification) {
    throw new UploadError('未対応のファイル形式です', { retryable: false })
  }
  if (file.size > classification.maxBytes) {
    throw new UploadError('ファイルサイズが上限を超えています', { retryable: false })
  }

  const presigned = await presignPut({
    albumId,
    contentType: file.type,
    fileSize: file.size,
  }).catch(() => {
    throw new UploadError('アップロードの準備に失敗しました', { retryable: true })
  })

  await putWithProgress(presigned.uploadUrl, file, options)

  // Only now is there an object to point at. A signed URL lasts an hour and a
  // failed PUT can be the signature itself, so a later attempt signs afresh
  // rather than reusing this one.
  const stored: StoredObject = {
    storageKey: presigned.storageKey,
    mediaType: presigned.mediaType,
  }
  await recordMediaItem(file, albumId, userId, stored)
}
