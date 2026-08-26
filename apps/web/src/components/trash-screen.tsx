import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RotateCcw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/lib/database.types'
import { Button } from '@/components/ui/button'
import { MediaThumbnail } from '@/components/media-thumbnail'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

type Album = Database['public']['Tables']['albums']['Row']
type MediaItem = Database['public']['Tables']['media_items']['Row'] & {
  album: Pick<Album, 'id' | 'name' | 'deleted_at'> | null
}

type ListState = 'loading' | 'ready' | 'failed'

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function TrashScreen() {
  const [albums, setAlbums] = useState<Album[]>([])
  const [items, setItems] = useState<MediaItem[]>([])
  const [state, setState] = useState<ListState>('loading')
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchTrash = async () => {
    setState('loading')

    try {
      const [albumResult, itemResult] = await Promise.all([
        supabase
          .from('albums')
          .select('*')
          .not('deleted_at', 'is', null)
          .order('deleted_at', { ascending: false }),
        // Items deleted on their own, and only while their album is still
        // live. Visibility is the compound album-and-item condition, so
        // restoring an item inside a trashed album would clear its flag and
        // change nothing anyone can see -- restoring the album is what brings
        // those back, and it does so on its own.
        supabase
          .from('media_items')
          .select('*, album:albums!media_items_album_id_fkey!inner(id, name, deleted_at)')
          .not('deleted_at', 'is', null)
          .is('album.deleted_at', null)
          .order('deleted_at', { ascending: false }),
      ])

      if (albumResult.error || itemResult.error) {
        setState('failed')
        return
      }

      setAlbums(albumResult.data ?? [])
      setItems(itemResult.data ?? [])
      setState('ready')
    } catch {
      setState('failed')
    }
  }

  useEffect(() => {
    fetchTrash()
  }, [])

  const restore = async (table: 'albums' | 'media_items', id: string) => {
    setRestoringId(id)
    setError(null)

    const { error: restoreError } = await supabase
      .from(table)
      .update({ deleted_at: null })
      .eq('id', id)

    setRestoringId(null)
    if (restoreError) {
      setError('復元できませんでした。')
      return
    }
    await fetchTrash()
  }

  const formatDeletedAt = (deletedAt: string | null) =>
    deletedAt ? `${dateFormatter.format(new Date(deletedAt))} に削除` : ''

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      <Button variant="outline" className="self-start" render={<Link to="/" />}>
        ← アルバム一覧に戻る
      </Button>

      <h1 className="text-lg font-medium">ゴミ箱</h1>
      <p className="text-sm text-muted-foreground">
        削除したものはここに残ります。復元すると元のアルバムに戻ります。
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {state === 'loading' ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : state === 'failed' ? (
        <p className="text-sm text-destructive">
          ゴミ箱を読み込めませんでした。開き直してください。
        </p>
      ) : albums.length === 0 && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">ゴミ箱は空です。</p>
      ) : (
        <>
          {albums.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">アルバム</h2>
              {albums.map((album) => (
                <Card key={album.id}>
                  <CardHeader className="flex flex-row items-center justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle>{album.name}</CardTitle>
                      <CardDescription>{formatDeletedAt(album.deleted_at)}</CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restoringId === album.id}
                      onClick={() => restore('albums', album.id)}
                    >
                      <RotateCcw />
                      復元
                    </Button>
                  </CardHeader>
                </Card>
              ))}
            </section>
          )}

          {items.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">写真・動画</h2>
              {items.map((item) => (
                <Card key={item.id}>
                  <CardHeader className="flex flex-row items-center justify-between gap-3">
                    {/* The album name alone cannot answer "which one was
                        that", which is the question the trash gets asked. */}
                    <div className="w-16 shrink-0">
                      <MediaThumbnail item={item} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate text-sm">
                        {item.album?.name ?? '(アルバムなし)'}
                      </CardTitle>
                      <CardDescription>
                        {item.media_type === 'video' ? '動画' : '写真'}・
                        {formatDeletedAt(item.deleted_at)}
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restoringId === item.id}
                      onClick={() => restore('media_items', item.id)}
                    >
                      <RotateCcw />
                      復元
                    </Button>
                  </CardHeader>
                </Card>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
