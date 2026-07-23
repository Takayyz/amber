-- Structural checks for the flat, service-wide access-control model
-- (README.md "Access Control Model"): RLS is enabled everywhere, and every
-- table except the self-service parts of `members` reduces to is_member().
--
-- Role-based behavioral tests (e.g. "member A cannot rename member B") need
-- a way to impersonate auth.uid() per test, which this project doesn't have
-- set up yet -- left as future work rather than adding a test-helper
-- dependency the rest of the schema doesn't otherwise need.
BEGIN;
SELECT plan(15);

-- RLS is enabled on every table. pgtap has no is_rls_enabled() helper, so
-- check pg_class.relrowsecurity directly.
SELECT ok(relrowsecurity, 'members has RLS enabled') FROM pg_class WHERE oid = 'public.members'::regclass;
SELECT ok(relrowsecurity, 'albums has RLS enabled') FROM pg_class WHERE oid = 'public.albums'::regclass;
SELECT ok(relrowsecurity, 'media_items has RLS enabled') FROM pg_class WHERE oid = 'public.media_items'::regclass;
SELECT ok(relrowsecurity, 'tags has RLS enabled') FROM pg_class WHERE oid = 'public.tags'::regclass;
SELECT ok(relrowsecurity, 'media_item_tags has RLS enabled') FROM pg_class WHERE oid = 'public.media_item_tags'::regclass;
SELECT ok(relrowsecurity, 'invitations has RLS enabled') FROM pg_class WHERE oid = 'public.invitations'::regclass;

-- members is the one table that isn't a single flat is_member() policy:
-- selecting the roster is flat, but editing a profile is self-service only.
SELECT policies_are(
  'public', 'members',
  ARRAY['members_select', 'members_update_self'],
  'members has roster-read + self-update policies, not a flat all-ops policy'
);

-- Every other table reduces to the single flat is_member() policy.
SELECT policies_are('public', 'albums', ARRAY['albums_all'], 'albums has a single flat policy');
SELECT policies_are('public', 'media_items', ARRAY['media_items_all'], 'media_items has a single flat policy');
SELECT policies_are('public', 'tags', ARRAY['tags_all'], 'tags has a single flat policy');
SELECT policies_are('public', 'media_item_tags', ARRAY['media_item_tags_all'], 'media_item_tags has a single flat policy');
SELECT policies_are('public', 'invitations', ARRAY['invitations_all'], 'invitations has a single flat policy');

-- Supporting functions and the 5-tag-cap trigger exist.
SELECT has_function('public', 'is_member', 'is_member() helper exists');
SELECT has_function('public', 'handle_new_user', 'handle_new_user() auth.users trigger function exists');
SELECT has_trigger('public', 'media_item_tags', 'media_item_tags_limit', 'the 5-tag-cap trigger exists');

SELECT * FROM finish();
ROLLBACK;
