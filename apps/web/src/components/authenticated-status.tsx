import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'

export function AuthenticatedStatus() {
  const { session } = useAuth()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-4">
      <p className="text-sm text-muted-foreground">
        ログイン中: {session?.user.email}
      </p>
      <Button variant="outline" onClick={() => supabase.auth.signOut()}>
        ログアウト
      </Button>
    </div>
  )
}
