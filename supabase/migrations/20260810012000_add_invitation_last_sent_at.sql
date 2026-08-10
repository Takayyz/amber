-- Gates the re-send cooldown (README "Invite flow"). Supabase Auth's hourly
-- mail budget is shared with magic-link login, so unthrottled re-sends would
-- stop existing members from signing in.

-- Defaulting to now() rather than null means existing rows start their
-- cooldown at migration time. That is the safe direction: a row that has in
-- fact not been mailed for weeks is briefly un-resendable, whereas a null
-- would have to be read as "never sent" and waved straight through.
alter table public.invitations
  add column last_sent_at timestamptz not null default now();
