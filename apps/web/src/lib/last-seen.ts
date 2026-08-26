import { supabase } from '@/lib/supabase'

// Held for as long as the page lives rather than in component state: the
// album list unmounts whenever a member steps into an album, and re-reading
// on the way back would clear every badge the moment they returned. A reload
// starts a fresh visit, which is what makes the badges eventually go away.
//
// The promise itself is cached, not just its result, so two callers arriving
// in the same tick share one round trip instead of both writing the time back.
let visit: Promise<string | null> | undefined

async function beginVisit(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('members')
    .select('last_seen_at')
    .eq('id', userId)
    .maybeSingle()

  // A failed read means no reference point, which shows no badges. Guessing
  // one would either mark everything new or nothing.
  const seenBefore = error ? null : (data?.last_seen_at ?? null)

  // Not awaited -- the badges need only the value above -- but `then` still
  // has to be called: the query builder is lazy and issues nothing until it
  // is, so a bare `void` on it silently sends no request at all.
  supabase
    .from('members')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', userId)
    .then(
      () => {},
      // Failing costs one visit's worth of staleness and nothing else.
      () => {},
    )

  return seenBefore
}

/**
 * When this member was last seen, from before this visit marked them present.
 *
 * Null on a first visit -- everything is new then, so marking any of it says
 * nothing (README "New since last visit").
 */
export function visitReference(userId: string): Promise<string | null> {
  visit ??= beginVisit(userId)
  return visit
}

/** Whether `timestamp` falls after the reference point for this visit. */
export function isSince(timestamp: string, reference: string | null): boolean {
  if (reference === null) return false
  // Parsed rather than compared as strings: PostgREST renders an offset, and
  // two timestamps written in different ones do not sort lexically.
  return Date.parse(timestamp) > Date.parse(reference)
}
