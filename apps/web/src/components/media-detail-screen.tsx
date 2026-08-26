import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Download, Star, Trash2, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { presignGet } from '@/lib/api'
import { uploaderLabel } from '@/lib/member-name'
import { TagEditor } from '@/components/tag-editor'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  albumSource,
  cursorOf,
  fetchMediaItem,
  searchSource,
  tagsOf,
  type MediaItem,
  type MediaTag,
} from '@/lib/media-page'

const SWIPE_THRESHOLD_PX = 50
// The Worker signs for an hour; re-sign short of that so a long-lived tab
// never hands a just-expired URL to an <img> that has no way to report it.
const URL_TTL_MS = 50 * 60 * 1000
// Long enough for the browser to have taken over the download, after which
// the iframe has nothing left to do.
const DOWNLOAD_FRAME_TTL_MS = 60 * 1000

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function formatTakenAt(item: MediaItem): string {
  return dateFormatter.format(new Date(item.sort_key ?? item.uploaded_at))
}

// The video element owns its own arrow keys and scrubber drags; treating
// those as navigation would seek and jump away at the same time.
function isFromVideo(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('video') !== null
}

// The tag input owns every key it receives: an arrow is a text cursor rather
// than the next photo, and Escape closes the suggestions rather than the
// viewer someone is still typing into.
function isFromTextInput(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea') !== null
}

interface CachedUrl {
  url: string
  expiresAt: number
}

export function MediaDetailScreen() {
  const { albumId, mediaItemId } = useParams<{ albumId: string; mediaItemId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  // Opened out of a search, the viewer steps through those results rather
  // than through the album this one photo happens to sit in.
  const searching = searchParams.get('from') === 'search'
  const tagNames = useMemo(() => searchParams.getAll('tags'), [searchParams])
  const source = useMemo(
    () => (searching ? searchSource(tagNames) : albumSource(albumId ?? '')),
    [searching, tagNames, albumId],
  )
  // Changes exactly when the list being stepped through does, which is when
  // everything held from the previous one stops applying.
  const contextKey = searching ? `search:${JSON.stringify(tagNames)}` : `album:${albumId}`
  // Only the item on screen and its two neighbours, rather than the whole
  // album: this route is bookmarkable, so it can be opened at the five
  // hundredth photo without the grid ever having been visited.
  const [current, setCurrent] = useState<MediaItem | null>(null)
  const [previous, setPrevious] = useState<MediaItem | null>(null)
  const [next, setNext] = useState<MediaItem | null>(null)
  // Items already fetched, so stepping onto a neighbour shows it at once
  // instead of waiting to re-fetch what is already in hand.
  const known = useRef(new Map<string, MediaItem>())
  const [loading, setLoading] = useState(true)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Presigned URLs are per-object, so they cache by storage key rather than
  // by position -- stepping back and forth must not re-sign what it just
  // signed -- and carry an expiry, since the signature outlives neither.
  const urlCache = useRef(new Map<string, CachedUrl>())
  const touchStartX = useRef<number | null>(null)
  const [coverId, setCoverId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Where closing lands: whichever listing the photo was opened out of.
  const backPath = useMemo(() => {
    if (!searching) return `/albums/${albumId}`
    const params = new URLSearchParams()
    for (const tag of tagNames) params.append('tags', tag)
    return `/search?${params.toString()}`
  }, [searching, tagNames, albumId])

  // Carried onto every step, so the photo stepped onto is still being read
  // out of the same list.
  const itemQuery = searching ? `?${searchParams.toString()}` : ''

  // A different list invalidates everything held from the last one.
  useEffect(() => {
    known.current.clear()
  }, [contextKey])

  useEffect(() => {
    if (!albumId || !mediaItemId) return
    let cancelled = false

    // Stepping onto a neighbour already has the item, so the photo swaps
    // immediately and only the new neighbours are fetched.
    const inHand = known.current.get(mediaItemId) ?? null
    setCurrent(inHand)
    setLoading(inHand === null)
    if (!inHand) {
      setPrevious(null)
      setNext(null)
    }

    const load = async () => {
      const item = inHand ?? (await fetchMediaItem(albumId, mediaItemId))
      if (cancelled) return

      setCurrent(item)
      setLoading(false)
      if (!item) return
      known.current.set(item.id, item)

      // sort_key alone is not a total order -- Exif capture time is only
      // second-precision, so burst shots share one. The cursor carries the id
      // as well, which is what stops a tied group from being skipped or
      // repeated. The grid pages on the same pair, so the two agree.
      const [before, after] = await Promise.all([
        source.before(1, cursorOf(item)),
        source.after(1, cursorOf(item)),
      ])
      if (cancelled) return

      setPrevious(before[0] ?? null)
      setNext(after.items[0] ?? null)
      for (const neighbour of [...before, ...after.items]) {
        known.current.set(neighbour.id, neighbour)
      }
    }

    load().catch(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [albumId, mediaItemId, source])

  const resolveUrl = useCallback(async (storageKey: string): Promise<string> => {
    const cached = urlCache.current.get(storageKey)
    if (cached && cached.expiresAt > Date.now()) return cached.url

    const signed = await presignGet(storageKey)
    urlCache.current.set(storageKey, { url: signed, expiresAt: Date.now() + URL_TTL_MS })
    return signed
  }, [])

  useEffect(() => {
    if (!current) return
    let cancelled = false

    const cached = urlCache.current.get(current.storage_key)
    setUrl(cached && cached.expiresAt > Date.now() ? cached.url : null)
    setFailed(false)
    // Whatever went wrong belonged to the item being left behind.
    setActionError(null)

    resolveUrl(current.storage_key)
      .then((signed) => {
        if (!cancelled) setUrl(signed)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    // Sign the neighbours now so an arrow press swaps the image instead of
    // waiting on a round trip. A failure here is not worth surfacing -- the
    // item's own load will retry when it becomes current.
    for (const neighbour of [previous, next]) {
      if (neighbour) void resolveUrl(neighbour.storage_key).catch(() => {})
    }

    return () => {
      cancelled = true
    }
  }, [current, previous, next, resolveUrl])

  useEffect(() => {
    if (!albumId) return
    let cancelled = false

    supabase
      .from('albums')
      .select('cover_media_item_id')
      .eq('id', albumId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setCoverId(data?.cover_media_item_id ?? null)
      })

    return () => {
      cancelled = true
    }
  }, [albumId])

  const handleDownload = async () => {
    if (!current) return
    setBusy(true)
    setActionError(null)

    try {
      // Named after the capture date rather than the storage key, which is a
      // uuid and tells the person nothing once it is in their downloads.
      const stem = formatTakenAt(current).replace(/[/: ]/g, '-')
      const signed = await presignGet(current.storage_key, { filename: `amber-${stem}` })

      // Handed to a detached iframe rather than assigned to location: the
      // attachment disposition means the browser saves the file without
      // pulling a 500MB video through the page, but if R2 refuses the
      // signature it answers with an XML error instead, and a top-level
      // navigation would replace the viewer with it.
      const frame = document.createElement('iframe')
      frame.hidden = true
      frame.src = signed
      document.body.appendChild(frame)
      window.setTimeout(() => frame.remove(), DOWNLOAD_FRAME_TTL_MS)
    } catch {
      setActionError('ダウンロードを開始できませんでした。')
    } finally {
      setBusy(false)
    }
  }

  const handleSetCover = async () => {
    if (!current || !albumId) return
    setBusy(true)
    setActionError(null)

    const { error } = await supabase
      .from('albums')
      .update({ cover_media_item_id: current.id })
      .eq('id', albumId)

    if (error) setActionError('カバーに設定できませんでした。')
    else setCoverId(current.id)
    setBusy(false)
  }

  const handleDelete = async () => {
    if (!current) return
    setBusy(true)
    setActionError(null)

    // Soft: the row is flagged and the R2 object left alone, so this is
    // undoable from the trash (README "Soft delete").
    const { error } = await supabase
      .from('media_items')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', current.id)

    setBusy(false)
    if (error) {
      setActionError('削除できませんでした。')
      return
    }

    // Forget it locally too, or stepping back onto it would show the copy in
    // hand rather than re-reading and finding it gone.
    known.current.delete(current.id)

    // Whichever neighbour is left is a better landing spot than an item that
    // is no longer there.
    const remaining = next ?? previous
    navigate(
      remaining ? `/albums/${remaining.album_id}/items/${remaining.id}${itemQuery}` : backPath,
      { replace: true },
    )
  }

  const handleTagsChange = (tags: MediaTag[]) => {
    if (!current) return

    const updated: MediaItem = { ...current, media_item_tags: tags.map((tag) => ({ tags: tag })) }
    setCurrent(updated)
    // The neighbour cache holds its own copy of this item, so leaving it
    // behind would bring the old tags back on the way in from the next photo.
    known.current.set(updated.id, updated)
  }

  const step = useCallback(
    (target: MediaItem | null) => {
      // The album comes from the target rather than the URL: a search steps
      // across albums, so the next photo need not live in this one.
      // Replace rather than push: every item keeps its own URL, but a run of
      // arrow presses should not bury the list under a stack of Back steps.
      if (target) {
        navigate(`/albums/${target.album_id}/items/${target.id}${itemQuery}`, { replace: true })
      }
    },
    [itemQuery, navigate],
  )

  const close = useCallback(() => {
    // Also a replace, for the same reason: opening an item is the one step
    // worth keeping, so leaving should undo it rather than stack on top.
    navigate(backPath, { replace: true })
  }, [backPath, navigate])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isFromTextInput(event.target)) return
      if (event.key === 'Escape') {
        close()
        return
      }
      if (isFromVideo(event.target)) return
      if (event.key === 'ArrowLeft') step(previous)
      else if (event.key === 'ArrowRight') step(next)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [previous, next, step, close])

  const handleTouchStart = (event: React.TouchEvent) => {
    // A second finger means a pinch, not a swipe.
    if (event.touches.length > 1 || isFromVideo(event.target)) {
      touchStartX.current = null
      return
    }
    touchStartX.current = event.touches[0].clientX
  }

  const handleTouchEnd = (event: React.TouchEvent) => {
    const startX = touchStartX.current
    touchStartX.current = null
    if (startX === null) return

    const deltaX = event.changedTouches[0].clientX - startX
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return
    step(deltaX > 0 ? previous : next)
  }

  return (
    <div
      className="fixed inset-0 flex flex-col bg-neutral-950 text-neutral-100"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <header className="flex items-center justify-between p-4">
        <Link
          to={backPath}
          replace
          aria-label={searching ? '検索結果に戻る' : 'アルバムに戻る'}
          className="rounded-md p-2 hover:bg-white/10"
        >
          <X className="size-5" />
        </Link>
        {current && (
          <>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="ダウンロード"
                disabled={busy}
                onClick={handleDownload}
                className="rounded-md p-2 hover:bg-white/10 disabled:opacity-50"
              >
                <Download className="size-5" />
              </button>
              <button
                type="button"
                aria-label={coverId === current.id ? 'アルバムのカバーに設定済み' : 'アルバムのカバーにする'}
                disabled={busy || coverId === current.id || current.media_type === 'video'}
                onClick={handleSetCover}
                className="rounded-md p-2 hover:bg-white/10 disabled:opacity-50"
              >
                <Star className={coverId === current.id ? 'size-5 fill-current' : 'size-5'} />
              </button>
              {/* Names what it removes, so it cannot be read as the album
                  delete that sits one screen back behind the same icon. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={current.media_type === 'video' ? '動画を削除' : '写真を削除'}
                      disabled={busy}
                      onClick={handleDelete}
                      // Marked out by colour alone. A border on this one and
                      // not the other two broke the row's rhythm.
                      className="rounded-md p-2 text-red-400 hover:bg-white/10 disabled:opacity-50"
                    >
                      <Trash2 className="size-5" />
                    </button>
                  }
                />
                <TooltipContent>
                  {current.media_type === 'video' ? '動画を削除' : '写真を削除'}
                </TooltipContent>
              </Tooltip>
            </div>
          </>
        )}
      </header>

      {actionError && <p className="px-4 pb-2 text-center text-sm text-red-400">{actionError}</p>}

      {loading ? (
        <p className="flex-1 place-content-center text-center text-sm text-neutral-400">
          読み込み中…
        </p>
      ) : !current ? (
        <div className="flex-1 place-content-center text-center text-sm text-neutral-400">
          <p>写真が見つかりません。</p>
          <Link to={backPath} replace className="underline">
            {searching ? '検索結果に戻る' : 'アルバムに戻る'}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 items-center gap-2 px-2">
            <button
              type="button"
              aria-label="前へ"
              disabled={!previous}
              onClick={() => step(previous)}
              className="rounded-full p-2 hover:bg-white/10 disabled:invisible"
            >
              <ChevronLeft className="size-6" />
            </button>

            <div className="flex min-w-0 flex-1 items-center justify-center">
              {failed ? (
                <p className="text-sm text-neutral-400">
                  読み込めませんでした。時間をおいて開き直してください。
                </p>
              ) : !url ? (
                <p className="text-sm text-neutral-400">読み込み中…</p>
              ) : current.media_type === 'video' ? (
                <video src={url} controls playsInline className="max-h-full max-w-full" />
              ) : (
                <img src={url} alt="" className="max-h-full max-w-full object-contain" />
              )}
            </div>

            <button
              type="button"
              aria-label="次へ"
              disabled={!next}
              onClick={() => step(next)}
              className="rounded-full p-2 hover:bg-white/10 disabled:invisible"
            >
              <ChevronRight className="size-6" />
            </button>
          </div>

          <footer className="space-y-2 p-4 text-center text-sm text-neutral-400">
            <p>
              {formatTakenAt(current)} · by {uploaderLabel(current)}
            </p>
            <TagEditor
              mediaItemId={current.id}
              tags={tagsOf(current)}
              onChange={handleTagsChange}
              onError={setActionError}
            />
          </footer>
        </>
      )}
    </div>
  )
}
