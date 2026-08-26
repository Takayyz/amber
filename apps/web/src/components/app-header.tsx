import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronDown, LogOut, Pencil, Search, Trash2, User, UserPlus } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { displayNameOrNull, selfLabel } from '@/lib/member-name'
import { InviteDialog } from '@/components/invite-dialog'
import { ProfileDialog } from '@/components/profile-dialog'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'

interface AppHeaderProps {
  /**
   * Sits at the left of the bar -- a way back, usually. Left out on the album
   * list, where the controls then take the whole row on their own rather than
   * a second line appearing under one that is mostly empty.
   */
  children?: ReactNode
}

/**
 * The controls that belong to no particular screen: searching, and everything
 * behind the member's own name.
 *
 * Each screen mounts its own, so the name is read once per screen rather than
 * held somewhere global -- it changes rarely, and the alternative is a cache
 * that has to be told when the profile dialog saves.
 */
export function AppHeader({ children }: AppHeaderProps) {
  const { session } = useAuth()
  const navigate = useNavigate()

  const [displayName, setDisplayName] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)

  useEffect(() => {
    const userId = session?.user.id
    if (!userId) return
    let cancelled = false

    supabase
      .from('members')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setDisplayName(displayNameOrNull(data?.display_name))
      })

    return () => {
      cancelled = true
    }
  }, [session])

  return (
    <>
      {/* Searching is the one control here that is about the photos, so it
          stays out on its own. Everything else belongs to the account or to
          the service around it, and lives behind the name. */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">{children}</div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="タグで探す"
            render={<Link to="/search" />}
          >
            <Search />
          </Button>

          <Menu>
            <MenuTrigger
              render={
                <Button variant="outline" className="min-w-0 gap-1">
                  <User className="text-muted-foreground" />
                  <span className="truncate">{selfLabel(displayName, session?.user.email)}</span>
                  {/* Small and dim: it says the name opens something, and is
                      not itself worth looking at. */}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              }
            />
            {/* Every row carries an icon, including the ones that would read
                fine without: a column of them is what the eye follows, and a
                gap in it puts one label out of line with the rest. */}
            <MenuContent>
              <MenuItem onClick={() => setProfileOpen(true)}>
                <Pencil />
                表示名を編集
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                // The menu closes on its own, and navigating from inside the
                // click keeps that from racing with the route change.
                onClick={() => navigate('/trash')}
              >
                <Trash2 />
                ゴミ箱
              </MenuItem>
              <MenuItem onClick={() => setInviteOpen(true)}>
                <UserPlus />
                メンバーを招待
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => void supabase.auth.signOut()}>
                <LogOut />
                ログアウト
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>

      <ProfileDialog
        open={profileOpen}
        onOpenChange={setProfileOpen}
        displayName={displayName}
        onSaved={setDisplayName}
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  )
}
