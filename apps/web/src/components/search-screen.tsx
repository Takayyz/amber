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
import { MediaGridSkeleton, TagChipsSkeleton } from '@/components/loading-skeletons'
import { MediaThumbnail } from '@/components/media-thumbnail'
import { AppHeader } from '@/components/app-header'
import { QUERY_PARAM, TagSearchField } from '@/components/tag-search-field'
import { useIsMobile } from '@/hooks/use-mobile'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

// Repeated rather than comma-joined: a tag is free text and may contain a
// comma itself, which a split would then tear in half.
const TAG_PARAM = 'tags'

export function SearchScreen() {
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  // Safe to depend on directly: useSearchParams memoises on location.search,
  // so this array keeps its identity until the selection actually changes.
  const selected = useMemo(() => searchParams.getAll(TAG_PARAM), [searchParams])

  const [vocabulary, setVocabulary] = useState<MediaTag[]>([])
  // Kept apart from the array being empty. Without it the first paint claims
  // there are no tags at all, which is both untrue and the one flicker that
  // gives away that a screen was swapped rather than a box focused.
  const [vocabularyLoading, setVocabularyLoading] = useState(true)
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
      .finally(() => {
        if (!cancelled) setVocabularyLoading(false)
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
    // `q` is deliberately not carried across: it did its job finding this tag,
    // and dropping it puts the rest of the vocabulary back within reach for
    // whichever tag is picked next.
    // Replace, so that narrowing a search five times does not take five Back
    // presses to leave -- the same reasoning as stepping through the viewer.
    setSearchParams(params, { replace: true })
  }

  // `loading` says a search is in flight; what that should look like depends on
  // whether there is anything worth keeping on screen. Only the first search
  // has nothing, so only the first one gets a skeleton -- the same reasoning as
  // the viewer, which holds the photo it has while fetching its neighbours.
  const showSkeleton = loading && items.length === 0
  const stale = loading && items.length > 0

  const query = searchParams.get(QUERY_PARAM)?.trim() ?? ''

  // Selected tags stay on screen whatever is typed. Filtering them out of
  // sight would leave no way to see what the results are currently narrowed
  // by, or to undo it -- the box is for finding the next tag, not for hiding
  // the ones already in play.
  //
  // Which is also why "nothing matched" is its own flag rather than an empty
  // list: with a tag or two still pinned there is a row on screen, and without
  // the note a word that matched nothing would look like a word that did.
  const { shown, noMatch } = useMemo(() => {
    if (!query) return { shown: vocabulary, noMatch: false }
    const needle = query.toLowerCase()
    const matches = (tag: MediaTag) => tag.name.toLowerCase().includes(needle)
    return {
      shown: vocabulary.filter((tag) => selected.includes(tag.name) || matches(tag)),
      noMatch: !vocabulary.some(matches),
    }
  }, [vocabulary, selected, query])

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
      <AppHeader>
        <Button variant="ghost" render={<Link to="/" />}>
          ← 戻る
        </Button>
      </AppHeader>

      {/* The header holds the field on a desktop, where it was the way in and
          has to stay put. A phone came here from an icon, so there is no
          illusion to keep and the field can sit where there is room for it. */}
      {isMobile && <TagSearchField variant="input" />}

      {selected.length > 1 && (
        <p className="text-sm text-muted-foreground">
          選んだタグのいずれかが付いた写真を表示します。
        </p>
      )}

      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

      {vocabularyLoading ? (
        <TagChipsSkeleton />
      ) : vocabulary.length === 0 ? (
        <p className="text-sm text-muted-foreground">まだタグがありません。</p>
      ) : (
        <div className="flex flex-col gap-2">
          {noMatch && (
            <p className="text-sm text-muted-foreground">
              「{query}」に一致するタグはありません。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {shown.map((tag) => {
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
        </div>
      )}

      {selected.length === 0 ? (
        <p className="text-sm text-muted-foreground">タグを選ぶと写真が絞り込まれます。</p>
      ) : showSkeleton ? (
        <MediaGridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">該当する写真がありません。</p>
      ) : (
        <>
          {/* Held rather than torn down while the next search runs. Narrowing
              by a second tag used to replace the whole grid with a skeleton
              and build it again, which flickered once per press. Dimmed so the
              wait is visible, and left unclickable meanwhile: these are the
              results of the previous search, and opening one would hand the
              viewer a photo the arrows are no longer stepping through. */}
          <div
            aria-busy={stale}
            className={`grid grid-cols-3 gap-2 transition-opacity ${
              stale ? 'pointer-events-none opacity-60' : ''
            }`}
          >
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
            <div ref={sentinelRef} className="flex justify-center py-4">
              <Spinner className="text-muted-foreground" />
            </div>
          )}
        </>
      )}
    </div>
  )
}
