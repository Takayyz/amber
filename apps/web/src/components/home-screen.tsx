import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { presignGet } from '@/lib/api'
import { isSince, visitReference } from '@/lib/last-seen'
import type { Database } from '@/lib/database.types'
import { AppHeader } from '@/components/app-header'
import { AlbumCardsSkeleton } from '@/components/loading-skeletons'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

type MediaItem = Database['public']['Tables']['media_items']['Row']

type Album = Database['public']['Tables']['albums']['Row'] & {
  cover: Pick<MediaItem, 'storage_key' | 'media_type' | 'deleted_at'> | null
}

function AlbumCover({ cover }: { cover: Album['cover'] }) {
  const [url, setUrl] = useState<string | null>(null)

  // A cover can outlive the photo it points at: soft-deleting an item only
  // flags the row, so the FK's `on delete set null` never fires and the album
  // keeps pointing at something nobody should see.
  const usable = cover !== null && cover.deleted_at === null && cover.media_type === 'photo'

  useEffect(() => {
    if (!usable) return
    let cancelled = false

    presignGet(cover.storage_key)
      .then((signed) => {
        if (!cancelled) setUrl(signed)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [usable, cover?.storage_key])

  if (!usable || !url) {
    return <div className="size-16 shrink-0 rounded-md bg-muted" />
  }
  return <img src={url} alt="" className="size-16 shrink-0 rounded-md object-cover" />
}

export function HomeScreen() {
  const { session } = useAuth()
  const [albums, setAlbums] = useState<Album[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  // Null until the reference point arrives, and null again for a member whose
  // first visit this is -- both mean no badges.
  const [seenBefore, setSeenBefore] = useState<string | null>(null)

  const fetchAlbums = async () => {
    const { data } = await supabase
      .from('albums')
      // The cover is embedded through the FK column rather than the reverse
      // album_id relationship, which points the same two tables the other
      // way; without the constraint name PostgREST cannot tell them apart.
      .select('*, cover:media_items!albums_cover_media_item_id_fkey(storage_key, media_type, deleted_at)')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
    setAlbums(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetchAlbums()
  }, [])

  useEffect(() => {
    if (!session) return
    let cancelled = false

    visitReference(session.user.id)
      .then((reference) => {
        if (!cancelled) setSeenBefore(reference)
      })
      // Badges are a convenience; the list itself is unaffected.
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [session])

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!session) return
    setCreating(true)

    await supabase.from('albums').insert({
      name,
      description: description || null,
      uploaded_by: session.user.id,
    })

    setCreating(false)
    setDialogOpen(false)
    setName('')
    setDescription('')
    await fetchAlbums()
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      <AppHeader />

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">アルバム</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button>新規アルバム</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新規アルバム</DialogTitle>
              <DialogDescription>アルバム名を入力してください。</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="album-name">アルバム名</Label>
                <Input
                  id="album-name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={creating}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="album-description">説明（任意）</Label>
                <Textarea
                  id="album-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={creating}
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={creating}>
                  {creating && <Spinner />}
                  {creating ? '作成中…' : '作成'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <AlbumCardsSkeleton />
      ) : albums.length === 0 ? (
        <p className="text-sm text-muted-foreground">まだアルバムがありません。</p>
      ) : (
        <div className="flex flex-col gap-3">
          {albums.map((album) => (
            <Link key={album.id} to={`/albums/${album.id}`} className="block">
              <Card>
                <CardHeader className="flex flex-row items-center gap-3">
                  <AlbumCover cover={album.cover} />
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2">
                      <span className="truncate">{album.name}</span>
                      {isSince(album.updated_at, seenBefore) && (
                        <span className="size-2 shrink-0 rounded-full bg-primary">
                          <span className="sr-only">新着あり</span>
                        </span>
                      )}
                    </CardTitle>
                    {album.description && <CardDescription>{album.description}</CardDescription>}
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
