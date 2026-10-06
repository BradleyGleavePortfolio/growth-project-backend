-- D2d (B-DUND2D-121, agent 121) — R-DISPUTE-PAUSE effects the dunning v2
-- dispute pause and the coach restart record.
--
-- Additive only: two nullable timestamp columns, no backfill, no index, no
-- RLS change (both tables are server-only; their policies cover every
-- column). Existing rows keep NULL, which every reader treats as "not
-- confirmed" / "not restarted". No user id, email, token or secret is added,
-- so nothing is owed to the account-deletion manifest.
--   "DunningState"."billing_paused_at": when Stripe confirmed the dispute
--     pause of the cycle (pause_collection set, open invoices stopped). The
--     client read model reports billing as paused only once this is set; the
--     v2 sweep re-asserts a pause recorded without it. The coach restart
--     clears it before Stripe resumes.
--   "DunningDisputeObligation"."restarted_at": the coach restarted the plan
--     with this dispute on record. A later closure of the same dispute (lost
--     included) or a redelivered opening never changes the plan's access
--     again; the money reversal still runs.
--
-- Rollback: down.sql drops both columns.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "DunningState" ADD COLUMN IF NOT EXISTS "billing_paused_at" TIMESTAMP(3);
ALTER TABLE "DunningDisputeObligation" ADD COLUMN IF NOT EXISTS "restarted_at" TIMESTAMP(3);

COMMIT;
