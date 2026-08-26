-- albums.updated_at was never moving. It defaulted to the album's creation
-- time and nothing wrote to it again, so both features that read it were
-- quietly reading a fixed value: the album list's "most recently updated"
-- order (README "Album ordering") was really creation order, and the
-- new-since-last-visit badge would never light once a member's last_seen_at
-- passed the creation time.
--
-- A trigger rather than a write from the uploader, because the column has to
-- move however a row arrives -- a second upload path, an importer, or a row
-- inserted by hand -- and a caller that forgets it fails silently in a way
-- neither feature can report.
--
-- security definer to match the other triggers here: bumping the column is
-- bookkeeping about the album rather than an edit the member is making, so it
-- should not depend on what their own policies happen to allow.
create function public.touch_album_on_new_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.albums set updated_at = now() where id = new.album_id;
  return new;
end;
$$;

-- Insert only. Deleting a photo does change the album, but it is not
-- something to call new, and bumping here would light the badge for a photo
-- that had just been taken away.
create trigger media_items_touch_album
  after insert on public.media_items
  for each row execute function public.touch_album_on_new_item();

-- Existing albums still carry their creation time, which would leave them
-- looking older than everything uploaded into them since -- permanently, for
-- anything uploaded before this migration. Bring each one up to its newest
-- item. greatest() so an album whose own row was touched more recently than
-- its newest photo does not travel backwards, and an album with no items at
-- all keeps the time it was created.
update public.albums a
set updated_at = greatest(a.updated_at, latest.uploaded_at)
from (
  select album_id, max(uploaded_at) as uploaded_at
  from public.media_items
  group by album_id
) as latest
where latest.album_id = a.id;
