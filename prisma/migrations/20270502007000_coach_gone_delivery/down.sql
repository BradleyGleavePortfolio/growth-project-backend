-- Reverse of 20270502007000_coach_gone_delivery: drops only the two columns it adds.
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "renewal_off_for_deletion_at";
ALTER TABLE "CoachPackage" DROP COLUMN IF EXISTS "closed_for_deletion_at";
