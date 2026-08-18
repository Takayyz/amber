import { useEffect, useState, type FormEvent } from 'react'
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

  const handleSave = async (event: FormEvent) => {
    event.preventDefault()
    if (!userId) return

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
            <p className="text-sm text-muted-foreground">{session?.user.email}</p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
