BEGIN;

-- RLS for team membership graph.
ALTER TABLE "TeamSubCoachAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamSubCoachAssignment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_subcoach_assignment_owner_all" ON "TeamSubCoachAssignment";
CREATE POLICY "team_subcoach_assignment_owner_all" ON "TeamSubCoachAssignment"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "team_subcoach_assignment_participant_select" ON "TeamSubCoachAssignment";
CREATE POLICY "team_subcoach_assignment_participant_select" ON "TeamSubCoachAssignment"
  FOR SELECT TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "head_coach_id" = app.current_user_id()
      OR "sub_coach_id" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS "team_subcoach_assignment_head_write" ON "TeamSubCoachAssignment";
CREATE POLICY "team_subcoach_assignment_head_write" ON "TeamSubCoachAssignment"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "head_coach_id" = app.current_user_id()
    AND NOT EXISTS (
      SELECT 1 FROM "TeamSubCoachAssignment" active_sub
      WHERE active_sub."sub_coach_id" = app.current_user_id()
        AND active_sub."archived_at" IS NULL
    )
  );

DROP POLICY IF EXISTS "team_subcoach_assignment_head_update" ON "TeamSubCoachAssignment";
CREATE POLICY "team_subcoach_assignment_head_update" ON "TeamSubCoachAssignment"
  FOR UPDATE TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "head_coach_id" = app.current_user_id()
    AND NOT EXISTS (
      SELECT 1 FROM "TeamSubCoachAssignment" active_sub
      WHERE active_sub."sub_coach_id" = app.current_user_id()
        AND active_sub."archived_at" IS NULL
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "head_coach_id" = app.current_user_id()
  );

-- RLS for sub-coach invites.
ALTER TABLE "SubCoachInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubCoachInvite" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subcoach_invite_owner_all" ON "SubCoachInvite";
CREATE POLICY "subcoach_invite_owner_all" ON "SubCoachInvite"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "subcoach_invite_issuer_select" ON "SubCoachInvite";
CREATE POLICY "subcoach_invite_issuer_select" ON "SubCoachInvite"
  FOR SELECT TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "head_coach_id" = app.current_user_id()
  );

DROP POLICY IF EXISTS "subcoach_invite_accepter_select" ON "SubCoachInvite";
CREATE POLICY "subcoach_invite_accepter_select" ON "SubCoachInvite"
  FOR SELECT TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "accepted_by_user_id" = app.current_user_id()
  );

DROP POLICY IF EXISTS "subcoach_invite_head_insert" ON "SubCoachInvite";
CREATE POLICY "subcoach_invite_head_insert" ON "SubCoachInvite"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "head_coach_id" = app.current_user_id()
    AND NOT EXISTS (
      SELECT 1 FROM "TeamSubCoachAssignment" active_sub
      WHERE active_sub."sub_coach_id" = app.current_user_id()
        AND active_sub."archived_at" IS NULL
    )
  );

DROP POLICY IF EXISTS "subcoach_invite_head_update" ON "SubCoachInvite";
CREATE POLICY "subcoach_invite_head_update" ON "SubCoachInvite"
  FOR UPDATE TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "head_coach_id" = app.current_user_id()
    AND NOT EXISTS (
      SELECT 1 FROM "TeamSubCoachAssignment" active_sub
      WHERE active_sub."sub_coach_id" = app.current_user_id()
        AND active_sub."archived_at" IS NULL
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "head_coach_id" = app.current_user_id()
  );

COMMIT;
