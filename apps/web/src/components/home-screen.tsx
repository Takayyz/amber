import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import type { Database } from '@/lib/database.types'
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

type Album = Database['public']['Tables']['albums']['Row']

export function HomeScreen() {
  const { session } = useAuth()
  const [albums, setAlbums] = useState<Album[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const fetchAlbums = async () => {
    const { data } = await supabase
      .from('albums')
      .select('*')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
    setAlbums(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    fetchAlbums()
  }, [])

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
      <header className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{session?.user.email}</p>
        <Button variant="outline" onClick={() => supabase.auth.signOut()}>
          ログアウト
        </Button>
      </header>

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
                  {creating ? '作成中…' : '作成'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : albums.length === 0 ? (
        <p className="text-sm text-muted-foreground">まだアルバムがありません。</p>
      ) : (
        <div className="flex flex-col gap-3">
          {albums.map((album) => (
            <Card key={album.id}>
              <CardHeader>
                <CardTitle>{album.name}</CardTitle>
                {album.description && <CardDescription>{album.description}</CardDescription>}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
