import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronDown, LogOut, Pencil, Search, Trash2, User, UserPlus } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { displayNameOrNull, selfLabel } from '@/lib/member-name'
import { useIsMobile } from '@/hooks/use-mobile'
import { InviteDialog } from '@/components/invite-dialog'
import { ProfileDialog } from '@/components/profile-dialog'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface AccountAction {
  icon: ComponentType<{ className?: string }>
  label: string
  run: () => void
  destructive?: boolean
}

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
  const isMobile = useIsMobile()

  const [displayName, setDisplayName] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

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

  const name = selfLabel(displayName, session?.user.email)

  // Grouped rather than flat: the gaps between groups are where the rules go,
  // and both the menu and the drawer draw them from the same shape.
  const groups: AccountAction[][] = [
    [{ icon: Pencil, label: '表示名を編集', run: () => setProfileOpen(true) }],
    [
      { icon: Trash2, label: 'ゴミ箱', run: () => navigate('/trash') },
      { icon: UserPlus, label: 'メンバーを招待', run: () => setInviteOpen(true) },
    ],
    [
      {
        icon: LogOut,
        label: 'ログアウト',
        run: () => void supabase.auth.signOut(),
        destructive: true,
      },
    ],
  ]

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

          {/* A dropdown wants a pointer near the thing it hangs off; a thumb
              reaching the top of a phone does not have one. Same actions, put
              where the hand already is. */}
          {isMobile ? (
            <Button
              variant="outline"
              className="min-w-0 gap-1"
              onClick={() => setDrawerOpen(true)}
            >
              <User className="text-muted-foreground" />
              <span className="truncate">{name}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" className="min-w-0 gap-1">
                    <User className="text-muted-foreground" />
                    <span className="truncate">{name}</span>
                    {/* Small and dim: it says the name opens something, and is
                        not itself worth looking at. */}
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </Button>
                }
              />
              {/* Every row carries an icon, including the ones that would read
                  fine without: a column of them is what the eye follows, and a
                  gap in it puts one label out of line with the rest. */}
              <DropdownMenuContent align="end">
                {groups.map((group, index) => (
                  <div key={group[0].label}>
                    {index > 0 && <DropdownMenuSeparator />}
                    {group.map(({ icon: Icon, label, run, destructive }) => (
                      <DropdownMenuItem
                        key={label}
                        variant={destructive ? 'destructive' : 'default'}
                        onClick={run}
                      >
                        <Icon />
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} showSwipeHandle>
        <DrawerContent>
          <DrawerHeader>
            {/* The same icon the trigger carries, so what was pressed and what
                opened read as the same thing. */}
            <DrawerTitle className="flex items-center justify-center gap-2">
              <User className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
            </DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {groups.map((group, index) => (
              <div key={group[0].label} className="flex flex-col">
                {index > 0 && <div aria-hidden className="my-1 h-px bg-border" />}
                {group.map(({ icon: Icon, label, run, destructive }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      setDrawerOpen(false)
                      run()
                    }}
                    // Taller than the menu's rows: this one is aimed at a
                    // thumb rather than a cursor.
                    className={`flex items-center gap-3 rounded-md px-3 py-3 text-left text-sm active:bg-accent ${
                      destructive ? 'text-destructive' : ''
                    }`}
                  >
                    <Icon
                      className={destructive ? 'size-4 shrink-0' : 'size-4 shrink-0 text-muted-foreground'}
                    />
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

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
