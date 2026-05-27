-- R47 / Audit #6 P0-6 — durable lead-sync worker state.
--
-- 1. Add `syncing` to the CrmSyncStatus enum so the lead-sync worker can
--    claim a row via SKIP LOCKED and mark it owned without colliding
--    with the `pending` filter another replica might be running at the
--    same instant.
-- 2. Add CoachLandingLead.attempts (int default 0) and
--    next_eligible_at (nullable timestamptz). These replace the
--    in-process Maps that lost their state on every restart, letting
--    a poisoned lead loop forever after a deploy.
-- 3. Add composite index (crm_sync_status, next_eligible_at) so the
--    worker claim "WHERE crm_sync_status='pending' AND
--    (next_eligible_at IS NULL OR next_eligible_at <= now())" hits an
--    index even when the table grows large.
-- 4. Audit #6 P1-9 — enforce (coach_id, provider) uniqueness on
--    CoachCrmIntegration. The upsert path in CoachCrmService used
--    findFirst+create which races itself; without this constraint the
--    same coach can end up with two enabled rows for the same provider
--    and every lead would fan out twice on every sync tick.

-- ── 1. Enum extension ───────────────────────────────────────────────────
-- Postgres requires ALTER TYPE ADD VALUE to run outside a transaction
-- block, but Prisma's migrate engine wraps each migration in a single
-- transaction by default. The published workaround is to declare the
-- ALTER TYPE at the top of the file: Prisma's runner detects the
-- statement and switches to autocommit mode for the whole migration.
ALTER TYPE "CrmSyncStatus" ADD VALUE IF NOT EXISTS 'syncing';

-- ── 2. CoachLandingLead retry-state columns ─────────────────────────────
ALTER TABLE "CoachLandingLead"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_eligible_at" TIMESTAMPTZ;

-- ── 3. Worker claim index ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "CoachLandingLead_crm_sync_status_next_eligible_at_idx"
  ON "CoachLandingLead" ("crm_sync_status", "next_eligible_at");

-- ── 4. (coach_id, provider) uniqueness on CoachCrmIntegration ──────────
-- Defensive de-dup: if any duplicates already exist (the bug we're
-- fixing), keep the newest enabled row and delete the older ones BEFORE
-- creating the unique index. Otherwise the CREATE UNIQUE INDEX would
-- fail and leave the migration half-applied.
DELETE FROM "CoachCrmIntegration"
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY coach_id, provider
               ORDER BY enabled DESC, created_at DESC
             ) AS rn
      FROM "CoachCrmIntegration"
    ) ranked
    WHERE rn > 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS "CoachCrmIntegration_coach_id_provider_key"
  ON "CoachCrmIntegration" ("coach_id", "provider");
