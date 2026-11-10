-- Reverse of 20270502011400_community_dm_select_parties_only, for a confirmed defect only: it gives the
-- workspace coach every DM of the workspace at the row layer again, and every DM voice note. Restores verbatim
-- the community_messages_select USING of 20261212000000_community_v1_1_schema and the
-- community_voice_notes_coach_all USING of 20261217000000_community_voice_notes (its WITH CHECK was not changed).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "community_messages_select" ON "community_messages"
  USING (
    app.is_community_workspace_coach("workspace_id")
    OR ("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))
    OR ("scope" = 'dm' AND (
          "sender_id"::text = app.current_user_id()
          OR "recipient_user_id"::text = app.current_user_id()
       ))
  );

ALTER POLICY "community_voice_notes_coach_all" ON "community_voice_notes"
  USING (app.is_community_workspace_coach("workspace_id"));

COMMIT;
