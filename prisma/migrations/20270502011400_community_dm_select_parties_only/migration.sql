-- DM-SELECT-RLS (COACH-DM-BE's "Found, not fixed", b#1243; [W2] "RLS for everything"): at the row layer a
-- community direct message now reads only for its sender and its recipient. community_messages_select let the
-- workspace coach read every row of the workspace, a DM between two of their clients included (its coach arm
-- had no scope test); that arm now reads scope 'cohort' rows only. The scope enum has two values, cohort and
-- dm, so every non-DM row the coach read before still reads, and a scope added later reads for no coach until
-- a policy says so. The coach's own DMs still read through the DM arm (sender or recipient).
-- The same one condition closes the class on community_voice_notes_coach_all (FOR ALL, USING only): it no
-- longer reaches a DM voice note (conversation_id set), which then reads for its author only
-- (community_voice_notes_member_select). No DM voice note can be written today (VOICE_DM_NOT_SUPPORTED).
-- The RESTRICTIVE policies still AND on top (*_author_stays, *_unbanned_unblocked). The app connects as
-- service_role (BYPASSRLS), so no request path changes; this binds any reader that runs as authenticated with
-- app.current_user_id set. The comment above community_messages_select in 20261212000000 is stale; this
-- header is what is true. No table, column, index, grant, function, write policy or data changes.
-- Reverse: down.sql. Live proof: test/rls/community-dm-select-rls.spec.ts.

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

COMMIT;
