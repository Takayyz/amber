import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '@/lib/supabase'
import { displayNameOrNull } from '@/lib/member-name'
import { useAuth } from '@/lib/auth-context'

interface MemberNameContextValue {
  /** Null once known to be unset, which is not the same as not yet known. */
  displayName: string | null
  /** False until the row has been read, so nothing has to guess in the meantime. */
  known: boolean
  /** Handed the name as saved, so the header does not re-read to see its own write. */
  setDisplayName: (displayName: string | null) => void
}

const MemberNameContext = createContext<MemberNameContextValue | null>(null)

/**
 * The member's own display name, read once for the session.
 *
 * It used to be read per screen, on the reasoning that a shared copy would need
 * invalidating when the profile dialog saved. That cost more than it saved: the
 * header remounts on every navigation, so each one started over with no name in
 * hand and rendered the email address in its place -- a wider string than most
 * names, which then shrank and pulled the search field along with it. The
 * invalidation it was avoiding turned out to already exist, the profile dialog
 * having always reported what it saved.
 */
export function MemberNameProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [known, setKnown] = useState(false)

  useEffect(() => {
    const userId = session?.user.id
    if (!userId) {
      // Signing out leaves nothing to know, and the next member has to read
      // their own row rather than inherit this one.
      setDisplayName(null)
      setKnown(false)
      return
    }

    let cancelled = false

    supabase
      .from('members')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setDisplayName(displayNameOrNull(data?.display_name))
        // Set even on a failed read: a header that waits forever is worse than
        // one that falls back, and the fallback is the address they signed in
        // with either way.
        setKnown(true)
      })

    return () => {
      cancelled = true
    }
  }, [session])

  return (
    <MemberNameContext.Provider value={{ displayName, known, setDisplayName }}>
      {children}
    </MemberNameContext.Provider>
  )
}

export function useMemberName(): MemberNameContextValue {
  const context = useContext(MemberNameContext)
  if (!context) throw new Error('useMemberName must be used within a MemberNameProvider')
  return context
}
