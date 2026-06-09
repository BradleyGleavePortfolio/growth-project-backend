-- B3 Smart Dunning v2 — additive schema delta (spec PR #6 §2).
--
-- Two NULLABLE / DEFAULTED columns on the existing DunningState table plus
-- one NET-NEW PaymentRecoveryToken table. NOTHING destructive: no DROP, no
-- NOT NULL backfill, no type change, no FK alter on an existing table.
-- Existing rows continue to read and write exactly as before (locked_out_at
-- reads NULL, reversal_count reads 0). The whole v2 code path is gated behind
-- FEATURE_DUNNING_V2 (default OFF); v1 never reads or writes these additions.
--
-- This migration matches what `prisma migrate diff` produces from
-- prisma/schema.prisma for the DUNNING-V2 hunk; it is recorded here so the
-- delta is reviewable in the PR. The migration is SAFE to apply ahead of the
-- flag flip because the v1 service ignores the new fields entirely.

-- AlterTable — Day-10 hard-lockout marker (B3 §2.2 / §7). Nullable.
ALTER TABLE "DunningState" ADD COLUMN "locked_out_at" TIMESTAMP(3);

-- AlterTable — late-reversal cycle counter (B3 §2.2 / §6). Defaulted to 0.
ALTER TABLE "DunningState" ADD COLUMN "reversal_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable — branded JWT recovery links (B3 §2.1 / §10). NET-NEW table.
CREATE TABLE "PaymentRecoveryToken" (
    "id" TEXT NOT NULL,
    "dunning_attempt_id" TEXT NOT NULL,
    "jwt_jti" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip" TEXT,
    "ua" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecoveryToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecoveryToken_dunning_attempt_id_key" ON "PaymentRecoveryToken"("dunning_attempt_id");
CREATE UNIQUE INDEX "PaymentRecoveryToken_jwt_jti_key" ON "PaymentRecoveryToken"("jwt_jti");
CREATE INDEX "PaymentRecoveryToken_expires_at_idx" ON "PaymentRecoveryToken"("expires_at");
CREATE INDEX "PaymentRecoveryToken_jwt_jti_idx" ON "PaymentRecoveryToken"("jwt_jti");
