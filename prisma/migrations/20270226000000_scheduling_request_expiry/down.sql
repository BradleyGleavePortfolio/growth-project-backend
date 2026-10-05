-- Reverse of 20270226000000_scheduling_request_expiry.
--
-- Postgres cannot drop a value from an enum in place, so 'expired' stays in
-- "SessionStatus" (harmless when unused). Rows that expired are kept as
-- terminal history: they are moved to 'declined' with end_reason
-- 'request_expired' so the pre-expiry code (which does not know 'expired')
-- reads them as a closed request that holds no slot.
UPDATE "CoachingSession" SET "status" = 'declined', "end_reason" = COALESCE("end_reason", 'request_expired')
WHERE "status"::text = 'expired';

DROP TABLE IF EXISTS "SchedulingJobLease";
DROP INDEX IF EXISTS "CoachingSession_status_request_expires_at_idx";
ALTER TABLE "CoachingSession" DROP COLUMN IF EXISTS "request_expires_at";
