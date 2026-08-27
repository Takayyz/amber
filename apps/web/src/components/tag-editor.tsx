import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { MediaTag } from '@/lib/media-page'
import { attachTag, detachTag, fetchAllTags, MAX_TAGS_PER_ITEM } from '@/lib/tags'

// Enough to suggest without covering the photo behind the list.
const SUGGESTION_LIMIT = 6

const ATTACH_FAILURE: Record<'limit' | 'duplicate' | 'failed', string> = {
  limit: `タグは1件につき${MAX_TAGS_PER_ITEM}個までです。`,
  duplicate: 'そのタグはすでに付いています。',
  failed: 'タグを追加できませんでした。',
}

interface TagEditorProps {
  mediaItemId: string
  tags: MediaTag[]
  /** Handed the tags as they now stand, so the caller can keep its own copy. */
  onChange: (tags: MediaTag[]) => void
  onError: (message: string | null) => void
}

export function TagEditor({ mediaItemId, tags, onChange, onError }: TagEditorProps) {
  // The vocabulary is service-wide and small, so it is fetched once for the
  // life of the viewer rather than per photo.
  const [vocabulary, setVocabulary] = useState<MediaTag[]>([])
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetchAllTags()
      .then((all) => {
        if (!cancelled) setVocabulary(all)
      })
      // Autocomplete is a convenience: typing the name still works without it.
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  // Leaving one photo for another abandons whatever was half-typed.
  useEffect(() => {
    setDraft('')
    setOpen(false)
  }, [mediaItemId])

  const full = tags.length >= MAX_TAGS_PER_ITEM

  const suggestions = useMemo(() => {
    const query = draft.trim().toLowerCase()
    const attached = new Set(tags.map((tag) => tag.id))

    return vocabulary
      .filter((tag) => !attached.has(tag.id) && tag.name.toLowerCase().includes(query))
      .slice(0, SUGGESTION_LIMIT)
  }, [draft, vocabulary, tags])

  const add = async (rawName: string) => {
    const name = rawName.trim()
    if (!name || busy) return

    // The trigger says the same thing, but only after a round trip.
    if (full) {
      onError(ATTACH_FAILURE.limit)
      return
    }

    setBusy(true)
    onError(null)
    const result = await attachTag(mediaItemId, name, vocabulary)
    setBusy(false)

    if (!result.ok) {
      onError(ATTACH_FAILURE[result.reason])
      return
    }

    setDraft('')
    setOpen(false)
    onChange([...tags, result.tag])
    // A tag just created is not in the vocabulary the list was built from.
    setVocabulary((known) =>
      known.some((tag) => tag.id === result.tag.id) ? known : [...known, result.tag],
    )
  }

  const remove = async (tag: MediaTag) => {
    if (busy) return

    setBusy(true)
    onError(null)
    const removed = await detachTag(mediaItemId, tag.id)
    setBusy(false)

    if (!removed) {
      onError('タグを外せませんでした。')
      return
    }

    onChange(tags.filter((held) => held.id !== tag.id))
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void add(draft)
      return
    }
    if (event.key === 'Escape') {
      // Closing the suggestions is what Escape does while the input has focus;
      // the viewer's own Escape takes over once it doesn't.
      setOpen(false)
      event.currentTarget.blur()
    }
  }

  return (
    // Left-aligned to match the dates above it, which are a two-column list
    // and cannot be centred without their values going ragged.
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        // `bg-white/10` over the viewer's black lands on roughly #232323 --
        // too close to the backdrop for the pill to read as a shape, so a run
        // of tags looked like loose grey words. The inset ring draws the edge
        // the fill alone was not dark enough to imply.
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 rounded-full bg-white/15 py-1 pr-1 pl-3 text-sm text-neutral-100 ring-1 ring-white/10 ring-inset"
        >
          {tag.name}
          <button
            type="button"
            aria-label={`タグ「${tag.name}」を外す`}
            disabled={busy}
            onClick={() => void remove(tag)}
            className="rounded-full p-0.5 hover:bg-white/20 disabled:opacity-50"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}

      {!full && (
        <div className="relative">
          <input
            type="text"
            value={draft}
            disabled={busy}
            placeholder="タグを追加"
            aria-label="タグを追加"
            onChange={(event) => {
              setDraft(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            // A click on a suggestion blurs the input first, so closing has to
            // wait for that click to land.
            onBlur={() => window.setTimeout(() => setOpen(false), 0)}
            onKeyDown={handleKeyDown}
            // `placeholder:text-neutral-500` was the one thing here actually
            // under contrast (about 4.3:1 on the viewer's black, short of the
            // 4.5 AA asks for); neutral-400 clears it at roughly 7:1.
            className="w-32 rounded-full bg-white/15 px-3 py-1 text-sm text-neutral-100 ring-1 ring-white/10 ring-inset placeholder:text-neutral-400 focus:ring-2 focus:ring-white/50 focus:outline-none disabled:opacity-50"
          />

          {open && suggestions.length > 0 && (
            // Upwards: the footer sits at the bottom of the viewport.
            <ul className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-44 overflow-y-auto rounded-lg border border-white/10 bg-neutral-800 py-1 text-left shadow-lg">
              {suggestions.map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    // mousedown fires before the input's blur, so the click is
                    // not lost to the list being unmounted.
                    onMouseDown={(event) => {
                      event.preventDefault()
                      void add(tag.name)
                    }}
                    className="block w-full px-3 py-1.5 text-left text-sm text-neutral-100 hover:bg-white/10"
                  >
                    {tag.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Always on, which is also what answers "where did the input go?" once
          the photo has five. */}
      <span className={`text-sm tabular-nums ${full ? 'text-neutral-200' : 'text-neutral-400'}`}>
        {tags.length}/{MAX_TAGS_PER_ITEM}
      </span>
    </div>
  )
}
