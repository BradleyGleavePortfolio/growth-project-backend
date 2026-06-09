-- Roman Phase 1 — Chat MVP backend (sessions + messages + RLS).
--
-- Additive-only migration. No destructive operations performed. This migration
-- adds:
--   * enum  "RomanSurface"      ('client', 'coach')
--   * enum  "RomanMessageRole"  ('user', 'roman')
--   * table "RomanSession"      (one active session per (user_id, surface, day_key))
--   * table "RomanMessage"      (append-only chat turns; soft-branchable)
--   * the indexes + FKs Prisma derives from the schema
--   * FULL Row-Level Security (ENABLE + FORCE) on BOTH new tables.
--
-- No pre-existing table, column, type, index, or constraint is altered or
-- dropped. The only edit to an existing object is the additive back-relation
-- on public."User" (roman_sessions / roman_messages), which is a Prisma-level
-- virtual relation and emits no DDL against the User table.
--
-- ───────────────────────────────────────────────────────────────────────────
-- RLS POLICY CITATION (HECTACORN security gate — ENGINEERING_RULES §2)
-- ───────────────────────────────────────────────────────────────────────────
-- Both tables are owner-scoped to the authenticated user via the canonical
-- app.* helpers (PR-RLS-FN, migration 20261212000000_rls_helper_search_path):
--   app.current_user_id()  → NestJS-set session GUC 'app.current_user_id'
--   app.is_owner()         → true when the RLS context is an authenticated owner
-- These read the GUCs set by RlsContextInterceptor (set_config(..., true),
-- transaction-scoped, pgbouncer-safe). anon (no GUCs) resolves to zero rows.
--
-- Primitive A (service_role bypass) is provided on every table for server-side
-- jobs/migrations/seeds, mirroring the B5 contracts RLS migration
-- (20261215000200_contracts_rls).
--
-- RomanSession policies:
--   p_romansession_service_role_all  service_role FOR ALL  USING/CHECK true
--   p_romansession_select            SELECT  USING  (owner OR user_id = self)
--   p_romansession_insert            INSERT  CHECK  (owner OR user_id = self)
--   p_romansession_update            UPDATE  USING+CHECK (owner OR user_id = self)
--     (UPDATE covers last_activity_at / message_count / soft-delete deleted_at)
--
-- RomanMessage policies (defence-in-depth: BOTH the denormalised user_id AND
-- the parent-session.user_id must resolve to the caller — neither alone is
-- trusted, so a forged user_id with a foreign session_id is rejected, and a
-- correct session_id with a forged user_id is rejected too):
--   p_romanmessage_service_role_all  service_role FOR ALL  USING/CHECK true
--   p_romanmessage_select            SELECT  USING  (owner OR (user_id = self
--                                      AND session.user_id = self))
--   p_romanmessage_insert            INSERT  CHECK  (owner OR (user_id = self
--                                      AND session.user_id = self))
--
-- Rollback: DROP the policies created here and, only on a confirmed P0 outage,
-- ALTER TABLE <t> DISABLE ROW LEVEL SECURITY. Otherwise fix forward. Never edit
-- a shipped migration file (ENGINEERING_RULES §2).
-- ───────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "RomanSurface" AS ENUM ('client', 'coach');

-- CreateEnum
CREATE TYPE "RomanMessageRole" AS ENUM ('user', 'roman');

-- CreateTable
CREATE TABLE "RomanSession" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" "RomanSurface" NOT NULL,
    "day_key" TEXT NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quips_in_session" INTEGER NOT NULL DEFAULT 0,
    "exclamation_used" BOOLEAN NOT NULL DEFAULT false,
    "subject_context_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "RomanSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RomanMessage" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "RomanMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "model_id" TEXT,
    "interrupted" BOOLEAN NOT NULL DEFAULT false,
    "parent_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RomanMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RomanSession_user_id_surface_created_at_idx" ON "RomanSession"("user_id", "surface", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RomanSession_user_id_surface_day_key_key" ON "RomanSession"("user_id", "surface", "day_key");

-- CreateIndex
CREATE INDEX "RomanMessage_session_id_created_at_idx" ON "RomanMessage"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "RomanMessage_user_id_idx" ON "RomanMessage"("user_id");

-- CreateIndex
CREATE INDEX "RomanMessage_parent_message_id_idx" ON "RomanMessage"("parent_message_id");

-- AddForeignKey
ALTER TABLE "RomanSession" ADD CONSTRAINT "RomanSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RomanMessage" ADD CONSTRAINT "RomanMessage_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "RomanSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RomanMessage" ADD CONSTRAINT "RomanMessage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RomanMessage" ADD CONSTRAINT "RomanMessage_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "RomanMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY (HECTACORN QUALITY) — see header citation above.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 1) RomanSession — owner-self scope (user_id = app.current_user_id()) ────
ALTER TABLE "RomanSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RomanSession" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_romansession_service_role_all" ON "RomanSession";
CREATE POLICY "p_romansession_service_role_all" ON "RomanSession" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_romansession_service_role_all" ON "RomanSession" IS 'Primitive A: service_role bypass for server-side jobs/migrations/seeds.';

DROP POLICY IF EXISTS "p_romansession_select" ON "RomanSession";
CREATE POLICY "p_romansession_select" ON "RomanSession" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_romansession_select" ON "RomanSession" IS 'Owner-self read: a user reads only their own Roman sessions (user_id = self); platform owner reads all. anon (NULL current_user_id) sees zero. Cross-user reads are denied (IDOR).';

DROP POLICY IF EXISTS "p_romansession_insert" ON "RomanSession";
CREATE POLICY "p_romansession_insert" ON "RomanSession" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_romansession_insert" ON "RomanSession" IS 'Owner-self write: a user may INSERT only sessions they own (user_id = self). A forged user_id is rejected by the WITH CHECK.';

DROP POLICY IF EXISTS "p_romansession_update" ON "RomanSession";
CREATE POLICY "p_romansession_update" ON "RomanSession" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_romansession_update" ON "RomanSession" IS 'Owner-self update: covers last_activity_at / message_count / quip+exclamation counters / soft-delete (deleted_at). CHECK prevents re-owning a row to another user_id.';

-- ─── 2) RomanMessage — owner-self scope, defence-in-depth via session join ───
ALTER TABLE "RomanMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RomanMessage" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_romanmessage_service_role_all" ON "RomanMessage";
CREATE POLICY "p_romanmessage_service_role_all" ON "RomanMessage" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_romanmessage_service_role_all" ON "RomanMessage" IS 'Primitive A: service_role bypass for server-side jobs/migrations/seeds.';

DROP POLICY IF EXISTS "p_romanmessage_select" ON "RomanMessage";
CREATE POLICY "p_romanmessage_select" ON "RomanMessage" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id() AND EXISTS (SELECT 1 FROM public."RomanSession" rs WHERE rs."id" = "RomanMessage"."session_id" AND rs."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_romanmessage_select" ON "RomanMessage" IS 'Owner-self read with defence-in-depth: BOTH the denormalised user_id AND the parent session.user_id must equal the caller. A message whose session belongs to another user is invisible even if its user_id column were forged. anon sees zero.';

DROP POLICY IF EXISTS "p_romanmessage_insert" ON "RomanMessage";
CREATE POLICY "p_romanmessage_insert" ON "RomanMessage" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id() AND EXISTS (SELECT 1 FROM public."RomanSession" rs WHERE rs."id" = "RomanMessage"."session_id" AND rs."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_romanmessage_insert" ON "RomanMessage" IS 'Owner-self write with defence-in-depth: a user may INSERT a message only into their OWN session and only with user_id = self. Forging either the user_id or appending to a foreign session is rejected by the WITH CHECK.';
