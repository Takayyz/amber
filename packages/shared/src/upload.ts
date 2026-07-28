export interface PresignPutRequest {
  albumId: string
  contentType: string
  fileSize: number
}

export interface PresignPutResult {
  uploadUrl: string
  storageKey: string
  mediaType: 'photo' | 'video'
}

export interface PresignGetResult {
  url: string
}

export function isPresignPutResult(value: unknown): value is PresignPutResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.uploadUrl === 'string' &&
    typeof record.storageKey === 'string' &&
    (record.mediaType === 'photo' || record.mediaType === 'video')
  )
}

export function isPresignGetResult(value: unknown): value is PresignGetResult {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).url === 'string'
}

export const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
}

export const VIDEO_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}

export const PHOTO_MAX_BYTES = 20 * 1024 * 1024
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024

export interface MediaClassification {
  mediaType: 'photo' | 'video'
  extension: string
  maxBytes: number
}

export function classifyMedia(contentType: string): MediaClassification | null {
  if (contentType in PHOTO_EXTENSIONS) {
    return { mediaType: 'photo', extension: PHOTO_EXTENSIONS[contentType], maxBytes: PHOTO_MAX_BYTES }
  }
  if (contentType in VIDEO_EXTENSIONS) {
    return { mediaType: 'video', extension: VIDEO_EXTENSIONS[contentType], maxBytes: VIDEO_MAX_BYTES }
  }
  return null
}
