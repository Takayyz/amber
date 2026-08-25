import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { presignGet } from '@/lib/api'
import type { MediaItem } from '@/lib/media-page'

/**
 * One square in a grid, signed on demand. Videos show a placeholder rather
 * than a frame -- nothing generates thumbnails for them yet.
 */
export function MediaThumbnail({ item }: { item: MediaItem }) {
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
