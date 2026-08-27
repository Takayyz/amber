-- Removing tags nothing points at any more (README "Tags").
--
-- This has to be a function rather than a delete from the client, because the
-- client version is a read followed by a write and the gap between them loses
-- data. Two members, one tag:
--
--   1. A takes the tag off the last photo carrying it
--   2. B puts that same tag on a different photo, and commits
--   3. A, still believing nothing points at it, deletes the tag
--   4. `media_item_tags.tag_id references tags on delete cascade` takes B's
--      brand new row with it
--
-- Nothing raises, so the tag B just added is simply gone the next time they
-- look. The check and the delete have to be one statement's worth of work, in
-- one transaction, for step 3 to see step 2.
--
-- Left as security invoker (the default), like `search_media_items`: the
-- caller's own RLS is what keeps this to members. Everyone may delete any tag
-- already -- the flat permission model -- so this grants nothing new, it only
-- makes the deleting safe.

-- One tag, named rather than counted: the caller has just detached it and
-- wants that specific row gone if it was the last link.
create function public.prune_tag_if_unused(target_tag_id uuid)
returns boolean
language plpgsql
as $$
begin
  -- Taken before the check, and this is the whole point of the function. An
  -- insert into media_item_tags takes FOR KEY SHARE on the tag it references,
  -- which FOR UPDATE conflicts with -- so a member attaching this tag right
  -- now blocks here until they are done. The EXISTS below then runs as its own
  -- command, on a fresh snapshot, and sees the row they just committed.
  perform 1 from public.tags where id = target_tag_id for update;
  if not found then
    return false;
  end if;

  if exists (select 1 from public.media_item_tags where tag_id = target_tag_id) then
    return false;
  end if;

  delete from public.tags where id = target_tag_id;
  return true;
end;
$$;

-- Every tag nothing points at, for the cases the call above cannot cover: a
-- tag created by `attachTag` whose second step was refused (the five-tag cap,
-- or a duplicate) leaves the tags row behind with no link ever made, and a
-- detach in another tab leaves one this session never heard about.
--
-- Note what is *not* an orphan: a photo in the trash keeps its media_item_tags
-- rows, since only the media_items row is flagged. A tag on nothing but
-- trashed photos therefore survives, and comes back with them.
create function public.prune_unused_tags()
returns integer
language plpgsql
as $$
declare
  pruned integer := 0;
  candidate uuid;
begin
  -- One at a time through the same guarded path rather than one big delete:
  -- the lock is per row, and a sweep that took them all at once would hold
  -- every tag against everyone attaching anything for as long as it ran.
  for candidate in
    select t.id
    from public.tags t
    where not exists (select 1 from public.media_item_tags mit where mit.tag_id = t.id)
  loop
    if public.prune_tag_if_unused(candidate) then
      pruned := pruned + 1;
    end if;
  end loop;

  return pruned;
end;
$$;

grant execute on function public.prune_tag_if_unused to authenticated;
grant execute on function public.prune_unused_tags to authenticated;
