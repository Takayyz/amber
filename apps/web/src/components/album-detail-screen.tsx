import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ImagePlus, Trash2 } from 'lucide-react'
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '@amber/shared'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { useUploadQueue } from '@/lib/use-upload-queue'
import { cursorOf, fetchMediaPage, PAGE_SIZE, type MediaItem } from '@/lib/media-page'
import type { Database } from '@/lib/database.types'
import { AppHeader } from '@/components/app-header'
import { MediaGridSkeleton } from '@/components/loading-skeletons'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { MediaThumbnail } from '@/components/media-thumbnail'
import { UploadTray } from '@/components/upload-tray'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type Album = Database['public']['Tables']['albums']['Row']

const ACCEPTED_TYPES = Object.keys({ ...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS }).join(',')

export function AlbumDetailScreen() {
  const { albumId } = useParams<{ albumId: string }>()
  const { session } = useAuth()
  const [album, setAlbum] = useState<Album | null>(null)
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // Null while the count is in flight, and if it fails -- the dialog then
  // says what happens without saying how much.
  const [itemCount, setItemCount] = useState<number | null>(null)
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

  // Counted only when the dialog opens. The grid never counts -- it pages on
  // every scroll -- but a confirmation happens once, and how much is about to
  // disappear is the thing worth knowing before agreeing to it.
  const handleConfirmOpenChange = async (next: boolean) => {
    setConfirmOpen(next)
    if (!next || !albumId) return

    setItemCount(null)
    const { count } = await supabase
      .from('media_items')
      .select('*', { count: 'exact', head: true })
      .eq('album_id', albumId)
      .is('deleted_at', null)

    setItemCount(count ?? null)
  }

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
      // Closed first: the message belongs to the album screen, and would be
      // behind the dialog if this stayed open.
      setConfirmOpen(false)
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
      {/* The way back rides in the header's left slot, so the album gets one
          bar rather than a back button above a row of controls. */}
      <AppHeader>
        <Button variant="ghost" render={<Link to="/" />}>
          ← 戻る
        </Button>
      </AppHeader>

      {loading ? (
        <MediaGridSkeleton />
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
              {/* Destructive rather than outline: this is the one control on
                  the screen that takes something away, and it sits next to the
                  one that adds. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="destructive"
                      size="icon"
                      aria-label="アルバムを削除"
                      disabled={deleting}
                      onClick={() => void handleConfirmOpenChange(true)}
                    >
                      <Trash2 />
                    </Button>
                  }
                />
                <TooltipContent>アルバムを削除</TooltipContent>
              </Tooltip>
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
                // A spinner rather than more skeletons: the grid above is
                // already there, and this only says more is on the way.
                <div ref={sentinelRef} className="flex justify-center py-4">
                  <Spinner className="text-muted-foreground" />
                </div>
              )}
            </>
          )}
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={handleConfirmOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>アルバムを削除</DialogTitle>
            <DialogDescription>
              {itemCount === null
                ? `「${album?.name ?? ''}」と中の写真・動画をゴミ箱に移動します。`
                : itemCount === 0
                  ? `「${album?.name ?? ''}」をゴミ箱に移動します。`
                  : `「${album?.name ?? ''}」と中の写真・動画${itemCount}件をゴミ箱に移動します。`}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">ゴミ箱からいつでも復元できます。</p>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">キャンセル</Button>} />
            <Button variant="destructive" disabled={deleting} onClick={handleDeleteAlbum}>
              {deleting && <Spinner />}
              {deleting ? '削除中…' : '削除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UploadTray queue={uploads} />
    </div>
  )
}
