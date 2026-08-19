import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ImagePlus, Play, Trash2 } from 'lucide-react'
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '@amber/shared'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { presignGet } from '@/lib/api'
import { useUploadQueue } from '@/lib/use-upload-queue'
import { cursorOf, fetchMediaPage, type MediaItem } from '@/lib/media-page'
import type { Database } from '@/lib/database.types'
import { Button } from '@/components/ui/button'
import { UploadTray } from '@/components/upload-tray'

type Album = Database['public']['Tables']['albums']['Row']

const ACCEPTED_TYPES = Object.keys({ ...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS }).join(',')

// One screen's worth on a phone is 3 columns of roughly 4 rows; a page a few
// times that keeps the sentinel from firing again the moment it is reached.
const PAGE_SIZE = 36

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  // Reloads from the top. Used for the first paint and after an upload batch:
  // a new photo can land anywhere in capture order, so patching the tail would
  // put it in the wrong place.
  const fetchMediaItems = useCallback(async (currentAlbumId: string) => {
    try {
      const page = await fetchMediaPage(currentAlbumId, PAGE_SIZE)
      setMediaItems(page.items)
      setHasMore(page.hasMore)
    } catch {
      setErrorMessage('写真を読み込めませんでした。')
    }
  }, [])

  const loadMore = useCallback(async () => {
    // The ref, not the state: two scroll events in the same frame would both
    // see the old value and fetch the same page twice.
    if (!albumId || loadingMoreRef.current || !hasMore) return
    const last = mediaItems.at(-1)
    if (!last) return

    loadingMoreRef.current = true
    try {
      const page = await fetchMediaPage(albumId, PAGE_SIZE, cursorOf(last))
      setMediaItems((current) => [...current, ...page.items])
      setHasMore(page.hasMore)
    } catch {
      setErrorMessage('続きを読み込めませんでした。')
    } finally {
      loadingMoreRef.current = false
    }
  }, [albumId, hasMore, mediaItems])

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
  }, [albumId, fetchMediaItems])

  // Watches a marker below the grid. rootMargin starts the fetch before it is
  // actually on screen, so the next rows are usually there by the time the
  // member scrolls to where they belong.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore()
      },
      { rootMargin: '400px' },
    )
    observer.observe(sentinel)

    return () => observer.disconnect()
  }, [hasMore, loadMore])

  // The queue calls this once the batch comes to rest, rather than after each
  // file: a refresh per upload would refetch the whole album dozens of times.
  const handleUploadsSettled = useCallback(() => {
    if (albumId) void fetchMediaItems(albumId)
  }, [albumId, fetchMediaItems])

  const uploads = useUploadQueue(albumId, session?.user.id, handleUploadsSettled)

  const handleDeleteAlbum = async () => {
    if (!albumId) return
    setDeleting(true)

    // Only the album row is flagged. Its items keep their own deleted_at, so
    // restoring the album brings back everything except what was deleted
    // individually first (README "Soft-delete cascade without touching child
    // rows").
    const { error } = await supabase
      .from('albums')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', albumId)

    setDeleting(false)
    if (error) {
      setErrorMessage('アルバムを削除できませんでした。')
      return
    }
    navigate('/', { replace: true })
  }

  const handleFilesSelected = (files: FileList | null) => {
    if (!files || files.length === 0) return
    uploads.enqueue(files)
    // Cleared so picking the same file again still fires a change event.
    if (fileInputRef.current) fileInputRef.current.value = ''
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
            <div className="flex shrink-0 items-center gap-2">
              {/* Stays enabled while a batch runs -- more files just join the
                  queue, and the tray is where the progress lives now. */}
              <Button onClick={() => fileInputRef.current?.click()}>
                <ImagePlus />
                追加
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="アルバムを削除"
                disabled={deleting}
                onClick={handleDeleteAlbum}
              >
                <Trash2 />
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={(event) => handleFilesSelected(event.target.files)}
            />
          </div>

          {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

          {mediaItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだ写真がありません。</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                {mediaItems.map((item) => (
                  <Link key={item.id} to={`/albums/${albumId}/items/${item.id}`} className="block">
                    <MediaThumbnail item={item} />
                  </Link>
                ))}
              </div>
              {hasMore && (
                <div ref={sentinelRef} className="py-4 text-center text-sm text-muted-foreground">
                  読み込み中…
                </div>
              )}
            </>
          )}
        </>
      )}

      <UploadTray queue={uploads} />
    </div>
  )
}
