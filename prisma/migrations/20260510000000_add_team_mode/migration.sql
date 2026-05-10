-- Team Mode foundation — sub-coach assignments + curated audit events.
--
-- ADR-0001 §10 resolutions (locked 2026-05-10):
--   Q1 — Pro tier: each staff seat is a paid Stripe quantity line.
--        Enterprise tier: included unlimited.
--        Growth tier: feature gated (controllers return 403).
--   Q2 — Sub-coach is many-to-many of head coaches, capped at 2.
--        Enforced by the trigger below + the service-layer guard.
--   Q3 — Removal auto-reassigns the sub-coach's clients to the
--        initiating head coach in a single transaction (service-layer).
--   Q4 — Audit log is a curated event ledger, not a CRUD firehose.
--        See team_audit_event_kind enum below for the 15 event_kinds.
--   Q5 — Sub-coaches may invite clients directly. Attribution is
--        carried by InviteCode.invited_by_user_id (added below).
--   Q6 — Tier gate at controller level via existing tier resolver.
--
-- Reversibility (apply manually if rolling back):
--   DROP TABLE "TeamAuditEvent" CASCADE;
--   DROP TABLE "TeamSubCoachAssignment" CASCADE;
--   DROP FUNCTION enforce_subcoach_head_cap() CASCADE;
--   DROP TYPE "TeamAuditEventKind";
--   ALTER TABLE "InviteCode" DROP COLUMN "invited_by_user_id";

-- ──────────────────────────────────────────────────────────────────
-- 1. InviteCode — sub-coach attribution column (additive, nullable)
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE "InviteCode"
    ADD COLUMN "invited_by_user_id" TEXT;

ALTER TABLE "InviteCode"
    ADD CONSTRAINT "InviteCode_invited_by_user_id_fkey"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "InviteCode_invited_by_user_id_idx"
    ON "InviteCode"("invited_by_user_id");

-- ──────────────────────────────────────────────────────────────────
-- 2. TeamAuditEventKind enum (15 curated values, not a firehose)
-- ──────────────────────────────────────────────────────────────────

CREATE TYPE "TeamAuditEventKind" AS ENUM (
    'session_held',
    'message_sent',
    'plan_assigned',
    'checkin_logged',
    'macro_target_set',
    'meal_plan_assigned',
    'workout_assigned',
    'client_progress_logged',
    'sub_coach_assigned',
    'sub_coach_removed',
    'client_reassigned',
    'invite_sent_by_sub_coach',
    'tier_changed',
    'staff_seat_added',
    'staff_seat_removed'
);

-- ──────────────────────────────────────────────────────────────────
-- 3. TeamSubCoachAssignment
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE "TeamSubCoachAssignment" (
    "id"                          TEXT         NOT NULL,
    "head_coach_id"               TEXT         NOT NULL,
    "sub_coach_id"                TEXT         NOT NULL,
    "stripe_subscription_item_id" TEXT,
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at"                 TIMESTAMP(3),

    CONSTRAINT "TeamSubCoachAssignment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TeamSubCoachAssignment"
    ADD CONSTRAINT "TeamSubCoachAssignment_head_coach_id_fkey"
    FOREIGN KEY ("head_coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamSubCoachAssignment"
    ADD CONSTRAINT "TeamSubCoachAssignment_sub_coach_id_fkey"
    FOREIGN KEY ("sub_coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "TeamSubCoachAssignment_head_coach_id_sub_coach_id_key"
    ON "TeamSubCoachAssignment"("head_coach_id", "sub_coach_id");

CREATE INDEX "TeamSubCoachAssignment_head_coach_id_archived_at_idx"
    ON "TeamSubCoachAssignment"("head_coach_id", "archived_at");

CREATE INDEX "TeamSubCoachAssignment_sub_coach_id_archived_at_idx"
    ON "TeamSubCoachAssignment"("sub_coach_id", "archived_at");

-- "At most 2 head coaches per sub-coach" cap. Enforced both in the
-- service layer (so we can return a clean 409 with an explanatory
-- envelope) AND here in a trigger so a concurrent double-write
-- cannot exceed the cap. Counts only non-archived rows.
CREATE OR REPLACE FUNCTION enforce_subcoach_head_cap()
RETURNS TRIGGER AS $$
DECLARE
    head_count INTEGER;
BEGIN
    IF NEW.archived_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT COUNT(*) INTO head_count
    FROM "TeamSubCoachAssignment"
    WHERE "sub_coach_id" = NEW."sub_coach_id"
      AND "archived_at" IS NULL
      AND "id" <> NEW."id";
    IF head_count >= 2 THEN
        RAISE EXCEPTION 'sub_coach_head_cap_exceeded: sub-coach % already assigned under 2 head coaches', NEW."sub_coach_id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_subcoach_head_cap
BEFORE INSERT OR UPDATE ON "TeamSubCoachAssignment"
FOR EACH ROW EXECUTE FUNCTION enforce_subcoach_head_cap();

-- ──────────────────────────────────────────────────────────────────
-- 4. TeamAuditEvent
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE "TeamAuditEvent" (
    "id"               TEXT                 NOT NULL,
    "head_coach_id"    TEXT                 NOT NULL,
    "actor_user_id"    TEXT                 NOT NULL,
    "target_client_id" TEXT,
    "event_kind"       "TeamAuditEventKind" NOT NULL,
    "summary"          TEXT                 NOT NULL,
    "metadata"         JSONB,
    "occurred_at"      TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamAuditEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TeamAuditEvent"
    ADD CONSTRAINT "TeamAuditEvent_head_coach_id_fkey"
    FOREIGN KEY ("head_coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamAuditEvent"
    ADD CONSTRAINT "TeamAuditEvent_target_client_id_fkey"
    FOREIGN KEY ("target_client_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TeamAuditEvent_head_coach_id_occurred_at_idx"
    ON "TeamAuditEvent"("head_coach_id", "occurred_at");

CREATE INDEX "TeamAuditEvent_head_coach_id_event_kind_occurred_at_idx"
    ON "TeamAuditEvent"("head_coach_id", "event_kind", "occurred_at");

CREATE INDEX "TeamAuditEvent_target_client_id_occurred_at_idx"
    ON "TeamAuditEvent"("target_client_id", "occurred_at");
