-- ChurnIntervention — Coach Command Center re-engagement message lifecycle.
--
-- Stores AI-drafted re-engagement messages produced by the tap→draft→
-- approve→send flow in the Coach Command Center. Each row represents
-- one Anthropic draft for one (coach, client) pair, plus the send /
-- dismiss outcome.
--
-- RLS doctrine: SERVER-ONLY table. ENABLE + FORCE RLS so the row filter
-- applies to all roles including the table owner. A single
-- `USING (coach_id = auth.uid())` policy on coach_id covers the only
-- legitimate direct-client access path (the coach reading their own
-- drafts via a future Supabase client) — for now NestJS service-role
-- writes are the only access path and they bypass RLS naturally.
--
-- Idempotency: `idempotency_key` is the mobile-generated UUID. A unique
-- index enforces server-side dedup on retries (R19).
--
-- Indexes:
--   * coach_id, status, created_at DESC — coach inbox list views
--   * client_id, created_at DESC       — per-client history drawer
--   * coach_id, client_id              — coach's drafts for a given client

CREATE TABLE IF NOT EXISTS "ChurnIntervention" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "draft_text" TEXT NOT NULL,
    "edited_text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "alert_id" TEXT,
    "risk_score_at_draft" DOUBLE PRECISION,
    "top_factor" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "send_idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "nudge_id" TEXT,

    CONSTRAINT "ChurnIntervention_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "ChurnIntervention_idempotency_key_key" ON "ChurnIntervention"("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "ChurnIntervention_send_idempotency_key_key" ON "ChurnIntervention"("send_idempotency_key");
CREATE INDEX IF NOT EXISTS "ChurnIntervention_coach_id_status_created_at_idx" ON "ChurnIntervention"("coach_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ChurnIntervention_client_id_created_at_idx" ON "ChurnIntervention"("client_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ChurnIntervention_coach_id_client_id_idx" ON "ChurnIntervention"("coach_id", "client_id");

-- Foreign keys
ALTER TABLE "ChurnIntervention"
    ADD CONSTRAINT "ChurnIntervention_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChurnIntervention"
    ADD CONSTRAINT "ChurnIntervention_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: server-only table. NestJS uses the Supabase
-- service-role connection which bypasses RLS; this hard-denies any
-- direct anon/auth client read until we explicitly add a Supabase
-- client read path.
ALTER TABLE "ChurnIntervention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChurnIntervention" FORCE ROW LEVEL SECURITY;

-- Server-only deny-all policy. This table is written exclusively via
-- the NestJS service-role connection which bypasses RLS. Any direct
-- Supabase anon/auth client INSERT/UPDATE/DELETE/SELECT is denied so
-- that server-side validation, idempotency, status transitions,
-- Anthropic generation, and nudge consistency cannot be bypassed.
-- If a future feature needs direct coach reads, add a narrow
-- `FOR SELECT` policy here and keep writes denied.
DROP POLICY IF EXISTS "ChurnIntervention_coach_rls" ON "ChurnIntervention";
DROP POLICY IF EXISTS "churn_intervention_coach_own" ON "ChurnIntervention";
CREATE POLICY "ChurnIntervention_server_only"
    ON "ChurnIntervention"
    FOR ALL
    USING (false)
    WITH CHECK (false);
