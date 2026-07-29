import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ImagePlus, Play } from 'lucide-react'
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '@amber/shared'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { presignGet } from '@/lib/api'
import { uploadMediaItem } from '@/lib/upload'
import type { Database } from '@/lib/database.types'
import { Button } from '@/components/ui/button'

type Album = Database['public']['Tables']['albums']['Row']
type MediaItem = Database['public']['Tables']['media_items']['Row']

const ACCEPTED_TYPES = Object.keys({ ...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS }).join(',')

function MediaThumbnail({ item }: { item: MediaItem }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (item.media_type === 'video') return
    let cancelled = false
    presignGet(item.storage_key).then((signedUrl) => {
      if (!cancelled) setUrl(signedUrl)
    })
    return () => {
      cancelled = true
    }
  }, [item.storage_key, item.media_type])

  if (item.media_type === 'video') {
    return (
      <div className="flex aspect-square items-center justify-center rounded-md bg-muted">
        <Play className="size-6 text-muted-foreground" />
      </div>
    )
  }

  return url ? (
    <img src={url} alt="" className="aspect-square rounded-md object-cover" />
  ) : (
    <div className="aspect-square animate-pulse rounded-md bg-muted" />
  )
}

export function AlbumDetailScreen() {
  const { albumId } = useParams<{ albumId: string }>()
  const { session } = useAuth()
  const [album, setAlbum] = useState<Album | null>(null)
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchMediaItems = async (currentAlbumId: string) => {
    const { data } = await supabase
      .from('media_items')
      .select('*')
      .eq('album_id', currentAlbumId)
      .is('deleted_at', null)
      .order('sort_key', { ascending: true })
    setMediaItems(data ?? [])
  }

  useEffect(() => {
    if (!albumId) return

    setLoading(true)
    Promise.all([
      supabase.from('albums').select('*').eq('id', albumId).is('deleted_at', null).maybeSingle(),
      fetchMediaItems(albumId),
    ]).then(([{ data }]) => {
      setAlbum(data)
      setLoading(false)
    })
  }, [albumId])

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0 || !albumId || !session) return
    setUploading(true)
    setUploadError(null)

    const results = await Promise.allSettled(
      Array.from(files).map((file) => uploadMediaItem(file, albumId, session.user.id)),
    )
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length > 0) {
      failed.forEach((result) => console.error('upload failed', result.reason))
      setUploadError(`${failed.length}件のアップロードに失敗しました。`)
    }

    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    await fetchMediaItems(albumId)
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      <Button variant="outline" className="self-start" render={<Link to="/" />}>
        ← アルバム一覧に戻る
      </Button>

      {loading ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : !album ? (
        <p className="text-sm text-muted-foreground">アルバムが見つかりません。</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-medium">{album.name}</h1>
              {album.description && (
                <p className="text-sm text-muted-foreground">{album.description}</p>
              )}
            </div>
            <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <ImagePlus />
              {uploading ? 'アップロード中…' : '追加'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={(event) => handleFilesSelected(event.target.files)}
            />
          </div>

          {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}

          {mediaItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだ写真がありません。</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {mediaItems.map((item) => (
                <MediaThumbnail key={item.id} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
