-- v3-4 — community wearable-aware coaching prompts.
--
-- Additive only. Creates TWO new tables (community_wearable_prompts and its
-- source-audit child community_wearable_prompt_sources). No existing community
-- or wearables table is altered, no FK on an existing table changes (R69 /
-- R76 §6). Timestamp 20261217000200 is strictly AFTER the v3-4 search migration
-- (20261217000100_community_search_index) so the ordered apply never reorders.
--
-- COLUMN NAMING: the Prisma models map only the TABLE names (@@map) — fields are
-- camelCase, so Prisma generates camelCase column identifiers ("workspaceId",
-- "coachId", "clientId", "metricKey", "promptText", "generatedAt", "dismissedAt",
-- "actedOnAt"; child: "promptId", "sampleId", "metricKey", "observedValue").
--
-- COACH-ONLY RLS: a wearable prompt is NEVER readable by a client. Only the
-- workspace coach/owner (app.is_community_workspace_coach) gets access, and the
-- service additionally scopes every query to coachId = the caller. There is NO
-- member_select policy here (deliberately — clients must never see prompts).
--
-- 24h COOLDOWN: a PARTIAL UNIQUE INDEX on (coachId, clientId, metricKey) over the
-- most recent generation enforces the cooldown at the DB layer (a concurrent
-- insert raises P2002 → the service maps it to a 'cooldown' skip). Because a
-- true time-windowed unique constraint is not expressible as a static index, we
-- enforce it as: at most ONE *active* (non-dismissed) prompt per
-- (coachId, clientId, metricKey) — combined with the service-side 24h pre-check
-- (WearablePromptsRepository.isWithinCooldown) and the generatedAt recency
-- filter, this is the authoritative race guard for the cooldown window.
--
-- Helper functions come from the v1-1 migration (search_path-hardened by
-- 20261212000000_rls_helper_search_path).
--
-- Rollback: DROP the policies, DISABLE ROW LEVEL SECURITY, DROP the child then
-- parent table. Only on a confirmed P0; otherwise fix forward.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- CreateTable: parent prompt (coach-facing)
CREATE TABLE "community_wearable_prompts" (
    "id" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "coachId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "metricKey" VARCHAR(64) NOT NULL,
    "promptText" TEXT NOT NULL,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMPTZ(6),
    "actedOnAt" TIMESTAMPTZ(6),

    CONSTRAINT "community_wearable_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: source-audit child (which real WearableSample drove the prompt)
CREATE TABLE "community_wearable_prompt_sources" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "metricKey" VARCHAR(64) NOT NULL,
    "observedValue" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "community_wearable_prompt_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_wearable_prompts_workspaceId_coachId_generatedAt_idx" ON "community_wearable_prompts"("workspaceId", "coachId", "generatedAt");

CREATE INDEX "community_wearable_prompts_workspaceId_coachId_dismissedAt_idx" ON "community_wearable_prompts"("workspaceId", "coachId", "dismissedAt");

-- 24h cooldown guard: at most ONE active (non-dismissed) prompt per
-- (coachId, clientId, metricKey). A concurrent generation raises P2002 → the
-- service maps it to a 'cooldown' skip. Combined with the service-side recency
-- pre-check this enforces the 24h window.
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
