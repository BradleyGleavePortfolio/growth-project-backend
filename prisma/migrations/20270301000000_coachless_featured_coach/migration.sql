-- A1-COACHLESS — coachless Home featured-coach config, coach-code redemption
-- ledger and the scripted Roman card state.
--
-- Additive-only. Creates three tables, their indexes, FKs, CHECK constraints
-- and RLS. No existing table, column, index or constraint is altered or
-- dropped. The User / CoachPackage back-relations in schema.prisma are
-- Prisma-virtual and emit no DDL.
--
-- RLS POLICY CITATION (ENGINEERING_RULES §2), helpers from
-- 20261212000000_rls_helper_search_path / 20260704000000_rls01_helper_searchpath_hibp:
--   app.current_user_id()  session GUC set by RlsContextInterceptor
--   app.is_owner()         platform owner context
--
-- FeaturedCoachConfig (platform singleton; owner-edited offer copy):
--   p_featuredcoachconfig_service_role_all  service_role ALL (server reads, owner PUT)
--   p_featuredcoachconfig_select_owner      SELECT platform owner only
--   no public INSERT/UPDATE/DELETE (written by the owner route through the server)
--   RESTRICTIVE anon deny-all
--   Clients never read this table directly: GET /coachless/home serves a
--   projection of it (no updated_by, no caps they do not need).
--
-- CoachCodeRedemption (idempotency ledger + attempt record; tenancy: self):
--   p_coachcoderedemption_service_role_all  service_role ALL
--   p_coachcoderedemption_select_self       SELECT the redeeming user only
--   no public INSERT/UPDATE/DELETE; no owner or coach branch (a coach never
--   reads another user's redemption attempts through RLS)
--   RESTRICTIVE anon deny-all
--
-- CoachlessPromptState (Roman card frequency cap + persisted "Not now"):
--   p_coachlesspromptstate_service_role_all  service_role ALL
--   p_coachlesspromptstate_select_self       SELECT the user only
--   no public INSERT/UPDATE/DELETE
--   RESTRICTIVE anon deny-all
--
-- Account erasure: CoachCodeRedemption and CoachlessPromptState cascade with
-- the User row; FeaturedCoachConfig.coach_user_id is SET NULL (the offer
-- turns itself off because no coach resolves).
--
-- Rollback: down.sql drops the three tables (loses the owner's offer copy and
-- the redemption ledger; only for a confirmed pre-launch defect). Otherwise
-- fix forward.

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "FeaturedCoachConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "coach_user_id" TEXT,
    "code" TEXT,
    "package_id" TEXT,
    "banner_title" TEXT NOT NULL,
    "offer_text" TEXT,
    "roman_pitch_text" TEXT,
    "accepting_clients" BOOLEAN NOT NULL DEFAULT false,
    "roman_enabled" BOOLEAN NOT NULL DEFAULT false,
    "roman_min_hours_between" INTEGER NOT NULL DEFAULT 24,
    "roman_max_per_week" INTEGER NOT NULL DEFAULT 3,
    "roman_snooze_days" INTEGER NOT NULL DEFAULT 14,
    "roman_max_not_now" INTEGER NOT NULL DEFAULT 2,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeaturedCoachConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachCodeRedemption" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "outcome" TEXT,
    "coach_id" TEXT,
    "http_status" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachCodeRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachlessPromptState" (
    "user_id" TEXT NOT NULL,
    "roman_seen_count" INTEGER NOT NULL DEFAULT 0,
    "roman_window_started_at" TIMESTAMP(3),
    "roman_last_seen_at" TIMESTAMP(3),
    "roman_not_now_count" INTEGER NOT NULL DEFAULT 0,
    "roman_not_now_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachlessPromptState_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "CoachCodeRedemption_user_id_created_at_idx" ON "CoachCodeRedemption"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "CoachCodeRedemption_user_id_idempotency_key_key" ON "CoachCodeRedemption"("user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "FeaturedCoachConfig" ADD CONSTRAINT "FeaturedCoachConfig_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedCoachConfig" ADD CONSTRAINT "FeaturedCoachConfig_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "CoachPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachCodeRedemption" ADD CONSTRAINT "CoachCodeRedemption_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachlessPromptState" ADD CONSTRAINT "CoachlessPromptState_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints (not modelled by Prisma; schema parity ignores them).
ALTER TABLE "FeaturedCoachConfig" ADD CONSTRAINT "FeaturedCoachConfig_singleton_check" CHECK ("id" = 'default');
ALTER TABLE "FeaturedCoachConfig" ADD CONSTRAINT "FeaturedCoachConfig_text_check" CHECK (
    length("banner_title") BETWEEN 1 AND 120
    AND ("offer_text" IS NULL OR length("offer_text") BETWEEN 1 AND 200)
    AND ("roman_pitch_text" IS NULL OR length("roman_pitch_text") BETWEEN 1 AND 400)
    AND ("code" IS NULL OR "code" ~ '^[A-Za-z0-9-]{3,32}$')
);
ALTER TABLE "FeaturedCoachConfig" ADD CONSTRAINT "FeaturedCoachConfig_caps_check" CHECK (
    "roman_min_hours_between" BETWEEN 1 AND 720
    AND "roman_max_per_week" BETWEEN 1 AND 14
    AND "roman_snooze_days" BETWEEN 1 AND 365
    AND "roman_max_not_now" BETWEEN 1 AND 10
);
ALTER TABLE "CoachCodeRedemption" ADD CONSTRAINT "CoachCodeRedemption_status_check" CHECK ("status" IN ('in_progress', 'completed', 'failed'));
ALTER TABLE "CoachCodeRedemption" ADD CONSTRAINT "CoachCodeRedemption_key_check" CHECK (
    "idempotency_key" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
);
ALTER TABLE "CoachlessPromptState" ADD CONSTRAINT "CoachlessPromptState_counts_check" CHECK ("roman_seen_count" >= 0 AND "roman_not_now_count" >= 0);

-- ─── FeaturedCoachConfig ──────────────────────────────────────────────
ALTER TABLE "FeaturedCoachConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeaturedCoachConfig" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "FeaturedCoachConfig" FROM anon;

DROP POLICY IF EXISTS "p_featuredcoachconfig_service_role_all" ON "FeaturedCoachConfig";
CREATE POLICY "p_featuredcoachconfig_service_role_all" ON "FeaturedCoachConfig" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_featuredcoachconfig_service_role_all" ON "FeaturedCoachConfig" IS 'Primitive A: service_role access for the server read path and the audited owner PUT.';

DROP POLICY IF EXISTS "p_featuredcoachconfig_select_owner" ON "FeaturedCoachConfig";
CREATE POLICY "p_featuredcoachconfig_select_owner" ON "FeaturedCoachConfig" AS PERMISSIVE FOR SELECT TO public USING (app.is_owner());
COMMENT ON POLICY "p_featuredcoachconfig_select_owner" ON "FeaturedCoachConfig" IS 'Platform owner reads the featured-coach config; clients read a server projection only. No public writes.';

DROP POLICY IF EXISTS "p_featuredcoachconfig_anon_deny" ON "FeaturedCoachConfig";
CREATE POLICY "p_featuredcoachconfig_anon_deny" ON "FeaturedCoachConfig" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "p_featuredcoachconfig_anon_deny" ON "FeaturedCoachConfig" IS 'RESTRICTIVE deny-all: anon never reads or writes this table.';

-- ─── CoachCodeRedemption ──────────────────────────────────────────────
ALTER TABLE "CoachCodeRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachCodeRedemption" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CoachCodeRedemption" FROM anon;

DROP POLICY IF EXISTS "p_coachcoderedemption_service_role_all" ON "CoachCodeRedemption";
CREATE POLICY "p_coachcoderedemption_service_role_all" ON "CoachCodeRedemption" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachcoderedemption_service_role_all" ON "CoachCodeRedemption" IS 'Primitive A: service_role access for the redemption writer and account erasure.';

DROP POLICY IF EXISTS "p_coachcoderedemption_select_self" ON "CoachCodeRedemption";
CREATE POLICY "p_coachcoderedemption_select_self" ON "CoachCodeRedemption" AS PERMISSIVE FOR SELECT TO public USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());
COMMENT ON POLICY "p_coachcoderedemption_select_self" ON "CoachCodeRedemption" IS 'Self-only read: a user reads only their own redemption attempts. No owner, coach or sub-coach branch. No public writes.';

DROP POLICY IF EXISTS "p_coachcoderedemption_anon_deny" ON "CoachCodeRedemption";
CREATE POLICY "p_coachcoderedemption_anon_deny" ON "CoachCodeRedemption" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "p_coachcoderedemption_anon_deny" ON "CoachCodeRedemption" IS 'RESTRICTIVE deny-all: anon never reads or writes this table.';

-- ─── CoachlessPromptState ──────────────────────────────────────────────
ALTER TABLE "CoachlessPromptState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachlessPromptState" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CoachlessPromptState" FROM anon;

DROP POLICY IF EXISTS "p_coachlesspromptstate_service_role_all" ON "CoachlessPromptState";
CREATE POLICY "p_coachlesspromptstate_service_role_all" ON "CoachlessPromptState" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachlesspromptstate_service_role_all" ON "CoachlessPromptState" IS 'Primitive A: service_role access for the prompt-state writer and account erasure.';

DROP POLICY IF EXISTS "p_coachlesspromptstate_select_self" ON "CoachlessPromptState";
CREATE POLICY "p_coachlesspromptstate_select_self" ON "CoachlessPromptState" AS PERMISSIVE FOR SELECT TO public USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());
COMMENT ON POLICY "p_coachlesspromptstate_select_self" ON "CoachlessPromptState" IS 'Self-only read: a user reads only their own Roman card state. No public writes.';

DROP POLICY IF EXISTS "p_coachlesspromptstate_anon_deny" ON "CoachlessPromptState";
CREATE POLICY "p_coachlesspromptstate_anon_deny" ON "CoachlessPromptState" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "p_coachlesspromptstate_anon_deny" ON "CoachlessPromptState" IS 'RESTRICTIVE deny-all: anon never reads or writes this table.';
