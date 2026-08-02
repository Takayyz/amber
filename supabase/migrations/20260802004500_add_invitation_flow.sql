-- Invitation flow: cancellation handle, pending-list ordering, and the
-- confirmation-time triggers that provision members and settle invitations.
-- See README.md "Invite flow" for why each piece is shaped this way.

-- ============================================================================
-- invitations
-- ============================================================================

-- The only handle on the auth user an invite created. Cancelling deletes that
-- user, which empties this column -- correct, since a cancelled row has
-- nothing left to point at.
alter table public.invitations
  add column invited_user_id uuid references auth.users (id) on delete set null;

alter table public.invitations
  add column created_at timestamptz not null default now();

-- Drives the pending list, newest first.
create index invitations_created_at_idx on public.invitations (created_at desc);

-- Partial, not a plain unique constraint: an address that was cancelled (or
-- that accepted and later left) has to be invitable again.
create unique index invitations_pending_email_idx
  on public.invitations (lower(email))
  where status = 'pending';

-- service_role ignores RLS but is not granted table privileges automatically,
-- so the Worker needs this to keep the ledger. Scoped to invitations alone --
-- every other table is reachable through RLS from the browser, and widening
-- the grant would only enlarge what a leaked key could touch.
grant select, insert, update on public.invitations to service_role;

-- ============================================================================
-- Member provisioning
-- ============================================================================

-- Supabase Auth's invite inserts auth.users unconfirmed, so the original
-- insert-time provisioning enrolled people who had not shown up yet.
-- Membership now begins at first email confirmation instead.
drop trigger on_auth_user_created on auth.users;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Accounts that arrive already confirmed -- the first account of a fresh
  -- deployment, created out of band by an admin -- never produce a
  -- null-to-non-null transition, so they are enrolled here instead.
  if new.email_confirmed_at is not null then
    insert into public.members (id) values (new.id) on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- First confirmation -- reached by the invite link or by an ordinary magic
-- link, whichever gets there first. Both funnel through email_confirmed_at,
-- so this is the one place that observes every path in.
create function public.handle_user_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.members (id) values (new.id) on conflict (id) do nothing;

  update public.invitations
    set status = 'accepted'
    where lower(email) = lower(new.email)
      and status = 'pending';

  return new;
end;
$$;

create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_user_confirmed();
