import { supabase } from '@/lib/supabase'
import type { MediaTag } from '@/lib/media-page'

/**
 * README "Tags": five per photo or video. The database trigger enforces the
 * same number -- this is the copy the input checks against, so the member is
 * stopped before a request goes out rather than by an exception coming back.
 */
export const MAX_TAGS_PER_ITEM = 5

// A trigger's `raise exception` reports P0001, which is how the 5-tag cap
// arrives here. A duplicate row on the join table's primary key is 23505.
// Status alone can't tell the two apart, the same way it couldn't for
// invitations (see `isUniqueViolation` in apps/api).
const RAISED_EXCEPTION = 'P0001'
const UNIQUE_VIOLATION = '23505'

// A tag_id pointing at a row that is no longer there. Reachable because this
// session's vocabulary is a copy: another member can have taken the last photo
// off a tag, and pruned it, since this copy was read.
const FOREIGN_KEY_VIOLATION = '23503'

/**
 * The service-wide vocabulary, for autocomplete.
 *
 * Sweeps the tags nothing points at on the way past. Reading the list is the
 * moment it matters that the list is right, and it is the only moment that
 * catches every way one is left behind -- `attachTag` refused at its second
 * step, or a detach in a tab this session never heard about.
 */
export async function fetchAllTags(): Promise<MediaTag[]> {
  // Before the read, so what comes back is already swept. Failing is not worth
  // reporting: the vocabulary is still usable with a stale entry in it, and
  // the next reader tries again.
  await supabase.rpc('prune_unused_tags')

  const { data, error } = await supabase.from('tags').select('id, name').order('name')

  if (error) throw error
  return data ?? []
}

/**
 * The tag that `name` refers to, creating it if the service has never seen it.
 *
 * Upsert rather than select-then-insert: `tags.name` is unique service-wide,
 * so two members naming the same tag at once race, and `on conflict do update`
 * hands back the row the other one won with instead of failing.
 */
async function resolveTag(name: string, vocabulary: MediaTag[]): Promise<MediaTag | null> {
  // Reuse "BBQ" when someone types "bbq". `tags.name` is a plain unique index
  // rather than a `lower(name)` one, so this is the only thing keeping the two
  // from sitting beside each other.
  const known = vocabulary.find((tag) => tag.name.toLowerCase() === name.toLowerCase())
  if (known) return known

  const { data, error } = await supabase
    .from('tags')
    .upsert({ name }, { onConflict: 'name' })
    .select('id, name')
    .single()

  if (error) return null
  return data
}

/** The join row, on its own so the retry below is the same call twice. */
async function link(mediaItemId: string, tagId: string) {
  return supabase.from('media_item_tags').insert({ media_item_id: mediaItemId, tag_id: tagId })
}

export type AttachTagResult =
  | { ok: true; tag: MediaTag }
  | { ok: false; reason: 'limit' | 'duplicate' | 'failed' }

export async function attachTag(
  mediaItemId: string,
  rawName: string,
  vocabulary: MediaTag[],
): Promise<AttachTagResult> {
  const name = rawName.trim()
  if (!name) return { ok: false, reason: 'failed' }

  let tag = await resolveTag(name, vocabulary)
  if (!tag) return { ok: false, reason: 'failed' }

  let { error } = await link(mediaItemId, tag.id)

  // The id came out of a vocabulary read earlier, and the tag it named has
  // been pruned since. Ask for the name again -- the upsert either finds
  // whoever recreated it or creates it -- and try the one time.
  if (error?.code === FOREIGN_KEY_VIOLATION) {
    tag = await resolveTag(name, [])
    if (!tag) return { ok: false, reason: 'failed' }
    ;({ error } = await link(mediaItemId, tag.id))
  }

  if (error) {
    // `resolveTag` may have just created this tag, and the link it was created
    // for is not going to happen. Leaving it would put a tag matching nothing
    // into everyone's autocomplete -- which is how most of them got there.
    await supabase.rpc('prune_tag_if_unused', { target_tag_id: tag.id })

    // Both are reachable with the input guard in place: another tab can have
    // added a tag since this one loaded the photo.
    if (error.code === RAISED_EXCEPTION) return { ok: false, reason: 'limit' }
    if (error.code === UNIQUE_VIOLATION) return { ok: false, reason: 'duplicate' }
    return { ok: false, reason: 'failed' }
  }

  return { ok: true, tag }
}

/**
 * Unlinks the tag from the photo, and takes the tag itself with it if that was
 * the last photo carrying it.
 *
 * The second half goes through `prune_tag_if_unused` rather than a delete from
 * here. Checking and deleting as two requests leaves a gap another member can
 * attach the same tag inside, and `on delete cascade` would then take their
 * new row along with the tag -- silently. The function holds a lock across
 * both halves so that cannot happen (see the migration).
 */
export async function detachTag(mediaItemId: string, tagId: string): Promise<boolean> {
  const { error } = await supabase
    .from('media_item_tags')
    .delete()
    .eq('media_item_id', mediaItemId)
    .eq('tag_id', tagId)

  if (error) return false

  // Best-effort, and deliberately not part of what this reports: the tag came
  // off the photo, which is what was asked for. A tag left in the vocabulary
  // is tidied by the next read of it.
  await supabase.rpc('prune_tag_if_unused', { target_tag_id: tagId })

  return true
}
