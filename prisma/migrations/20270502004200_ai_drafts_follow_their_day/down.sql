-- Down for 20270502004200_ai_drafts_follow_their_day (MOVEPROG-DRAFTS).
-- Drops the restrictive policy. This brings back the gap: a former coach can
-- again read and decide, at the row layer, an AI draft that edits a day of a
-- moved client's program copy. No data to restore.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "ai_action_draft_day_stays" ON "AiActionDraft";

COMMIT;
