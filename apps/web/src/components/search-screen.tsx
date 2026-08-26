import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchAllTags } from '@/lib/tags'
import {
  cursorOf,
  PAGE_SIZE,
  searchMediaPage,
  type MediaItem,
  type MediaTag,
} from '@/lib/media-page'
import { MediaThumbnail } from '@/components/media-thumbnail'
import { Button } from '@/components/ui/button'

// Repeated rather than comma-joined: a tag is free text and may contain a
// comma itself, which a split would then tear in half.
const TAG_PARAM = 'tags'

export function SearchScreen() {
  const [searchParams, setSearchParams] = useSearchParams()
  // Safe to depend on directly: useSearchParams memoises on location.search,
  // so this array keeps its identity until the selection actually changes.
  const selected = useMemo(() => searchParams.getAll(TAG_PARAM), [searchParams])

  const [vocabulary, setVocabulary] = useState<MediaTag[]>([])
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const loadingMoreRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    fetchAllTags()
      .then((all) => {
        if (!cancelled) setVocabulary(all)
      })
      .catch(() => {
        if (!cancelled) setErrorMessage('タグを読み込めませんでした。')
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selected.length === 0) {
      setItems([])
      setHasMore(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setErrorMessage(null)

    searchMediaPage(selected, PAGE_SIZE)
      .then((page) => {
        if (cancelled) return
        setItems(page.items)
        setHasMore(page.hasMore)
      })
      .catch(() => {
        if (!cancelled) setErrorMessage('検索できませんでした。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selected])

  const loadMore = useCallback(async () => {
    // The ref, not the state: two scroll events in the same frame would both
    // see the old value and fetch the same page twice.
    if (loadingMoreRef.current || !hasMore) return
    const last = items.at(-1)
    if (!last) return

    loadingMoreRef.current = true
    try {
      const page = await searchMediaPage(selected, PAGE_SIZE, cursorOf(last))
      setItems((current) => [...current, ...page.items])
      setHasMore(page.hasMore)
    } catch {
      setErrorMessage('続きを読み込めませんでした。')
    } finally {
      loadingMoreRef.current = false
    }
  }, [hasMore, items, selected])

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

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((tag) => tag !== name)
      : [...selected, name]

    const params = new URLSearchParams()
    for (const tag of next) params.append(TAG_PARAM, tag)
    // Replace, so that narrowing a search five times does not take five Back
    // presses to leave -- the same reasoning as stepping through the viewer.
    setSearchParams(params, { replace: true })
  }

  // Carried into the viewer so its arrows step through these results rather
  // than through the album the photo happens to sit in.
  const detailQuery = useMemo(() => {
    const params = new URLSearchParams()
    params.set('from', 'search')
    for (const tag of selected) params.append(TAG_PARAM, tag)
    return params.toString()
  }, [selected])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      <Button variant="ghost" className="self-start" render={<Link to="/" />}>
        ← 戻る
      </Button>

      <div>
        <h1 className="text-lg font-medium">タグで探す</h1>
        {selected.length > 1 && (
          <p className="text-sm text-muted-foreground">
            選んだタグのいずれかが付いた写真を表示します。
          </p>
        )}
      </div>

      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

      {vocabulary.length === 0 ? (
        <p className="text-sm text-muted-foreground">まだタグがありません。</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {vocabulary.map((tag) => {
            const on = selected.includes(tag.name)
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(tag.name)}
                className={
                  on
                    ? 'rounded-full bg-primary px-3 py-1 text-xs text-primary-foreground'
                    : 'rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground hover:bg-muted/70'
                }
              >
                {tag.name}
              </button>
            )
          })}
        </div>
      )}

      {selected.length === 0 ? (
        <p className="text-sm text-muted-foreground">タグを選ぶと写真が絞り込まれます。</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">該当する写真がありません。</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {items.map((item) => (
              <Link
                key={item.id}
                to={`/albums/${item.album_id}/items/${item.id}?${detailQuery}`}
                className="block"
              >
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
    </div>
  )
}
