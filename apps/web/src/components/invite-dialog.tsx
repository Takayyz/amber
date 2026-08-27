import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Send, X } from 'lucide-react'
import type { InvitationErrorCode } from '@amber/shared'
import { supabase } from '@/lib/supabase'
import { InvitationError, cancelInvitation, resendInvitation, sendInvitation } from '@/lib/api'
import type { Database } from '@/lib/database.types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Invitation = Database['public']['Tables']['invitations']['Row']

type ListState = 'loading' | 'ready' | 'failed'

const ERROR_MESSAGES: Record<InvitationErrorCode, string> = {
  invalid_email: 'メールアドレスの形式が正しくありません。',
  already_member: 'このアドレスはすでにメンバーです。',
  already_invited: 'このアドレスにはすでに招待を送っています。',
  not_pending: 'この招待はすでに取り消されたか、承諾済みです。',
  rate_limited: '1時間あたりのメール送信数が上限に達しました。1時間ほどおいて試してください。',
  resend_too_soon: '送信したばかりです。1分ほどおいてから再送してください。',
  invite_failed: '招待を処理できませんでした。時間をおいて試してください。',
}

function messageFor(error: unknown): string {
  return error instanceof InvitationError
    ? ERROR_MESSAGES[error.code]
    : ERROR_MESSAGES.invite_failed
}

interface InviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Opened from the account menu, which has to close before this appears, so
 * the open state is held by the header rather than by a trigger in here.
 */
export function InviteDialog({ open, onOpenChange: setOpen }: InviteDialogProps) {
  const [pending, setPending] = useState<Invitation[]>([])
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [resentId, setResentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Kept apart from `error`, which belongs to whatever the member just tried
  // to do -- a failed refresh must not overwrite the reason their cancel or
  // send failed.
  const [listState, setListState] = useState<ListState>('loading')

  const fetchPending = useCallback(async () => {
    setListState('loading')
    // Reopening the dialog, or any send/cancel that refreshes the list,
    // retires the "sent" note -- it belongs to one click, not to the row.
    setResentId(null)

    // Two different failure shapes: the client returns query errors in
    // `error`, but a fetch that never completes throws instead. Missing
    // either one leaves this stuck on "loading" or, worse, reports an empty
    // list -- and a member acting on "nothing outstanding" would either
    // think an invitation was cancelled or send it a second time.
    try {
      const { data, error: fetchError } = await supabase
        .from('invitations')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })

      if (fetchError || !data) {
        setListState('failed')
        return
      }

      setPending(data)
      setListState('ready')
    } catch {
      setListState('failed')
    }
  }, [])

  useEffect(() => {
    if (open) fetchPending()
  }, [open, fetchPending])

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSending(true)
    setError(null)

    try {
      await sendInvitation(email)
      setEmail('')
      await fetchPending()
    } catch (sendError: unknown) {
      setError(messageFor(sendError))
    } finally {
      setSending(false)
    }
  }

  const handleResend = async (invitationId: string) => {
    setResendingId(invitationId)
    setError(null)
    setResentId(null)

    try {
      await resendInvitation(invitationId)
      // Nothing about the row changes on a re-send, so this is the only
      // signal that the click did anything.
      setResentId(invitationId)
    } catch (resendError: unknown) {
      setError(messageFor(resendError))
      // The usual reason for failing is that the invitation stopped being
      // pending -- somebody else cancelled it, or the recipient accepted.
      // Leaving the row on screen would let the member keep re-sending
      // something that is no longer there.
      await fetchPending()
    } finally {
      setResendingId(null)
    }
  }

  const handleCancel = async (invitationId: string) => {
    setCancellingId(invitationId)
    setError(null)

    try {
      await cancelInvitation(invitationId)
    } catch (cancelError: unknown) {
      setError(messageFor(cancelError))
    } finally {
      setCancellingId(null)
      await fetchPending()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>メンバーを招待</DialogTitle>
          <DialogDescription>
            招待した人はすべてのアルバムを見られるようになります。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSend} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-email">メールアドレス</Label>
            <div className="flex gap-2">
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={sending}
              />
              {/* The mark's second colour, spent where the mark means it: the
                  gaps in the enclosure are where someone new is let in.
                  Merged over the default variant rather than added to
                  `ui/button.tsx`, which `shadcn add` overwrites. */}
              <Button
                type="submit"
                disabled={sending}
                className="bg-invite/10 text-[color-mix(in_oklab,var(--invite),var(--foreground)_30%)] hover:bg-invite/20 dark:bg-invite/20 dark:hover:bg-invite/30"
              >
                {sending && <Spinner />}
                {sending ? '送信中…' : '送信'}
              </Button>
            </div>
          </div>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">招待中</p>
          {listState === 'loading' ? (
            <div className="flex justify-center py-2">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : listState === 'failed' ? (
            <p className="text-sm text-destructive">
              招待中の一覧を取得できませんでした。開き直してください。
            </p>
          ) : pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだ届いていない招待はありません。</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {pending.map((invitation) => (
                <li key={invitation.id} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    {/* Same colour as the button that sent it, so a row here
                        reads as the invitation that action put in flight. */}
                    <span className="size-1.5 shrink-0 rounded-full bg-invite" aria-hidden />
                    <span className="truncate text-sm">{invitation.email}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {resentId === invitation.id && (
                      <span className="text-xs text-muted-foreground">送信しました</span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${invitation.email} に招待を再送する`}
                      disabled={resendingId === invitation.id}
                      onClick={() => handleResend(invitation.id)}
                    >
                      <Send />
                      再送
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${invitation.email} の招待を取り消す`}
                      disabled={cancellingId === invitation.id}
                      onClick={() => handleCancel(invitation.id)}
                    >
                      <X />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
