-- Coach AI Engine v1 — Claude Sonnet adapter, per-client draft + approve
-- flow, per-call cost log.
--
-- Additive only. No backfill required.
--   * UserProfile gains three coach-AI inputs (injuries, food_preferences,
--     preferred_training_time). The Claude prompt needs these as
--     structured fields rather than free-form `bio`.
--   * AIDraftType / AIDraftStatus enums + AIDraft table — draft + approve
--     surface for workout programs, meal plans, and weekly insights.
--   * AICallLog table — per-call cost + latency log, written for every
--     adapter invocation. Powers the $20/coach/mo budget alarm.

-- 1. UserProfile additions ------------------------------------------------
ALTER TABLE "UserProfile"
    ADD COLUMN "injuries"                TEXT[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN "food_preferences"        JSONB,
    ADD COLUMN "preferred_training_time" TEXT;

-- 2. Enums ----------------------------------------------------------------
CREATE TYPE "AIDraftType"   AS ENUM ('WORKOUT_PROGRAM', 'MEAL_PLAN', 'INSIGHT');
CREATE TYPE "AIDraftStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'EXPIRED');

-- 3. AIDraft --------------------------------------------------------------
CREATE TABLE "AIDraft" (
    "id"               TEXT NOT NULL,
    "coachId"          TEXT NOT NULL,
    "clientId"         TEXT NOT NULL,
    "type"             "AIDraftType" NOT NULL,
    "inputContext"     JSONB NOT NULL,
    "modelUsed"        TEXT NOT NULL,
    "promptVersion"    TEXT NOT NULL,
    "generatedPayload" JSONB NOT NULL,
    "status"           "AIDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAsId"     TEXT,
    "rejectionReason"  TEXT,
    "tokensIn"         INTEGER NOT NULL DEFAULT 0,
    "tokensOut"        INTEGER NOT NULL DEFAULT 0,
    "costCents"        INTEGER NOT NULL DEFAULT 0,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AIDraft_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AIDraft_coachId_clientId_type_status_idx"
    ON "AIDraft"("coachId", "clientId", "type", "status");
ALTER TABLE "AIDraft"
    ADD CONSTRAINT "AIDraft_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIDraft"
    ADD CONSTRAINT "AIDraft_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. AICallLog ------------------------------------------------------------
CREATE TABLE "AICallLog" (
    "id"           TEXT NOT NULL,
    "model"        TEXT NOT NULL,
    "tokensIn"     INTEGER NOT NULL,
    "tokensOut"    INTEGER NOT NULL,
    "costCents"    INTEGER NOT NULL,
    "latencyMs"    INTEGER NOT NULL,
    "success"      BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "coachId"      TEXT,
    "clientId"     TEXT,
    "capability"   TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AICallLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AICallLog_coachId_createdAt_idx"
    ON "AICallLog"("coachId", "createdAt");
CREATE INDEX "AICallLog_capability_createdAt_idx"
    ON "AICallLog"("capability", "createdAt");
ALTER TABLE "AICallLog"
    ADD CONSTRAINT "AICallLog_coachId_fkey"
    FOREIGN KEY ("coachId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AICallLog"
    ADD CONSTRAINT "AICallLog_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
