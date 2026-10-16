-- COACH-AI-CONSENT-BE: a coach's own AI grant lives in the existing ledger
-- (purpose 'coach_ai_processing', copy coach-ai-v1). One change: the action
-- CHECK also allows 'decline', a coach's "Not now" (asked, no grant), so the
-- one-time ask shows once per account. No column, policy or data change: RLS
-- stays service_role all, own rows read-only, anon denied
-- (20270203000000_ai_processing_consent_ledger).
-- Order: after 20270502003600 (FIX1061), 003700 (MSGRT), 003800 (MOVEPROG).
-- Live proof: test/rls/coach-ai-consent-rls.spec.ts (rls-live-tests).
-- Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "AiProcessingConsentEvent" DROP CONSTRAINT "AiProcessingConsentEvent_action_check";
ALTER TABLE "AiProcessingConsentEvent" ADD CONSTRAINT "AiProcessingConsentEvent_action_check"
  CHECK ("action" IN ('grant', 'withdraw', 'decline'));

COMMIT;
