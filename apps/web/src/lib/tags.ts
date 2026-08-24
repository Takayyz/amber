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

/** The service-wide vocabulary, for autocomplete. */
export async function fetchAllTags(): Promise<MediaTag[]> {
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

  const tag = await resolveTag(name, vocabulary)
  if (!tag) return { ok: false, reason: 'failed' }

  const { error } = await supabase
    .from('media_item_tags')
    .insert({ media_item_id: mediaItemId, tag_id: tag.id })

  if (error) {
    // Both are reachable with the input guard in place: another tab can have
    // added a tag since this one loaded the photo.
    if (error.code === RAISED_EXCEPTION) return { ok: false, reason: 'limit' }
    if (error.code === UNIQUE_VIOLATION) return { ok: false, reason: 'duplicate' }
    return { ok: false, reason: 'failed' }
  }

  return { ok: true, tag }
}

/**
 * Unlinks the tag from the photo. The tag itself is left in the vocabulary
 * even when nothing points at it any more -- removing it would race with
 * another member typing that same name at that same moment.
 */
export async function detachTag(mediaItemId: string, tagId: string): Promise<boolean> {
  const { error } = await supabase
    .from('media_item_tags')
    .delete()
    .eq('media_item_id', mediaItemId)
    .eq('tag_id', tagId)

  return !error
}
