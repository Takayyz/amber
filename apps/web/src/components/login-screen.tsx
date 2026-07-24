import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'

type Status = 'idle' | 'sending' | 'sent' | 'error'

export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setStatus('sending')

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    })

    setStatus(error ? 'error' : 'sent')
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Amber</CardTitle>
          <CardDescription>ログイン用のリンクをメールで送ります</CardDescription>
        </CardHeader>
        <CardContent>
          {status === 'sent' ? (
            <p className="text-sm text-muted-foreground">
              メールを確認してください。届いたリンクからログインできます。
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">メールアドレス</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={status === 'sending'}
                />
              </div>
              {status === 'error' && (
                <p className="text-sm text-destructive">
                  送信できませんでした。招待されたメールアドレスかご確認ください。
                </p>
              )}
              <Button type="submit" disabled={status === 'sending'}>
                {status === 'sending' ? '送信中…' : 'ログインリンクを送る'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
