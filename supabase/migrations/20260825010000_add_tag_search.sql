-- Tag search (README "Search"): service-wide, OR across the selected tags,
-- paged on the same (sort_key, id) cursor as the album grid.
--
-- This is a function rather than a PostgREST query for two reasons, both of
-- which come from the OR being a join to media_item_tags:
--
--   1. A photo carrying two of the selected tags comes back twice. Duplicate
--      rows break the page size, the cursor and the short-page end-of-list
--      signal at once, and PostgREST has no DISTINCT. An EXISTS predicate
--      never duplicates in the first place.
--   2. Inside a function the cursor is the row comparison PostgREST lacks,
--      rather than the or=(...,and(...)) it has to be spelled out as there.
--
-- Left as security invoker (the default) on purpose: the caller's own RLS is
-- what keeps this to members, exactly as it would for a direct query. Making
-- it definer would hand every caller the whole table.
create function public.search_media_items(
  tag_names text[],
  cursor_sort_key timestamptz default null,
  cursor_id uuid default null,
  page_limit int default 36,
  backwards boolean default false
)
returns setof public.media_items
language plpgsql
stable
set search_path = ''
as $$
begin
  -- The two branches differ only in the cursor comparison and the sort
  -- direction. Any change to the visibility or tag conditions has to be made
  -- in both.
  if backwards then
    -- No cursor going backwards means there is nothing before the start, so
    -- the null comparison returning no rows is the wanted answer.
    return query
      select m.*
      from public.media_items m
      where m.deleted_at is null
        and exists (
          select 1
          from public.albums a
          where a.id = m.album_id and a.deleted_at is null
        )
        and exists (
          select 1
          from public.media_item_tags mit
          join public.tags t on t.id = mit.tag_id
          where mit.media_item_id = m.id and t.name = any(tag_names)
        )
        and (m.sort_key, m.id) < (cursor_sort_key, cursor_id)
      order by m.sort_key desc, m.id desc
      limit page_limit;
  else
    return query
      select m.*
      from public.media_items m
      where m.deleted_at is null
        -- Deleting an album flags only its own row, so an item's visibility
        -- is the pair of conditions (README "Soft-delete cascade without
        -- touching child rows"). The album grid gets this for free by being
        -- scoped to an album it already found alive; searching across albums
        -- has to ask.
        and exists (
          select 1
          from public.albums a
          where a.id = m.album_id and a.deleted_at is null
        )
        and exists (
          select 1
          from public.media_item_tags mit
          join public.tags t on t.id = mit.tag_id
          where mit.media_item_id = m.id and t.name = any(tag_names)
        )
        and (cursor_sort_key is null or (m.sort_key, m.id) > (cursor_sort_key, cursor_id))
      order by m.sort_key asc, m.id asc
      limit page_limit;
  end if;
end;
$$;

grant execute on function public.search_media_items to authenticated;
