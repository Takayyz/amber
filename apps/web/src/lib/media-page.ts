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
 * One screen's worth on a phone is 3 columns of roughly 4 rows; a page a few
 * times that keeps the sentinel from firing again the moment it is reached.
 * The album grid and the search results page at the same size.
 */
export const PAGE_SIZE = 36

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

/**
 * One item, by the album it is filed under and its own id.
 *
 * Unlike the listings above this checks the album's `deleted_at` as well as
 * the item's. They are reached from an album screen that already refused to
 * open a trashed album, but this is also what a pasted or bookmarked URL
 * lands on -- and visibility is the pair of conditions (README design notes).
 */
export async function fetchMediaItem(albumId: string, itemId: string): Promise<MediaItem | null> {
  const { data, error } = await supabase
    .from('media_items')
    .select(`${SELECT_WITH_UPLOADER}, album:albums!media_items_album_id_fkey!inner(deleted_at)`)
    .eq('album_id', albumId)
    .eq('id', itemId)
    .is('deleted_at', null)
    .is('album.deleted_at', null)
    .maybeSingle()

  if (error) throw error
  return (data as MediaItem | null) ?? null
}

/**
 * One page of a tag search, in the same order as an album.
 *
 * The work is a database function rather than a query because an OR across
 * tags joins `media_item_tags` and returns a photo once per tag it matched
 * (README design notes). Tags are named rather than identified, so the URL's
 * own `?tags=` can be handed straight through.
 */
async function searchPage(
  tagNames: string[],
  limit: number,
  cursor: MediaCursor | undefined,
  backwards: boolean,
): Promise<MediaItem[]> {
  const { data, error } = await supabase
    .rpc('search_media_items', {
      tag_names: tagNames,
      cursor_sort_key: cursor?.sortKey,
      cursor_id: cursor?.id,
      page_limit: limit,
      backwards,
    })
    // `setof media_items` is what lets the embedding be the same as everywhere
    // else; the generated types don't carry it, hence the cast.
    .select(SELECT_WITH_UPLOADER)

  if (error) throw error
  return (data ?? []) as unknown as MediaItem[]
}

export async function searchMediaPage(
  tagNames: string[],
  limit: number,
  cursor?: MediaCursor,
): Promise<MediaPage> {
  const items = await searchPage(tagNames, limit, cursor, false)
  return { items, hasMore: items.length === limit }
}

/** The matches just before `cursor`, returned back in display order. */
export async function searchMediaBefore(
  tagNames: string[],
  limit: number,
  cursor: MediaCursor,
): Promise<MediaItem[]> {
  const items = await searchPage(tagNames, limit, cursor, true)
  return items.reverse()
}

/**
 * Where a viewer's previous and next come from. The detail view steps through
 * whatever list it was opened out of -- an album, or a set of search results
 * spanning several -- and both are paged on the same cursor.
 */
export interface MediaSource {
  before: (limit: number, cursor: MediaCursor) => Promise<MediaItem[]>
  after: (limit: number, cursor?: MediaCursor) => Promise<MediaPage>
}

export function albumSource(albumId: string): MediaSource {
  return {
    before: (limit, cursor) => fetchMediaBefore(albumId, limit, cursor),
    after: (limit, cursor) => fetchMediaPage(albumId, limit, cursor),
  }
}

export function searchSource(tagNames: string[]): MediaSource {
  return {
    before: (limit, cursor) => searchMediaBefore(tagNames, limit, cursor),
    after: (limit, cursor) => searchMediaPage(tagNames, limit, cursor),
  }
}
