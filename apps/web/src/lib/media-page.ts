import { supabase } from '@/lib/supabase'
import type { Database } from '@/lib/database.types'

// The uploader and the tags ride along on every page so the detail footer can
// show them without a second round trip per photo.
const SELECT_WITH_UPLOADER =
  '*, uploader:members!media_items_uploaded_by_fkey(display_name), media_item_tags(tags(id, name))'

export interface MediaTag {
  id: string
  name: string
}

export type MediaItem = Database['public']['Tables']['media_items']['Row'] & {
  uploader: { display_name: string | null } | null
  // Going through the join table is what nests it twice; `tagsOf` is how
  // callers read it.
  media_item_tags: { tags: MediaTag | null }[]
}

/** The item's tags, flattened out of the join table and ordered by name. */
export function tagsOf(item: MediaItem): MediaTag[] {
  return (item.media_item_tags ?? [])
    .map((row) => row.tags)
    .filter((tag): tag is MediaTag => tag !== null)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}

/**
 * Where a listing left off. Both halves are needed: `sort_key` is
 * `coalesce(captured_at, uploaded_at)` and Exif capture time only has second
 * precision, so a burst of shots shares one. Paging on it alone either skips
 * the rest of a tied group (`gt`) or returns it forever (`gte`).
 */
export interface MediaCursor {
  sortKey: string
  id: string
}

export function cursorOf(item: MediaItem): MediaCursor {
  return { sortKey: item.sort_key ?? item.uploaded_at, id: item.id }
}

/**
 * `(sort_key, id) > cursor` written out for PostgREST, which has no row
 * comparison. The quotes matter: a timestamptz renders with a `+` offset.
 */
function afterCursor(cursor: MediaCursor): string {
  return `sort_key.gt."${cursor.sortKey}",and(sort_key.eq."${cursor.sortKey}",id.gt."${cursor.id}")`
}

function beforeCursor(cursor: MediaCursor): string {
  return `sort_key.lt."${cursor.sortKey}",and(sort_key.eq."${cursor.sortKey}",id.lt."${cursor.id}")`
}

function albumItems(albumId: string) {
  return supabase
    .from('media_items')
    .select(SELECT_WITH_UPLOADER)
    .eq('album_id', albumId)
    .is('deleted_at', null)
}

export interface MediaPage {
  items: MediaItem[]
  /** False once a page comes back short, which is the only end-of-list signal. */
  hasMore: boolean
}

/**
 * One page of an album, oldest first. Passing no cursor starts from the top.
 */
export async function fetchMediaPage(
  albumId: string,
  limit: number,
  cursor?: MediaCursor,
): Promise<MediaPage> {
  let query = albumItems(albumId)
  if (cursor) query = query.or(afterCursor(cursor))

  const { data, error } = await query
    .order('sort_key', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)

  if (error) throw error

  const items = (data ?? []) as MediaItem[]
  return { items, hasMore: items.length === limit }
}

/** The items just before `cursor`, returned back in display order. */
export async function fetchMediaBefore(
  albumId: string,
  limit: number,
  cursor: MediaCursor,
): Promise<MediaItem[]> {
  const { data, error } = await albumItems(albumId)
    .or(beforeCursor(cursor))
    // Descending is what makes "the nearest ones before" the first rows; the
    // caller wants them the other way round.
    .order('sort_key', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (error) throw error
  return ((data ?? []) as MediaItem[]).reverse()
}

export async function fetchMediaItem(albumId: string, itemId: string): Promise<MediaItem | null> {
  const { data, error } = await albumItems(albumId).eq('id', itemId).maybeSingle()

  if (error) throw error
  return (data as MediaItem | null) ?? null
}
