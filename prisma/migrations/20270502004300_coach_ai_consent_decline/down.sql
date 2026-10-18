-- Reverse of 20270502004300_coach_ai_consent_decline. Deletes the 'decline'
-- rows (coaches' "Not now"; those coaches read as not asked again, so the
-- one-time ask shows once more), then restores the two-action CHECK exactly.
-- Coach grants and withdrawals stay (the old CHECK allows them).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DELETE FROM "AiProcessingConsentEvent" WHERE "action" = 'decline';
ALTER TABLE "AiProcessingConsentEvent" DROP CONSTRAINT "AiProcessingConsentEvent_action_check";
ALTER TABLE "AiProcessingConsentEvent" ADD CONSTRAINT "AiProcessingConsentEvent_action_check"
  CHECK ("action" IN ('grant', 'withdraw'));

COMMIT;
