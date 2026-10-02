-- S-DUNNING-R2 (owner rulings 1A / 2A, 2026-10-01 16:30 PDT).
-- Additive, nullable columns on "DunningState"; no backfill, no default, no
-- lock beyond the brief ALTER. Every existing row and read path is unchanged.
--   billing_action / billing_action_until: short CAS lease that serializes a
--     client card update that pays the open invoice against a client cancel
--     that voids it.
--   client_canceled_at: the client ended the plan during the cycle (2A).
ALTER TABLE "DunningState" ADD COLUMN IF NOT EXISTS "billing_action" TEXT;
ALTER TABLE "DunningState" ADD COLUMN IF NOT EXISTS "billing_action_until" TIMESTAMP(3);
ALTER TABLE "DunningState" ADD COLUMN IF NOT EXISTS "client_canceled_at" TIMESTAMP(3);
