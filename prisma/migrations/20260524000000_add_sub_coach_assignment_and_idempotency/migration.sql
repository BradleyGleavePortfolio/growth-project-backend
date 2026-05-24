-- Phase 11 — Sub-coach management hardening.
--
-- Additive only. Existing rows stay valid. No backfill required for the
-- assignment table: existing User.coach_id rows pointing at sub-coaches
-- (created by the earlier draft of this PR before this migration shipped)
-- will continue to function until the application repoints them; the
-- service layer reads from SubCoachAssignment going forward.
--
-- 1. SubCoachAssignment — overlay join table. User.coach_id keeps
--    pointing at the head coach forever; sub-coach delegation lives
--    here so existing head-coach roster / messaging / console queries
--    that scope by `coach_id = headCoachId` keep returning the full
--    team roster.
--
--    Partial unique index enforces "at most one open assignment per
--    client at a time" at the DB layer (defense in depth alongside the
--    serializable transaction in SubCoachReassignService).
--
-- 2. SubCoachMutationIdempotency — per-actor idempotency table for the
--    POST /sub-coaches/:id/assign-client and reassign-client endpoints.
--    Unique on (actor_id, idempotency_key); first-writer-wins, retries
--    read the stored response back.

-- 1. SubCoachAssignment ---------------------------------------------------
CREATE TABLE "SubCoachAssignment" (
    "id"              TEXT NOT NULL,
    "head_coach_id"   TEXT NOT NULL,
    "sub_coach_id"    TEXT NOT NULL,
    "client_id"       TEXT NOT NULL,
    "assigned_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at"   TIMESTAMP(3),
    "assigned_by_id"  TEXT,
    "reason"          TEXT,
    CONSTRAINT "SubCoachAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SubCoachAssignment_head_coach_id_idx"
    ON "SubCoachAssignment"("head_coach_id");
CREATE INDEX "SubCoachAssignment_sub_coach_id_unassigned_at_idx"
    ON "SubCoachAssignment"("sub_coach_id", "unassigned_at");
CREATE INDEX "SubCoachAssignment_client_id_unassigned_at_idx"
    ON "SubCoachAssignment"("client_id", "unassigned_at");
-- Partial unique: at most one open (unassigned_at IS NULL) row per client.
CREATE UNIQUE INDEX "SubCoachAssignment_one_open_per_client"
    ON "SubCoachAssignment"("client_id")
    WHERE "unassigned_at" IS NULL;

-- 2. SubCoachMutationIdempotency ------------------------------------------
CREATE TABLE "SubCoachMutationIdempotency" (
    "id"               TEXT NOT NULL,
    "actor_id"         TEXT NOT NULL,
    "idempotency_key"  TEXT NOT NULL,
    "action"           TEXT NOT NULL,
    "request_hash"     TEXT,
    "response"         JSONB NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubCoachMutationIdempotency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubCoachMutationIdempotency_actor_key"
    ON "SubCoachMutationIdempotency"("actor_id", "idempotency_key");
CREATE INDEX "SubCoachMutationIdempotency_created_at_idx"
    ON "SubCoachMutationIdempotency"("created_at");
