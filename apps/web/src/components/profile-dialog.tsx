import { useEffect, useState, type FormEvent } from 'react'
import { User } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { displayNameOrNull, selfLabel } from '@/lib/member-name'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

// Long enough for a name, short enough that it cannot push the album header
// around. The column itself is unbounded text, so this is the only limit.
const DISPLAY_NAME_MAX_LENGTH = 40

export function ProfileDialog() {
  const { session } = useAuth()
  const userId = session?.user.id

  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    supabase
      .from('members')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setDisplayName(data?.display_name ?? null)
      })

    return () => {
      cancelled = true
    }
  }, [userId])

  // The field starts from what is saved each time it opens, so a cancelled
  // edit does not linger into the next one.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(displayName ?? '')
      setError(null)
    }
    setOpen(next)
  }

  // Clearing a name that is already set would rename the member on every photo
  // they have ever uploaded, since the footer reads display_name live rather
  // than from a copy taken at upload time. Changing it is fine -- the same
  // person is called something else -- but emptying it turns every one of
  // those photos into "unnamed". A member who has never set one is unaffected.
  const clearsExistingName = displayName !== null && draft.trim() === ''

  const handleSave = async (event: FormEvent) => {
    event.preventDefault()
    if (!userId || clearsExistingName) return

    setSaving(true)
    setError(null)

    // Stored as null rather than an empty string: "unset" has to be one state,
    // or the footer would have to test for both to know a member is unnamed.
    const normalized = displayNameOrNull(draft)
    const { error: updateError } = await supabase
      .from('members')
      .update({ display_name: normalized })
      .eq('id', userId)

    setSaving(false)
    if (updateError) {
      setError('表示名を保存できませんでした。時間をおいて試してください。')
      return
    }

    setDisplayName(normalized)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="truncate rounded-md px-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {selfLabel(displayName, session?.user.email)}
          </button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>表示名編集</DialogTitle>
          <DialogDescription>写真の投稿者として表示されます。</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="display-name">表示名</Label>
            <Input
              id="display-name"
              value={draft}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
              disabled={saving}
            />
            {clearsExistingName && (
              <p className="text-xs text-destructive">表示名は1文字以上入力してください。</p>
            )}
          </div>

          {/* The only address this dialog could be showing is the reader's
              own, so the icon carries it -- the wording is left for screen
              readers, which get nothing from an icon. */}
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <User className="size-4 shrink-0" aria-hidden />
            <span className="sr-only">ログイン中のアカウント</span>
            <span className="truncate">{session?.user.email}</span>
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={saving || clearsExistingName}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
