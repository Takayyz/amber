import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { presignGet } from '@/lib/api'
import type { Database } from '@/lib/database.types'

type MediaItem = Database['public']['Tables']['media_items']['Row']

const SWIPE_THRESHOLD_PX = 50
// The Worker signs for an hour; re-sign short of that so a long-lived tab
// never hands a just-expired URL to an <img> that has no way to report it.
const URL_TTL_MS = 50 * 60 * 1000

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

interface CachedUrl {
  url: string
  expiresAt: number
}

export function MediaDetailScreen() {
  const { albumId, mediaItemId } = useParams<{ albumId: string; mediaItemId: string }>()
  const navigate = useNavigate()
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Presigned URLs are per-object, so they cache by storage key rather than
  // by position -- stepping back and forth must not re-sign what it just
  // signed -- and carry an expiry, since the signature outlives neither.
  const urlCache = useRef(new Map<string, CachedUrl>())
  const touchStartX = useRef<number | null>(null)

  const albumPath = `/albums/${albumId}`
  const index = items.findIndex((item) => item.id === mediaItemId)
  const current = index >= 0 ? items[index] : null
  const previous = index > 0 ? items[index - 1] : null
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null

  useEffect(() => {
    if (!albumId) return
    let cancelled = false

    setLoading(true)
    supabase
      .from('media_items')
      .select('*')
      .eq('album_id', albumId)
      .is('deleted_at', null)
      // sort_key alone is not a total order: Exif capture time is only
      // second-precision, so burst shots share one. The grid runs the same
      // pair of keys, and the two listings have to agree or a thumbnail
      // opens its neighbour.
      .order('sort_key', { ascending: true })
      .order('id', { ascending: true })
      .then(({ data }) => {
        if (cancelled) return
        setItems(data ?? [])
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [albumId])

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

  const step = useCallback(
    (target: MediaItem | null) => {
      // Replace rather than push: every item keeps its own URL, but a run of
      // arrow presses should not bury the album under a stack of Back steps.
      if (target) navigate(`${albumPath}/items/${target.id}`, { replace: true })
    },
    [albumPath, navigate],
  )

  const close = useCallback(() => {
    // Also a replace, for the same reason: opening an item is the one step
    // worth keeping, so leaving should undo it rather than stack on top.
    navigate(albumPath, { replace: true })
  }, [albumPath, navigate])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
          to={albumPath}
          replace
          aria-label="アルバムに戻る"
          className="rounded-md p-2 hover:bg-white/10"
        >
          <X className="size-5" />
        </Link>
        {current && (
          <span className="text-sm text-neutral-400">
            {index + 1} / {items.length}
          </span>
        )}
      </header>

      {loading ? (
        <p className="flex-1 place-content-center text-center text-sm text-neutral-400">
          読み込み中…
        </p>
      ) : !current ? (
        <div className="flex-1 place-content-center text-center text-sm text-neutral-400">
          <p>写真が見つかりません。</p>
          <Link to={albumPath} replace className="underline">
            アルバムに戻る
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

          <footer className="p-4 text-center text-sm text-neutral-400">
            {formatTakenAt(current)}
          </footer>
        </>
      )}
    </div>
  )
}
