-- Phase 11 follow-up: RLS, denial policies, and foreign keys for the
-- sub-coach overlay tables introduced in
-- 20260524000000_add_sub_coach_assignment_and_idempotency.
--
-- 1. Enable + force Row Level Security on both tables (F2).
-- 2. Add restrictive DENY policies for the `anon` and `authenticated`
--    Supabase roles. All real access happens through the NestJS service
--    role (which bypasses RLS by default on Supabase), so direct PostgREST
--    clients see nothing.
-- 3. Add foreign keys to User for every join column. ON DELETE RESTRICT
--    so user deletes fail loudly rather than orphaning authorization rows.
--    `assigned_by_id` uses SET NULL because the actor may be removed
--    while the historical assignment must remain auditable.

-- ─── 1. SubCoachAssignment RLS ────────────────────────────────────────────
ALTER TABLE "SubCoachAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubCoachAssignment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "deny_all_anon_subcoach_assignment"
    ON "SubCoachAssignment"
    AS RESTRICTIVE
    FOR ALL
    TO anon
    USING (false);

CREATE POLICY "deny_all_authenticated_subcoach_assignment"
    ON "SubCoachAssignment"
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING (false);

-- ─── 2. SubCoachMutationIdempotency RLS ───────────────────────────────────
ALTER TABLE "SubCoachMutationIdempotency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubCoachMutationIdempotency" FORCE ROW LEVEL SECURITY;

CREATE POLICY "deny_all_anon_subcoach_idempotency"
    ON "SubCoachMutationIdempotency"
    AS RESTRICTIVE
    FOR ALL
    TO anon
    USING (false);

CREATE POLICY "deny_all_authenticated_subcoach_idempotency"
    ON "SubCoachMutationIdempotency"
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING (false);

-- ─── 3. Foreign keys (SubCoachAssignment) ─────────────────────────────────
ALTER TABLE "SubCoachAssignment"
    ADD CONSTRAINT "SubCoachAssignment_head_coach_id_fkey"
    FOREIGN KEY ("head_coach_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubCoachAssignment"
    ADD CONSTRAINT "SubCoachAssignment_sub_coach_id_fkey"
    FOREIGN KEY ("sub_coach_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubCoachAssignment"
    ADD CONSTRAINT "SubCoachAssignment_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubCoachAssignment"
    ADD CONSTRAINT "SubCoachAssignment_assigned_by_id_fkey"
    FOREIGN KEY ("assigned_by_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 4. Foreign keys (SubCoachMutationIdempotency) ────────────────────────
ALTER TABLE "SubCoachMutationIdempotency"
    ADD CONSTRAINT "SubCoachMutationIdempotency_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 5. Idempotency status + updated_at (atomic claim support) ────────────
ALTER TABLE "SubCoachMutationIdempotency"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE "SubCoachMutationIdempotency"
    ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
