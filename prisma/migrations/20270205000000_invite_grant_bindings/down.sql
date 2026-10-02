-- Reverse of 20270205000000_invite_grant_bindings (clinic C01; renamed from
-- 20270125000000_ in the merge train so it sorts after every main migration).
-- Drops only what the forward migration added.
--
-- Grant rows in ClientPurchase (source IS NOT NULL) would otherwise lose their
-- provenance columns and become indistinguishable from paid purchases while
-- still unlocking the paywall. Neutralise them FIRST: close the entitlement
-- and mark the row so it can be identified after the columns are gone
-- (amount_cents 0 + status 'revoked' + the synthetic grant_ session id).
-- Their pending drops are canceled like a refund. Nothing here touches rows
-- with source IS NULL (real Stripe purchases).
UPDATE "ScheduledDrop" SET status = 'canceled', failure_reason = 'canceled:grant_rollback'
WHERE status IN ('pending', 'due')
  AND client_purchase_id IN (SELECT id FROM "ClientPurchase" WHERE "source" IS NOT NULL);
UPDATE "ClientPurchase"
SET entitlement_active = false, status = 'revoked', canceled_at = COALESCE(canceled_at, NOW())
WHERE "source" IS NOT NULL;
-- Full removal instead (only if the fan-out rows should go too):
--   DELETE FROM "ScheduledDrop" WHERE client_purchase_id IN (SELECT id FROM "ClientPurchase" WHERE "source" IS NOT NULL);
--   DELETE FROM "PurchaseFanout" WHERE purchase_id IN (SELECT id FROM "ClientPurchase" WHERE "source" IS NOT NULL);
--   DELETE FROM "ClientPurchase" WHERE "source" IS NOT NULL;
DROP INDEX IF EXISTS "ClientPurchase_source_idx";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "grant_metadata";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "source";

ALTER TABLE "CoachProfile" DROP CONSTRAINT IF EXISTS "CoachProfile_invite_code_package_id_fkey";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "invite_code_grant_mode";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "invite_code_package_id";

ALTER TABLE "InviteCode" DROP CONSTRAINT IF EXISTS "InviteCode_package_id_fkey";
DROP INDEX IF EXISTS "InviteCode_package_id_idx";
ALTER TABLE "InviteCode" DROP COLUMN IF EXISTS "grant_mode";
ALTER TABLE "InviteCode" DROP COLUMN IF EXISTS "package_id";

DROP TYPE IF EXISTS "InviteGrantMode";
