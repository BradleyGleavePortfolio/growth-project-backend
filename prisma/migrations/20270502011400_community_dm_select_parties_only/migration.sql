-- DM-SELECT-RLS (COACH-DM-BE's "Found, not fixed", b#1243; [W2] "RLS for everything"): at the row layer a
-- community direct message, its voice notes and its reactions now read only for the DM's sender and its
-- recipient. This one migration closes the class (operator ruling 01:0x PST 11-10).
-- 1. community_messages_select let the workspace coach read every row of the workspace, a DM between two of
--    their clients included (its coach arm had no scope test); that arm now reads scope 'cohort' rows only. The
--    scope enum has two values, cohort and dm, so every non-DM row the coach read before still reads, and a scope
--    added later reads for no coach until a policy says so. The coach's own DMs still read through the DM arm.
-- 2. community_voice_notes_coach_all (FOR ALL, USING only) no longer reaches a DM voice note (conversation_id
--    set), which then reads for its author only (community_voice_notes_member_select). No DM voice note can be
--    written today (VOICE_DM_NOT_SUPPORTED).
-- 3. New function app.community_response_dm_party(target_type, target_id): false only for a reaction whose
--    target is a community_messages row (target_type 'message' or 'comment') of scope 'dm' that the caller
--    neither sent nor received; true for every other reaction (a cohort row, a post, event or challenge, an id
--    with no row). It matches the message on id alone, so a NULL or wrong target_created_at cannot hide a DM,
--    and a NULL caller is neither person. It is SECURITY DEFINER (owner postgres, which bypasses row security)
--    because a lookup under the caller's own row security would also hide cohort rows the caller cannot read
--    (another space, a banned or blocked author), whose reactions read today. It answers yes or no and shows
--    no row. Run rights: authenticated and service_role, not PUBLIC or anon.
-- 4. community_responses_coach_all (FOR ALL) and community_responses_member_select each AND that function on
--    USING: a reaction on a DM reads only for its two people (each still needing the coach or member arm), and
--    every other reaction reads for exactly who read it before. coach_all's WITH CHECK, _own_insert and
--    _own_delete are unchanged.
-- Writes: a FOR ALL policy's USING also limits UPDATE and DELETE, so through community_voice_notes_coach_all
-- and community_responses_coach_all the coach no longer updates or deletes another person's DM voice note or a
-- reaction on a DM he is not in; every WITH CHECK is unchanged. The RESTRICTIVE policies still AND on top
-- (*_author_stays, *_unbanned_unblocked). The app connects as a role that bypasses row security, so no request
-- path changes; this binds any reader that runs as authenticated with app.current_user_id set. The comment above
-- community_messages_select in 20261212000000 is stale; this header is what is true. No table, column, index,
-- table grant or data changes. Reverse: down.sql. Live proof: test/rls/community-dm-select-rls.spec.ts and
-- test/fix-1245r1-dm-responses-class.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "community_messages_select" ON "community_messages"
  USING (
    (app.is_community_workspace_coach("workspace_id") AND "scope" = 'cohort')
    OR ("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))
    OR ("scope" = 'dm' AND ("sender_id"::text = app.current_user_id() OR "recipient_user_id"::text = app.current_user_id()))
  );

ALTER POLICY "community_voice_notes_coach_all" ON "community_voice_notes"
  USING (app.is_community_workspace_coach("workspace_id") AND "conversation_id" IS NULL);

CREATE OR REPLACE FUNCTION app.community_response_dm_party(p_target_type "CommunityResponseTargetType", p_target_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p_target_type NOT IN ('message', 'comment')
    OR NOT EXISTS (
      SELECT 1 FROM public."community_messages" m
      WHERE m."id" = p_target_id
        AND m."scope" = 'dm'
        AND NOT coalesce(m."sender_id"::text = app.current_user_id()
                         OR m."recipient_user_id"::text = app.current_user_id(), false)
    )
$fn$;
ALTER FUNCTION app.community_response_dm_party("CommunityResponseTargetType", uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_response_dm_party("CommunityResponseTargetType", uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_response_dm_party("CommunityResponseTargetType", uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_response_dm_party("CommunityResponseTargetType", uuid) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_response_dm_party("CommunityResponseTargetType", uuid) IS
  '20270502011400: false only for a reaction on a community DM (target_type message or comment, a community_messages row of scope dm, matched on id alone) that the caller neither sent nor received, and true for every other reaction. DEFINER, so the caller''s row security on community_messages cannot hide a cohort row.';

ALTER POLICY "community_responses_coach_all" ON "community_responses"
  USING (app.is_community_workspace_coach("workspace_id") AND app.community_response_dm_party("target_type", "target_id"));

ALTER POLICY "community_responses_member_select" ON "community_responses"
  USING (app.is_community_workspace_member("workspace_id") AND app.community_response_dm_party("target_type", "target_id"));

COMMIT;
