import { Search } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Input } from '@/components/ui/input'

/** The filter text, parked in the URL beside the tags it narrows. */
export const QUERY_PARAM = 'q'

const PLACEHOLDER = 'タグで探す'

/**
 * The two faces of this field have to be the same size to the pixel: stepping
 * onto the search screen is meant to read as focusing the box that was already
 * there, and a box that shifts even slightly reads as a new screen instead. So
 * the shell is written once and worn by both. `Input` carries most of it
 * already, but the button has no component to inherit from, and passing the
 * same values to both is what stops an upstream `shadcn add` from moving one
 * and not the other.
 */
const FIELD_SHELL = 'h-8 w-48 rounded-lg border border-input px-2.5 dark:bg-input/30'

interface TagSearchFieldProps {
  /**
   * `link` is the field as it appears everywhere else -- a control that looks
   * like a box and goes to the search screen. `input` is the real thing.
   */
  variant: 'link' | 'input'
}

export function TagSearchField({ variant }: TagSearchFieldProps) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  if (variant === 'link') {
    return (
      <button
        type="button"
        aria-label={PLACEHOLDER}
        onClick={() => navigate('/search')}
        // `cursor-text` rather than the pointer a button would normally take:
        // the cursor is the first thing that answers what this is.
        //
        // Hover fills the background and leaves the border alone, which is
        // what every other control here does -- the outline button beside it
        // included. A border that changed on hover was the one thing in the
        // app doing that, and with `--ring` now carrying the amber it lit up
        // rather than merely differing.
        className={`${FIELD_SHELL} flex shrink-0 cursor-text items-center gap-2 bg-transparent text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-input/50`}
      >
        <Search className="size-4 shrink-0" />
        {PLACEHOLDER}
      </button>
    )
  }

  const query = searchParams.get(QUERY_PARAM) ?? ''

  const setQuery = (next: string) => {
    const params = new URLSearchParams(searchParams)
    if (next) params.set(QUERY_PARAM, next)
    else params.delete(QUERY_PARAM)
    // Replace, like the tag selection beside it: narrowing a search should not
    // cost a Back press per keystroke.
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="relative shrink-0">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        // Focused on arrival, which is the whole point: the member pressed a
        // box, so a box is what should be waiting for them.
        autoFocus
        value={query}
        aria-label={PLACEHOLDER}
        placeholder={PLACEHOLDER}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          // Two stages, as in the tag editor: Escape clears what was typed,
          // and only leaves once there is nothing left to clear.
          if (query) setQuery('')
          else navigate('/')
        }}
        className={`${FIELD_SHELL} pl-8`}
      />
    </div>
  )
}
