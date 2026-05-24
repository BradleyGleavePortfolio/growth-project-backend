-- Phase 11 / Track 8 — Audit #4 P1-1
--
-- Make MarketplaceMutationIdempotency atomic-claim capable. The previous
-- check-then-act (findReplay → mutate → record) was not concurrency-safe:
-- two simultaneous same-key requests could both observe an empty ledger,
-- both run the mutation, and the loser would surface a user-visible 409.
--
-- This migration adds `status` and `completed_at` so the service can claim
-- a key by inserting an `in_progress` row first (P2002-on-duplicate is the
-- race winner), then mark the row `completed` with the response after the
-- mutation lands. A concurrent caller that loses the insert race polls the
-- row's status to decide between "replay completed response" and "409 still
-- in progress".
--
-- Additive only; no existing data discarded.

ALTER TABLE "MarketplaceMutationIdempotency"
  ADD COLUMN IF NOT EXISTS "status"       TEXT        NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ;

-- The `response` column must now allow NULL so that an in-progress claim row
-- (inserted *before* the mutation lands) can be persisted with no response
-- payload yet. The non-null contract was unsafe for the new claim-first flow.
ALTER TABLE "MarketplaceMutationIdempotency"
  ALTER COLUMN "response" DROP NOT NULL;

-- Pre-existing rows were written via the legacy record()-after-work path, so
-- they are by definition completed. Backfill defensively in case any row was
-- left with the default unset by an out-of-band insert.
UPDATE "MarketplaceMutationIdempotency"
   SET "status" = 'completed'
 WHERE "status" IS NULL;
