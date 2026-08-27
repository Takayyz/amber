import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardHeader } from '@/components/ui/card'

// Enough rows to reach past the fold on a phone without filling a desktop
// screen with placeholders for content that may turn out to be one album.
const CARD_COUNT = 3
// One screen's worth on a phone at three columns.
const TILE_COUNT = 9

/**
 * Stands in for the album list and the trash while they load.
 *
 * Shaped like the cards that will replace it -- a square cover beside two
 * lines of text -- so the layout does not jump when the real rows arrive.
 */
export function AlbumCardsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {Array.from({ length: CARD_COUNT }, (_, index) => (
        <Card key={index}>
          <CardHeader className="flex flex-row items-center gap-3">
            <Skeleton className="size-16 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

// A handful of varied widths, so the row reads as words rather than a bar.
const TAG_WIDTHS = ['w-14', 'w-20', 'w-16', 'w-24', 'w-12']

/**
 * Stands in for the tag row on the search screen.
 *
 * It exists because the alternative -- an empty row until the tags arrive --
 * had the screen claim there were no tags at all, which is the one flicker
 * that gives away that a screen was swapped rather than a box focused.
 */
export function TagChipsSkeleton() {
  return (
    <div className="flex flex-wrap gap-2" aria-hidden>
      {TAG_WIDTHS.map((width, index) => (
        // `h-6` is what a chip measures: `text-xs` puts the line box at 16px
        // and `py-1` adds 4px either side. Guessing instead would move the
        // results down by a few pixels the moment the real tags arrived.
        <Skeleton key={index} className={`h-6 rounded-full ${width}`} />
      ))}
    </div>
  )
}

/** Stands in for a grid of photos, at the same three columns they land in. */
export function MediaGridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-2" aria-hidden>
      {Array.from({ length: TILE_COUNT }, (_, index) => (
        <Skeleton key={index} className="aspect-square" />
      ))}
    </div>
  )
}
