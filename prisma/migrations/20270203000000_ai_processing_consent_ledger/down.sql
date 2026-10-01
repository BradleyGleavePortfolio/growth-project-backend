-- Reverse of 20270203000000_ai_processing_consent_ledger.
--
-- Drops the ledger table (its policies, trigger, indexes and FK go with it)
-- and the trigger function. This removes every recorded grant / withdraw
-- decision: it does NOT preserve or restore ledger rows. Run it only before
-- any real decision has been recorded (the ledger flag
-- FEATURE_AI_CONSENT_LEDGER_ENABLED has never been on), or after exporting
-- the rows. With the table gone every AI consent read returns "not granted",
-- so AI paths that require consent stay closed.
DROP TABLE IF EXISTS "AiProcessingConsentEvent";
DROP FUNCTION IF EXISTS public.ai_processing_consent_event_reject_update();
