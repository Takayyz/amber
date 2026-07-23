-- Local-only setup (runs on `supabase db reset`, never applied to a linked
-- project). pgtap is a testing tool, not a schema dependency, so it lives
-- here rather than in a migration.
create extension if not exists pgtap with schema extensions;
