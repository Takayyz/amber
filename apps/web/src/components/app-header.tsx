import { useState, type ComponentType, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Check,
  ChevronDown,
  LogOut,
  MonitorSmartphone,
  Moon,
  Pencil,
  Search,
  Sun,
  Trash2,
  User,
  UserPlus,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { useTheme } from '@/lib/theme-context'
import { useMemberName } from '@/lib/member-name-context'
import type { Theme } from '@/lib/theme'
import { selfLabel } from '@/lib/member-name'
import { useIsMobile } from '@/hooks/use-mobile'
import { InviteDialog } from '@/components/invite-dialog'
import { ProfileDialog } from '@/components/profile-dialog'
import { TagSearchField } from '@/components/tag-search-field'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
  /** Drawn with a tick when true, for the rows that pick between options. */
  selected?: boolean
}

const THEMES: { value: Theme; icon: ComponentType<{ className?: string }>; label: string }[] = [
  { value: 'light', icon: Sun, label: 'ライト' },
  { value: 'dark', icon: Moon, label: 'ダーク' },
  { value: 'system', icon: MonitorSmartphone, label: '端末に合わせる' },
]

interface AppHeaderProps {
  /**
   * Sits at the left of the bar -- a way back, usually. Left out on the album
   * list, where the controls then take the whole row on their own rather than
   * a second line appearing under one that is mostly empty.
   */
  children?: ReactNode
}

/**
 * The name slot keeps its width whatever is in it.
 *
 * Sizing to the text would give the header a different layout per member, and
 * a different one again for the moment before the name is known -- and the
 * field beside it is supposed to hold still to the pixel, which is the whole
 * of what it buys. Wide enough for a given name; anything longer is in the
 * profile dialog, one press away.
 */
function MemberLabel({ name, known }: { name: string; known: boolean }) {
  return (
    <span className="w-20 truncate text-left">
      {known ? name : <Skeleton className="h-3.5 w-full" />}
    </span>
  )
}

/**
 * The controls that belong to no particular screen: searching, and everything
 * behind the member's own name.
 *
 * Each screen mounts its own, so anything it holds is gone by the next one.
 * The name is therefore read at the provider rather than here: starting over
 * per screen meant rendering the email address until the row came back, and
 * that is both the wrong name and a wider one.
 */
export function AppHeader({ children }: AppHeaderProps) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  // The field is the same control on every screen; only here does it stop
  // being a way in and start being the thing itself.
  const searching = useLocation().pathname === '/search'
  const { theme, setTheme } = useTheme()

  const { displayName, known, setDisplayName } = useMemberName()
  const [profileOpen, setProfileOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const name = selfLabel(displayName, session?.user.email)

  // Grouped rather than flat: the gaps between groups are where the rules go,
  // and both the menu and the drawer draw them from the same shape.
  const groups: AccountAction[][] = [
    [{ icon: Pencil, label: '表示名を編集', run: () => setProfileOpen(true) }],
    THEMES.map(({ value, icon, label }) => ({
      icon,
      label,
      run: () => setTheme(value),
      selected: theme === value,
    })),
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
          {/* A phone has no room for a box between a back link and a name, so
              it keeps the icon it always had. The illusion the box buys is
              only worth anything where the box fits: a tap on an icon was
              never going to read as focusing a field. */}
          {!isMobile ? (
            <TagSearchField variant={searching ? 'input' : 'link'} />
          ) : (
            // Dropped once the search screen is the one showing: the field is
            // down in the body there, and an icon linking to where you already
            // are looks like a control and is not one.
            !searching && (
              <Button
                variant="outline"
                size="icon"
                aria-label="タグで探す"
                render={<Link to="/search" />}
              >
                <Search />
              </Button>
            )
          )}

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
              <MemberLabel name={name} known={known} />
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" className="min-w-0 gap-1">
                    <User className="text-muted-foreground" />
                    <MemberLabel name={name} known={known} />
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
                    {group.map(({ icon: Icon, label, run, destructive, selected }) => (
                      <DropdownMenuItem
                        key={label}
                        variant={destructive ? 'destructive' : 'default'}
                        onClick={run}
                      >
                        <Icon />
                        {label}
                        {/* Pushed to the far edge so the ticks line up in
                            their own column, whatever the labels measure. */}
                        {selected && <Check className="ml-auto" />}
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
              <MemberLabel name={name} known={known} />
            </DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {groups.map((group, index) => (
              <div key={group[0].label} className="flex flex-col">
                {index > 0 && <div aria-hidden className="my-1 h-px bg-border" />}
                {group.map(({ icon: Icon, label, run, destructive, selected }) => (
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
                    {selected && <Check className="ml-auto size-4 shrink-0" />}
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
