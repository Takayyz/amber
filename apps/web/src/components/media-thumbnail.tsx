import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { presignGet } from '@/lib/api'
import type { MediaItem } from '@/lib/media-page'

// Only the three columns it draws from, so the trash -- which reads rows of
// its own shape -- can hand one over without being given the whole listing
// type it never fetches.
type Thumbnailed = Pick<MediaItem, 'media_type' | 'storage_key' | 'thumbnail_key'>

/**
 * One square in a grid, signed on demand.
 *
 * A photo shows itself; a video shows the frame taken from it at upload time.
 * An empty `thumbnail_key` means no frame could be decoded in whatever browser
 * did the uploading (README "Video previews"), so the placeholder stands in.
 */
export function MediaThumbnail({ item }: { item: Thumbnailed }) {
  const [url, setUrl] = useState<string | null>(null)

  const key = item.media_type === 'photo' ? item.storage_key : item.thumbnail_key

  useEffect(() => {
    if (!key) return
    let cancelled = false

    presignGet(key)
      .then((signedUrl) => {
        if (!cancelled) setUrl(signedUrl)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [key])

  if (!key) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-md bg-muted">
        <Play className="size-6 text-muted-foreground" />
      </div>
    )
  }

  if (!url) {
    return <div className="aspect-square animate-pulse rounded-md bg-muted" />
  }

  return (
    <div className="relative">
      <img src={url} alt="" className="aspect-square w-full rounded-md object-cover" />
      {item.media_type === 'video' && (
        // Marks the still as a video without hiding it: a small icon over the
        // middle rather than the full-cell placeholder it replaced.
        <div className="absolute inset-0 flex items-center justify-center">
          <Play className="size-8 fill-white/90 text-white/90 drop-shadow-md" />
        </div>
      )}
    </div>
  )
}
