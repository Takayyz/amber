import { classifyMedia } from '@amber/shared'
import { supabase } from '@/lib/supabase'
import { presignPut } from '@/lib/api'
import { extractExif } from '@/lib/exif'
import { extractVideoThumbnail } from '@/lib/video-thumbnail'

// What a PUT leaves behind. Held onto so a retry after the object is already
// in R2 skips straight to the ledger row: re-uploading would abandon the first
// copy, and nothing purges R2 -- permanent delete is still out of scope.
export interface StoredObject {
  storageKey: string
  mediaType: 'photo' | 'video'
  // A second object beside the video, when this browser could decode a frame.
  // Carried for the same reason as storageKey: a retry that already has one
  // must not upload another.
  thumbnailKey?: string
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

/**
 * Draws the video's opening frame and puts it in R2 beside the video.
 *
 * Best-effort throughout: every failure answers with undefined, and the item
 * is recorded without a thumbnail rather than the upload failing over a
 * preview. The grid falls back to the placeholder in that case.
 */
async function uploadThumbnail(
  file: File,
  albumId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const frame = await extractVideoThumbnail(file)
  if (!frame || signal.aborted) return undefined

  try {
    const presigned = await presignPut({
      albumId,
      contentType: 'image/jpeg',
      fileSize: frame.size,
    })

    // Plain fetch rather than the XHR the video itself needs: a thumbnail is
    // tens of kilobytes, so there is no progress worth reporting.
    const response = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      body: frame,
      headers: { 'Content-Type': 'image/jpeg' },
      signal,
    })

    return response.ok ? presigned.storageKey : undefined
  } catch {
    return undefined
  }
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
    thumbnail_key: stored.thumbnailKey ?? null,
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
    const stored = options.stored
    // The video is already in R2; only the frame is worth another try, and
    // only if the earlier attempt never got one.
    if (stored.mediaType === 'video' && !stored.thumbnailKey) {
      stored.thumbnailKey = await uploadThumbnail(file, albumId, options.signal)
    }
    await recordMediaItem(file, albumId, userId, stored)
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

  // A stop landing just as the PUT finished would otherwise still write the
  // row, and the tray would say the upload was cancelled while the photo
  // appeared in the album anyway.
  if (options.signal.aborted) {
    throw new UploadError('中止しました', { retryable: false, stored })
  }

  // After the video is safely stored, so a browser that cannot decode it
  // costs the upload nothing. The tray sits at 100% while this runs.
  if (stored.mediaType === 'video') {
    stored.thumbnailKey = await uploadThumbnail(file, albumId, options.signal)
  }

  await recordMediaItem(file, albumId, userId, stored)
}
