-- Bank-Account Payouts v2 — additive schema delta (spec §2.2 / §2.3).
--
-- ADDITIVE ONLY. This migration:
--   1. Creates two NET-NEW enums (PayoutMethodKind, PayoutMethodStatus).
--   2. Creates ONE NET-NEW table (PayoutMethod) + its two indexes.
--   3. Adds ONE NULLABLE FK column to the existing User table
--      (default_payout_method_id) + its foreign key.
--
-- It performs ZERO destructive operations: no DROP, no RENAME, no
-- ALTER COLUMN TYPE, no TRUNCATE, no DELETE FROM, no NOT NULL backfill on any
-- existing table. The new User column is NULLABLE so the migration is
-- non-blocking and back-compatible — a coach with no PayoutMethod row simply
-- falls through to the existing Stripe Express flow (ConnectAccount stays
-- exactly as-is). The whole v2 code path is gated behind FEATURE_BANK_PAYOUTS_V2
-- (default OFF); while the flag is off NO code reads or writes these additions.
--
-- This matches what `prisma migrate diff` produces from prisma/schema.prisma
-- for the PAYOUTS-V2 hunk; recorded here so the delta is reviewable in the PR.
-- It is SAFE to apply ahead of the flag flip.
--
-- Reversibility (spec §2.3): drop the FK + column on User, drop the
-- PayoutMethod table, drop the two enums.

-- CreateEnum
CREATE TYPE "PayoutMethodKind" AS ENUM ('STRIPE_EXPRESS', 'STRIPE_CONNECT_CUSTOM_BANK', 'STRIPE_TREASURY');

-- CreateEnum
CREATE TYPE "PayoutMethodStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'DISABLED');

-- AlterTable — nullable FK to the coach's default payout method (spec §2.3).
ALTER TABLE "User" ADD COLUMN "default_payout_method_id" TEXT;

-- CreateTable — net-new coach payout-method destinations (spec §2.2).
CREATE TABLE "PayoutMethod" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "kind" "PayoutMethodKind" NOT NULL,
    "stripe_external_account_id" TEXT,
    "last4" TEXT,
    "bank_name" TEXT,
    "status" "PayoutMethodStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutMethod_coach_id_idx" ON "PayoutMethod"("coach_id");

-- CreateIndex
CREATE INDEX "PayoutMethod_coach_id_status_idx" ON "PayoutMethod"("coach_id", "status");

-- AddForeignKey — PayoutMethod.coach_id -> User.id (cascade on coach delete).
ALTER TABLE "PayoutMethod" ADD CONSTRAINT "PayoutMethod_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — User.default_payout_method_id -> PayoutMethod.id (nullable;
-- SET NULL on delete so disabling a method never orphans the User row).
ALTER TABLE "User" ADD CONSTRAINT "User_default_payout_method_id_fkey" FOREIGN KEY ("default_payout_method_id") REFERENCES "PayoutMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
