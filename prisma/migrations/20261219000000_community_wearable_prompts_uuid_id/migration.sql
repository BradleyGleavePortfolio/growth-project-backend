-- v3-4 FOLLOWUP (PR #399 R81 cleanup, audit F1) — re-key community wearable
-- prompts from cuid() TEXT ids onto UUID ids, matching the voice-notes /
-- search-entry identity convention (uuid PK + @db.Uuid) so the controller's
-- ParseUUIDPipe({ version: '4' }) on :promptId validates real runtime ids.
--
-- WHY DROP+RECREATE (not ALTER COLUMN ... TYPE uuid USING ...):
--   Both feature flags (FEATURE_COMMUNITY_SEARCH / FEATURE_COMMUNITY_WEARABLE_PROMPTS)
--   are default-OFF and the wearable-prompts slice is pre-launch — there is NO
--   write path that can populate these tables under flags-off, so both tables
--   are empty in every environment. A cuid string ("clxxx…") is NOT a valid
--   UUID, so an in-place `ALTER COLUMN id TYPE uuid USING id::uuid` would FAIL on
--   any pre-existing cuid row. Because the tables are provably empty, a clean
--   DROP + recreate is the safest, simplest shape: zero rows are touched, and the
--   recreated tables carry the correct UUID identity + a gen_random_uuid()
--   server-side default (Decision 8 (A), overnight wrap).
--
--   If a future environment is found to hold rows in these tables, this migration
--   MUST be revisited with a data backfill before applying — see R82 tracking
--   issue #404
--   (https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/404).
--   The preflight guard below ENFORCES this: it RAISEs and aborts the whole
--   transaction if either table is non-empty, redirecting the operator to the
--   #404 backfill path instead of silently dropping data.
--
-- Additive-in-effect: no EXISTING table outside this slice is altered; the only
-- tables dropped are the two introduced by 20261217000200_community_wearable_prompts.
-- The original migration is NOT edited (R77 / immutable-history) — this is a
-- new, forward migration ordered strictly after 20261218000000_add_coach_reviewed_at.
--
-- Helper functions come from the v1-1 migration (search_path-hardened by
-- 20261212000000_rls_helper_search_path).
--
-- Rollback: this is itself a re-create; to revert, restore the cuid-id shape via
-- the original 20261217000200 DDL. Only on a confirmed P0; otherwise fix forward.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- Non-empty-environment preflight (PR #405 re-audit N1). The DROP+RECREATE below
-- is empty-table-only (Decision 8 (A)); this guard makes that contract
-- EXECUTABLE. If either table holds rows, abort the transaction loudly and
-- redirect to the #404 backfill path BEFORE any destructive DROP — never lose
-- data silently. to_regclass(...) IS NOT NULL keeps it safe when a table is
-- absent (fresh environment), preserving idempotency.
DO $$
BEGIN
  IF to_regclass('public.community_wearable_prompt_sources') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "community_wearable_prompt_sources" LIMIT 1) THEN
    RAISE EXCEPTION 'community_wearable_prompt_sources is non-empty; stop and follow GitHub issue #404 backfill path before applying 20261219000000';
  END IF;

  IF to_regclass('public.community_wearable_prompts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "community_wearable_prompts" LIMIT 1) THEN
    RAISE EXCEPTION 'community_wearable_prompts is non-empty; stop and follow GitHub issue #404 backfill path before applying 20261219000000';
  END IF;
END $$;

-- Drop child first (FK), then parent. IF EXISTS keeps the migration idempotent.
DROP TABLE IF EXISTS "community_wearable_prompt_sources";
DROP TABLE IF EXISTS "community_wearable_prompts";

-- CreateTable: parent prompt (coach-facing) — UUID id w/ server-side default.
CREATE TABLE "community_wearable_prompts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID NOT NULL,
    "coachId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "metricKey" VARCHAR(64) NOT NULL,
    "promptText" TEXT NOT NULL,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMPTZ(6),
    "actedOnAt" TIMESTAMPTZ(6),

    CONSTRAINT "community_wearable_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: source-audit child — UUID id + UUID promptId FK to match parent.
CREATE TABLE "community_wearable_prompt_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "promptId" UUID NOT NULL,
    "sampleId" UUID NOT NULL,
    "metricKey" VARCHAR(64) NOT NULL,
    "observedValue" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "community_wearable_prompt_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_wearable_prompts_workspaceId_coachId_generatedAt_idx" ON "community_wearable_prompts"("workspaceId", "coachId", "generatedAt");

CREATE INDEX "community_wearable_prompts_workspaceId_coachId_dismissedAt_idx" ON "community_wearable_prompts"("workspaceId", "coachId", "dismissedAt");

-- Concurrent-undismissed guard ONLY: this PARTIAL unique index guarantees at most
-- ONE *active* (non-dismissed) prompt per (coachId, clientId, metricKey). A
-- concurrent insert while an undismissed prompt exists raises P2002 → the service
-- maps it to a 'cooldown' skip. It does NOT, and is not intended to, enforce the
-- full 24h cooldown across the dismissed state (a dismissed row drops out of this
-- partial index). The 24h cooldown across the dismissed state is enforced by the
-- service-side WearablePromptsRepository.isWithinCooldown query, which counts
-- prompts generated within the window regardless of dismissedAt (two-gate design,
-- PR #399 audit F4 / Decision 9 (A)).
CREATE UNIQUE INDEX "community_wearable_prompts_active_cooldown_key" ON "community_wearable_prompts"("coachId", "clientId", "metricKey") WHERE "dismissedAt" IS NULL;

CREATE INDEX "community_wearable_prompt_sources_promptId_idx" ON "community_wearable_prompt_sources"("promptId");

CREATE INDEX "community_wearable_prompt_sources_sampleId_idx" ON "community_wearable_prompt_sources"("sampleId");

-- AddForeignKey: prompt → workspace (scalar ref resolved at SQL layer)
ALTER TABLE "community_wearable_prompts" ADD CONSTRAINT "community_wearable_prompts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_wearable_prompts" ADD CONSTRAINT "community_wearable_prompts_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "community_wearable_prompts" ADD CONSTRAINT "community_wearable_prompts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: source → prompt (the only Prisma-modeled relation, cascade)
ALTER TABLE "community_wearable_prompt_sources" ADD CONSTRAINT "community_wearable_prompt_sources_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "community_wearable_prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: source → real WearableSample (scalar audit ref). RESTRICT so a
-- sample that drove a prompt cannot be silently deleted out from under the audit
-- trail (brief test 4 — every prompt provably references a real sample).
ALTER TABLE "community_wearable_prompt_sources" ADD CONSTRAINT "community_wearable_prompt_sources_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "WearableSample"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Row-Level Security (COACH-ONLY — no member policy) ──────────────────────

ALTER TABLE "community_wearable_prompts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_wearable_prompts" FORCE ROW LEVEL SECURITY;

ALTER TABLE "community_wearable_prompt_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_wearable_prompt_sources" FORCE ROW LEVEL SECURITY;

-- Prompt: workspace coach/owner FOR ALL. NO member SELECT policy — a client can
-- never see a coaching prompt about themselves (coach-only by design).
DROP POLICY IF EXISTS "community_wearable_prompts_coach_all" ON "community_wearable_prompts";
CREATE POLICY "community_wearable_prompts_coach_all" ON "community_wearable_prompts"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspaceId"))
  WITH CHECK (app.is_community_workspace_coach("workspaceId"));

-- Source: visible/writable only when the parent prompt is in a workspace the
-- caller coaches. No member policy (inherits the coach-only posture).
DROP POLICY IF EXISTS "community_wearable_prompt_sources_coach_all" ON "community_wearable_prompt_sources";
CREATE POLICY "community_wearable_prompt_sources_coach_all" ON "community_wearable_prompt_sources"
  FOR ALL TO public
  USING (
    EXISTS (
      SELECT 1 FROM "community_wearable_prompts" p
      WHERE p."id" = "community_wearable_prompt_sources"."promptId"
        AND app.is_community_workspace_coach(p."workspaceId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "community_wearable_prompts" p
      WHERE p."id" = "community_wearable_prompt_sources"."promptId"
        AND app.is_community_workspace_coach(p."workspaceId")
    )
  );

COMMIT;
