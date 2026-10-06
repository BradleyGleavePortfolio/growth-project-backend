-- Roman approve-to-adjust (lane S-ROMAN-DATA, step 2).
--
-- Additive only: two new tables, one trigger function, one trigger, RLS.
-- No shipped migration is altered. Reverse: down.sql.
--
-- "WorkoutAdjustmentProposal": a deterministic recovery rule proposes a
-- change to ONE client's next workout (its MWB-1 assignment snapshot, never
-- the shared plan). The coach approves, edits or dismisses it; an applied
-- change can be undone inside a short window. One proposal per
-- (assignment, rule): a dismissed proposal is never raised again for the
-- same workout.
--
-- "WorkoutAdjustmentEvent": APPEND-ONLY audit trail of every state change
-- (who, what, when, before/after set counts). A BEFORE UPDATE trigger rejects
-- every UPDATE for every role. Rows leave only with the assignment (FK
-- cascade, which covers account erasure) or by a service_role DELETE.
--
-- RLS on both tables:
--   * service_role: full access (Primitive A; the backend serving role);
--   * SELECT for other principals: the proposing coach only
--     (coach_id = app.current_user_id()). No client branch (this is a coach
--     tool), no app.is_owner() branch, no anon;
--   * no INSERT / UPDATE / DELETE policy for non-service principals;
--   * anon: RESTRICTIVE deny-all plus REVOKE.

SET lock_timeout = '5s';

-- =====================================================================
-- 1) Tables
-- =====================================================================
CREATE TABLE "WorkoutAdjustmentProposal" (
    "id"                  TEXT NOT NULL,
    "coach_id"            TEXT NOT NULL,
    "client_id"           TEXT NOT NULL,
    "assignment_id"       TEXT NOT NULL,
    "rule_key"            TEXT NOT NULL,
    "rule_version"        INTEGER NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'pending',
    "severity"            TEXT NOT NULL,
    "signals"             JSONB NOT NULL,
    "proposed_change"     JSONB NOT NULL,
    "applied_change"      JSONB,
    "base_fingerprint"    TEXT NOT NULL,
    "applied_fingerprint" TEXT,
    "before_exercises"    JSONB,
    "roman_text"          TEXT NOT NULL,
    "decided_by_id"       TEXT,
    "decided_at"          TIMESTAMP(3),
    "dismiss_reason"      TEXT,
    "undo_until"          TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkoutAdjustmentProposal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkoutAdjustmentProposal_status_check" CHECK (
        "status" IN ('pending', 'approved', 'edited', 'dismissed', 'undone', 'expired', 'withdrawn')
    ),
    CONSTRAINT "WorkoutAdjustmentProposal_severity_check" CHECK ("severity" IN ('moderate', 'marked'))
);

CREATE UNIQUE INDEX "WorkoutAdjustmentProposal_assignment_id_rule_key_key"
    ON "WorkoutAdjustmentProposal"("assignment_id", "rule_key");
CREATE INDEX "WorkoutAdjustmentProposal_coach_id_status_created_at_idx"
    ON "WorkoutAdjustmentProposal"("coach_id", "status", "created_at");
CREATE INDEX "WorkoutAdjustmentProposal_client_id_created_at_idx"
    ON "WorkoutAdjustmentProposal"("client_id", "created_at");

ALTER TABLE "WorkoutAdjustmentProposal"
    ADD CONSTRAINT "WorkoutAdjustmentProposal_assignment_id_fkey"
    FOREIGN KEY ("assignment_id") REFERENCES "ClientWorkoutAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkoutAdjustmentEvent" (
    "id"          TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "actor_id"    TEXT,
    "action"      TEXT NOT NULL,
    "detail"      JSONB,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkoutAdjustmentEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkoutAdjustmentEvent_action_check" CHECK (
        "action" IN ('proposed', 'approved', 'edited', 'dismissed', 'undone', 'expired', 'withdrawn', 'apply_refused')
    )
);

CREATE INDEX "WorkoutAdjustmentEvent_proposal_id_created_at_idx"
    ON "WorkoutAdjustmentEvent"("proposal_id", "created_at");

ALTER TABLE "WorkoutAdjustmentEvent"
    ADD CONSTRAINT "WorkoutAdjustmentEvent_proposal_id_fkey"
    FOREIGN KEY ("proposal_id") REFERENCES "WorkoutAdjustmentProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 2) Audit trail is append-only: reject every UPDATE (all roles)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.workout_adjustment_event_reject_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'WorkoutAdjustmentEvent is append-only'
    USING ERRCODE = '55000';
END
$function$;

COMMENT ON FUNCTION public.workout_adjustment_event_reject_update() IS
  'Roman approve-to-adjust: the adjustment audit trail is append-only; every UPDATE is rejected.';

CREATE TRIGGER "WorkoutAdjustmentEvent_append_only"
    BEFORE UPDATE ON "WorkoutAdjustmentEvent"
    FOR EACH ROW EXECUTE FUNCTION public.workout_adjustment_event_reject_update();

-- =====================================================================
-- 3) RLS
-- =====================================================================
ALTER TABLE "WorkoutAdjustmentProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutAdjustmentProposal" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WorkoutAdjustmentProposal" FROM anon;

CREATE POLICY "p_workoutadjustmentproposal_service_role_all" ON "WorkoutAdjustmentProposal"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_workoutadjustmentproposal_service_role_all" ON "WorkoutAdjustmentProposal" IS
  'Primitive A: the backend writes proposals and decisions server-side.';

CREATE POLICY "p_workoutadjustmentproposal_select_coach" ON "WorkoutAdjustmentProposal"
    AS PERMISSIVE FOR SELECT TO public
    USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
COMMENT ON POLICY "p_workoutadjustmentproposal_select_coach" ON "WorkoutAdjustmentProposal" IS
  'The proposing coach reads own proposals. No client, owner or sub-coach branch; no write policy for non-service principals.';

CREATE POLICY "deny_all_anon_workoutadjustmentproposal" ON "WorkoutAdjustmentProposal"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

ALTER TABLE "WorkoutAdjustmentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutAdjustmentEvent" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WorkoutAdjustmentEvent" FROM anon;

CREATE POLICY "p_workoutadjustmentevent_service_role_all" ON "WorkoutAdjustmentEvent"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_workoutadjustmentevent_service_role_all" ON "WorkoutAdjustmentEvent" IS
  'Primitive A: server-side audit writer. UPDATE is still rejected by the append-only trigger.';

CREATE POLICY "p_workoutadjustmentevent_select_coach" ON "WorkoutAdjustmentEvent"
    AS PERMISSIVE FOR SELECT TO public
    USING (
      app.current_user_id() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "WorkoutAdjustmentProposal" p
        WHERE p."id" = "WorkoutAdjustmentEvent"."proposal_id"
          AND p."coach_id" = app.current_user_id()
      )
    );
COMMENT ON POLICY "p_workoutadjustmentevent_select_coach" ON "WorkoutAdjustmentEvent" IS
  'The proposing coach reads the audit trail of own proposals only.';

CREATE POLICY "deny_all_anon_workoutadjustmentevent" ON "WorkoutAdjustmentEvent"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

RESET lock_timeout;
