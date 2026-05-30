-- Wave-0 schema (issues A1 + LTV-3). Pure additive data-layer migration:
-- two new tables landed together so the downstream logic agents (A1-logic,
-- LTV-3-logic) can run in parallel without colliding on schema.prisma or
-- migration ordering. NO changes to existing tables.
--
--   * UserAIQuota       — per-user DAILY AI token quota (one row per
--                         (user_id, quota_date) UTC day bucket). A1 reads/
--                         increments tokens_used/request_count atomically via
--                         the (user_id, quota_date) unique. FK→User CASCADE.
--   * coach_ltv_peak    — per-coach persisted LTV peak (zero_churn_streak +
--                         all_time_peak_rpcm, RPCM in cents as DECIMAL(20,6)).
--                         One row per coach (coach_id unique). Replaces the
--                         recompute-not-persist path in ltv-metrics.service.ts.
--                         coach_id→User CASCADE, matching CoachEffectivenessScore.

-- CreateTable
CREATE TABLE "UserAIQuota" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "quota_date" DATE NOT NULL,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAIQuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_ltv_peak" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "zero_churn_streak" INTEGER NOT NULL DEFAULT 0,
    "all_time_peak_rpcm" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_ltv_peak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAIQuota_user_id_idx" ON "UserAIQuota"("user_id");

-- CreateIndex
CREATE INDEX "UserAIQuota_quota_date_idx" ON "UserAIQuota"("quota_date");

-- CreateIndex
CREATE UNIQUE INDEX "UserAIQuota_user_id_quota_date_key" ON "UserAIQuota"("user_id", "quota_date");

-- CreateIndex
CREATE UNIQUE INDEX "coach_ltv_peak_coach_id_key" ON "coach_ltv_peak"("coach_id");

-- AddForeignKey
ALTER TABLE "UserAIQuota" ADD CONSTRAINT "UserAIQuota_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_ltv_peak" ADD CONSTRAINT "coach_ltv_peak_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

