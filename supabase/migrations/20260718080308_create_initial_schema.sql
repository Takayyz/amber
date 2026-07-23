-- Amber initial schema: members, albums, media_items, tags, invitations.
-- Access control is fully flat and service-wide (see README.md "Access Control
-- Model"): almost every policy below reduces to "is this user a member?".

-- ============================================================================
-- members
-- ============================================================================

create table public.members (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  last_seen_at timestamptz
);

-- Supabase Auth's invite flow creates the auth.users row; this trigger
-- mirrors it into public.members so "invite doubles as first login" works
-- without a separate app-level provisioning step.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.members (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- albums (cover_media_item_id FK is added after media_items exists below)
-- ============================================================================

create table public.albums (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  cover_media_item_id uuid,
  uploaded_by uuid references public.members (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index albums_uploaded_by_idx on public.albums (uploaded_by);
-- Drives the "most-recently-updated" album list order, excluding trashed albums.
create index albums_updated_at_idx on public.albums (updated_at desc) where deleted_at is null;

-- ============================================================================
-- media_items
-- ============================================================================

create table public.media_items (
  id uuid primary key default gen_random_uuid(),
  album_id uuid not null references public.albums (id) on delete cascade,
  media_type text not null check (media_type in ('photo', 'video')),
  storage_key text not null,
  captured_at timestamptz,
  uploaded_at timestamptz not null default now(),
  -- Exif-first, upload-time-fallback ordering (see README "Photo ordering").
  sort_key timestamptz generated always as (coalesce(captured_at, uploaded_at)) stored,
  gps_lat double precision,
  gps_lng double precision,
  uploaded_by uuid references public.members (id) on delete set null,
  deleted_at timestamptz
);

create index media_items_uploaded_by_idx on public.media_items (uploaded_by);
-- Drives chronological pagination within an album, excluding trashed items.
create index media_items_album_sort_idx on public.media_items (album_id, sort_key) where deleted_at is null;

alter table public.albums
  add constraint albums_cover_media_item_id_fkey
  foreign key (cover_media_item_id) references public.media_items (id) on delete set null;

create index albums_cover_media_item_id_idx on public.albums (cover_media_item_id);

-- ============================================================================
-- tags
-- ============================================================================

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table public.media_item_tags (
  media_item_id uuid not null references public.media_items (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  primary key (media_item_id, tag_id)
);

-- Reverse lookup for tag-based search (README "Search"), which is service-wide
-- and OR-across-tags, i.e. driven by tag_id rather than media_item_id.
create index media_item_tags_tag_id_idx on public.media_item_tags (tag_id);

-- Postgres can't CHECK a sibling row count directly, so the 5-tag cap
-- (README "Tags") is enforced here instead.
create function public.enforce_media_item_tag_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.media_item_tags where media_item_id = new.media_item_id) >= 5 then
    raise exception 'a photo or video cannot have more than 5 tags';
  end if;
  return new;
end;
$$;

create trigger media_item_tags_limit
  before insert on public.media_item_tags
  for each row execute function public.enforce_media_item_tag_limit();

-- ============================================================================
-- invitations
-- ============================================================================

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  invited_by uuid references public.members (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'cancelled'))
);

create index invitations_invited_by_idx on public.invitations (invited_by);
create index invitations_status_idx on public.invitations (status) where status = 'pending';

-- ============================================================================
-- Row Level Security
-- ============================================================================

-- The single flat-permission check ("is this user a member?") used by nearly
-- every policy below. security definer + fixed search_path avoids both an
-- RLS-on-members recursion and search_path hijacking.
create function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members where id = (select auth.uid())
  );
$$;

alter table public.members enable row level security;
alter table public.albums enable row level security;
alter table public.media_items enable row level security;
alter table public.tags enable row level security;
alter table public.media_item_tags enable row level security;
alter table public.invitations enable row level security;

-- members: any member can see the roster (for "uploaded_by" display), but
-- profile fields are self-service only -- the flat "anyone can edit anything"
-- rule (README "Flat permissions") covers shared content, not other people's
-- profiles.
create policy members_select on public.members
  for select to authenticated
  using ((select public.is_member()));

create policy members_update_self on public.members
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- albums / media_items / tags / media_item_tags / invitations: fully flat,
-- every member can create/read/update/delete every row.
create policy albums_all on public.albums
  for all to authenticated
  using ((select public.is_member()))
  with check ((select public.is_member()));

create policy media_items_all on public.media_items
  for all to authenticated
  using ((select public.is_member()))
  with check ((select public.is_member()));

create policy tags_all on public.tags
  for all to authenticated
  using ((select public.is_member()))
  with check ((select public.is_member()));

create policy media_item_tags_all on public.media_item_tags
  for all to authenticated
  using ((select public.is_member()))
  with check ((select public.is_member()));

create policy invitations_all on public.invitations
  for all to authenticated
  using ((select public.is_member()))
  with check ((select public.is_member()));

-- ============================================================================
-- Grants (Supabase does not auto-expose new tables to API roles by default)
-- ============================================================================

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.albums to authenticated;
grant select, insert, update, delete on public.media_items to authenticated;
grant select, insert, update, delete on public.tags to authenticated;
grant select, insert, update, delete on public.media_item_tags to authenticated;
grant select, insert, update, delete on public.invitations to authenticated;
