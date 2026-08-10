-- Invitations are the one table members read but never write: sending,
-- re-sending and cancelling all go through the Worker, because each needs the
-- service role key to reach Supabase Auth. The initial schema nonetheless
-- granted writes to `authenticated` along with every other table.
--
-- That gap let any member remove any other member, which "No forced removal"
-- in README's Access Control Model says cannot happen. A member could insert
-- a pending invitation naming somebody else's address, then cancel it: the
-- cancel path resolves the account to delete from the row's email whenever
-- invited_user_id is empty, so the Worker deleted the victim's auth user --
-- and `members` cascades from it.
--
-- The fix is to make the table read-only from the browser. The flat model
-- still holds: every member sees every invitation, and any of them can cancel
-- any invitation through the Worker, which is where the check belongs.

drop policy invitations_all on public.invitations;

create policy invitations_select on public.invitations
  for select to authenticated
  using ((select public.is_member()));

revoke insert, update, delete on public.invitations from authenticated;
