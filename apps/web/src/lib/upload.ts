import { classifyMedia } from '@amber/shared'
import { supabase } from '@/lib/supabase'
import { presignPut } from '@/lib/api'
import { extractExif } from '@/lib/exif'

export async function uploadMediaItem(file: File, albumId: string, userId: string): Promise<void> {
  const classification = classifyMedia(file.type)
  if (!classification) {
    throw new Error('未対応のファイル形式です')
  }
  if (file.size > classification.maxBytes) {
    throw new Error('ファイルサイズが上限を超えています')
  }

  const [{ uploadUrl, storageKey, mediaType }, exif] = await Promise.all([
    presignPut({ albumId, contentType: file.type, fileSize: file.size }),
    extractExif(file),
  ])

  const putResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  if (!putResponse.ok) {
    throw new Error('アップロードに失敗しました')
  }

  const { error } = await supabase.from('media_items').insert({
    album_id: albumId,
    media_type: mediaType,
    storage_key: storageKey,
    captured_at: exif.capturedAt?.toISOString() ?? null,
    gps_lat: exif.gpsLat,
    gps_lng: exif.gpsLng,
    uploaded_by: userId,
  })
  if (error) {
    throw new Error('アップロード情報の保存に失敗しました')
  }
}
