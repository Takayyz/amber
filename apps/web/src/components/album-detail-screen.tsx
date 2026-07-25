import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/lib/database.types'
import { Button } from '@/components/ui/button'

type Album = Database['public']['Tables']['albums']['Row']

export function AlbumDetailScreen() {
  const { albumId } = useParams<{ albumId: string }>()
  const [album, setAlbum] = useState<Album | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!albumId) return

    setLoading(true)
    supabase
      .from('albums')
      .select('*')
      .eq('id', albumId)
      .is('deleted_at', null)
      .maybeSingle()
      .then(({ data }) => {
        setAlbum(data)
        setLoading(false)
      })
  }, [albumId])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      <Button variant="outline" className="self-start" render={<Link to="/" />}>
        ← アルバム一覧に戻る
      </Button>

      {loading ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : !album ? (
        <p className="text-sm text-muted-foreground">アルバムが見つかりません。</p>
      ) : (
        <>
          <div>
            <h1 className="text-lg font-medium">{album.name}</h1>
            {album.description && (
              <p className="text-sm text-muted-foreground">{album.description}</p>
            )}
          </div>
          <p className="text-sm text-muted-foreground">まだ写真がありません。</p>
        </>
      )}
    </div>
  )
}
