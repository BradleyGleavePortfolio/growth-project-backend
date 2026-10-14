-- Owner 4 in the row policies (MOVE-RLS, decision 141-2): after a client
-- moves, the former coach (and a teammate who has left with them) reaches no
-- stored row about that client through direct table access. TIGHTENING ONLY:
-- three new helpers, one helper fixed, eleven policies narrowed. No data
-- change; nothing is deleted, so the client's history stays (139-13).
--
-- GAP: the move boundary lived only in the NestJS services.
--   * WorkoutPlan_coach_owner (20260508000001) admitted a plan's coach_id with
--     no end, so the days of a moved client's program copy stayed readable.
--   * p_workoutprogram_* (20261215000000) admitted owner_user_id (and the
--     tenant_shared overlay), so the copy itself stayed readable and writable.
--   * p_dailymealplanassignment_* (20261213000000) admitted the assigning
--     coach with no end.
--   * coach_select_own_brief (20260525120000) admitted every stored brief by
--     coach_id, including briefs built from a client who has since moved.
--   * app.caller_coaches_client (20270319000000), used by
--     assignment_coach_manage: its sub-coach branch did not require the client
--     to still be the delegating head coach's, so an open delegation that
--     outlived a move kept the sub-coach in (a move does not close it).
--
-- NOW, the same rules the services apply:
--   * app.client_in_coach_tenant(client, head): the client's coach is the head
--     coach or a sub-coach seated on the head's team (inTenantWhere, #961).
--     A client with no coach has left.
--   * app.workout_program_stays_in_tenant(program): no program, a master, a
--     client copy while its client is in the program's tenant, or an older
--     copy (no client_id) while none of its assigned clients has left
--     (planStaysInTenantWhere, #961). WorkoutPlan_coach_owner and the
--     p_workoutprogram_* USING clauses AND it; the WorkoutProgram INSERT and
--     UPDATE checks AND the client rule on the row's own columns (an INSERT
--     check runs before the row exists, so it cannot be looked up by id).
--   * DailyMealPlanAssignment: the assigning coach only while the client is
--     still theirs, app.is_current_coach_of(client_id) (the assertClientOfCoach
--     and freezeForMovedClients rule). The client branch is unchanged.
--   * CoachBrief: app.caller_still_coaches_brief_clients(mode, context): every
--     client in the stored scope_client_ids is still the caller's (solo / head
--     brief), or still delegated to the caller by the client's current head
--     coach (sub-coach brief). A brief with no scope list fails closed. This is
--     #939's briefsWithMovedClients rule; the row is withheld whole, not edited.
--   * app.caller_coaches_client: the sub-coach branch now needs the open
--     delegation to come from the caller's head coach AND the client to still
--     be that head's (SubCoachScopeService.getAuthorizedClientIds).
-- Not touched here: CoachingSession (#972) and coach_message_participant_access
-- (#973). The backend uses Prisma credentials that bypass RLS and the app
-- reads no table directly, so no app path changes. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.client_in_coach_tenant(client_user_id text, tenant_head_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."User" c
    WHERE c."id" = client_user_id
      AND (
        c."coach_id" = tenant_head_id
        OR EXISTS (
          SELECT 1
          FROM public."TeamSubCoachAssignment" seat
          WHERE seat."head_coach_id" = tenant_head_id
            AND seat."sub_coach_id" = c."coach_id"
            AND seat."archived_at" IS NULL
        )
      )
  )
$$;
COMMENT ON FUNCTION app.client_in_coach_tenant(text, text) IS
  'RLS helper (20270414000000): true when the client''s coach is the head coach or a sub-coach seated on the head''s team (inTenantWhere). A client with no coach is out.';

CREATE OR REPLACE FUNCTION app.workout_program_stays_in_tenant(target_program_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT target_program_id IS NULL OR EXISTS (
    SELECT 1
    FROM public."WorkoutProgram" p
    WHERE p."id" = target_program_id
      AND (
        p."is_template"
        OR (p."client_id" IS NOT NULL AND app.client_in_coach_tenant(p."client_id", p."coach_id"))
        OR (
          p."client_id" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public."WorkoutPlan" d
            JOIN public."ClientWorkoutAssignment" a ON a."workout_plan_id" = d."id"
            WHERE d."program_id" = p."id"
              AND NOT app.client_in_coach_tenant(a."client_id", p."coach_id")
          )
        )
      )
  )
$$;
COMMENT ON FUNCTION app.workout_program_stays_in_tenant(text) IS
  'RLS helper (20270414000000): true for no program, a master, a client copy while its client is in the program''s tenant, or an older copy while none of its assigned clients has left (planStaysInTenantWhere).';

CREATE OR REPLACE FUNCTION app.caller_still_coaches_brief_clients(stored_mode text, stored_context jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN jsonb_typeof(stored_context -> 'scope_client_ids') = 'array' THEN NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(stored_context -> 'scope_client_ids') AS scope(client_id)
       WHERE NOT CASE
         WHEN stored_mode = 'sub_coach' THEN EXISTS (
           SELECT 1
           FROM public."SubCoachAssignment" d
           JOIN public."User" c ON c."id" = d."client_id" AND c."coach_id" = d."head_coach_id"
           WHERE d."sub_coach_id" = app.current_user_id()
             AND d."client_id" = scope.client_id
             AND d."unassigned_at" IS NULL
         )
         ELSE EXISTS (
           SELECT 1
           FROM public."User" c
           WHERE c."id" = scope.client_id
             AND c."coach_id" = app.current_user_id()
         )
       END
     ) ELSE false END
$$;
COMMENT ON FUNCTION app.caller_still_coaches_brief_clients(text, jsonb) IS
  'Caller-bound RLS helper (20270414000000): true when every client in a stored brief''s scope_client_ids is still app.current_user_id()''s (solo/head brief) or still delegated to them by the client''s current head coach (sub-coach brief). No scope list: false. Called by coach_select_own_brief.';

CREATE OR REPLACE FUNCTION app.caller_coaches_client(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT client_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" caller
       JOIN public."User" client ON client."id" = client_user_id
       WHERE caller."supabase_id" = auth.uid()::text
         AND client."deleted_at" IS NULL
         AND (
           -- (a) head coach / owner: the client is on the caller's own roster
           client."coach_id" = caller."id"
           OR (
             -- (b) sub-coach with explicit team membership and an OPEN assignment to this student,
             -- from the head coach who still has the client
             caller."role" = 'coach'
             AND caller."coach_id" IS NOT NULL
             AND client."role" = 'student'
             AND client."coach_id" = caller."coach_id"
             AND (
               EXISTS (
                 SELECT 1
                 FROM public."TeamSubCoachAssignment" seat
                 WHERE seat."head_coach_id" = caller."coach_id"
                   AND seat."sub_coach_id" = caller."id"
                   AND seat."archived_at" IS NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM public."SubCoachAssignment" delegation
                 WHERE delegation."head_coach_id" = caller."coach_id"
                   AND delegation."sub_coach_id" = caller."id"
                   AND delegation."unassigned_at" IS NULL
               )
             )
             AND EXISTS (
               SELECT 1
               FROM public."SubCoachAssignment" sca
               WHERE sca."sub_coach_id" = caller."id"
                 AND sca."client_id" = client."id"
                 AND sca."head_coach_id" = caller."coach_id"
                 AND sca."unassigned_at" IS NULL
             )
           )
         )
     )
$$;
COMMENT ON FUNCTION app.caller_coaches_client(text) IS
  'Caller-bound RLS helper (D8, 20270319000000; 20270414000000): true when the CALLER (User.supabase_id = auth.uid()) may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient / SubCoachScopeService.canAccessClient: the client is not soft-deleted and either its coach_id is the caller, or the caller is a sub-coach (role coach, coach_id set, explicit team membership) with an open SubCoachAssignment from their head coach to a student who is still that head coach''s. Only argument is the client id. Called by assignment_coach_manage USING and WITH CHECK.';

REVOKE ALL ON FUNCTION app.client_in_coach_tenant(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.workout_program_stays_in_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.caller_still_coaches_brief_clients(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.client_in_coach_tenant(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.workout_program_stays_in_tenant(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.caller_still_coaches_brief_clients(text, jsonb) TO anon, authenticated, service_role;

-- WorkoutPlan: every 20260508000001 condition kept, plus the program rule.
-- WorkoutPlanExercise and WorkoutPlanRevision reach plans through RLS'd
-- WorkoutPlan subqueries, so they follow.
ALTER POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan"
  USING ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text) AND app.workout_program_stays_in_tenant("program_id"))
  WITH CHECK ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text) AND app.workout_program_stays_in_tenant("program_id"));
COMMENT ON POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan" IS '20270414000000: the plan''s coach, while its program stays in their tenant (no program, a master, or a copy whose clients have not left).';

-- WorkoutProgram: every 20261215000000 condition kept for the owner admin;
-- every other branch ANDs the move rule. WorkoutProgramRevision follows.
ALTER POLICY "p_workoutprogram_select" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.workout_program_stays_in_tenant("id") AND ((app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id()) OR (app.current_user_id() IS NOT NULL AND "visibility" = 'tenant_shared' AND (app.is_current_coach_of("coach_id") OR app.is_subcoach_of("coach_id") OR EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = app.current_user_id() AND (u."id" = "WorkoutProgram"."coach_id" OR u."coach_id" = "WorkoutProgram"."coach_id"))))))));
ALTER POLICY "p_workoutprogram_insert" ON "WorkoutProgram"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id() AND ("is_template" OR "client_id" IS NULL OR app.client_in_coach_tenant("client_id", "coach_id")))));
ALTER POLICY "p_workoutprogram_update" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id() AND app.workout_program_stays_in_tenant("id"))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id() AND ("is_template" OR "client_id" IS NULL OR app.client_in_coach_tenant("client_id", "coach_id")))));
ALTER POLICY "p_workoutprogram_delete" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id() AND app.workout_program_stays_in_tenant("id"))));
COMMENT ON POLICY "p_workoutprogram_select" ON "WorkoutProgram" IS '20270414000000: owner admin; or, while the program stays in its tenant (a master, or a copy whose clients have not left), the row owner or, for tenant_shared rows, a head coach / sub-coach in the same coach_id tenant.';
COMMENT ON POLICY "p_workoutprogram_insert" ON "WorkoutProgram" IS '20270414000000: owner admin, or the row''s own owner_user_id for a master or a copy whose client is in the program''s tenant.';
COMMENT ON POLICY "p_workoutprogram_update" ON "WorkoutProgram" IS '20270414000000: owner admin, or the row owner while the program stays in its tenant; CHECK prevents re-owning the row or naming a client outside the tenant.';
COMMENT ON POLICY "p_workoutprogram_delete" ON "WorkoutProgram" IS '20270414000000: owner admin, or the row owner while the program stays in its tenant.';

-- DailyMealPlanAssignment: the assigning coach only while the client is still theirs.
ALTER POLICY "p_dailymealplanassignment_select" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))));
ALTER POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))));
ALTER POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))));
ALTER POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))));
COMMENT ON POLICY "p_dailymealplanassignment_select" ON "DailyMealPlanAssignment" IS '20270414000000: the owner, the assigned client (client_id), or the assigning coach while the client is still theirs. Transitive current-coach access stays excluded.';
COMMENT ON POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment" IS '20270414000000: the owner, the assigned client, or the assigning coach for a client who is theirs. Transitive current-coach access stays excluded.';
COMMENT ON POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment" IS '20270414000000: the owner, the assigned client, or the assigning coach while the client is still theirs, before and after the change. Transitive current-coach access stays excluded.';
COMMENT ON POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment" IS '20270414000000: the owner, the assigned client, or the assigning coach while the client is still theirs. Transitive current-coach access stays excluded.';

-- CoachBrief: the brief's coach while every client it was built from is still theirs.
ALTER POLICY "coach_select_own_brief" ON "CoachBrief"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.caller_still_coaches_brief_clients("brief_mode", "brief_context"));
COMMENT ON POLICY "coach_select_own_brief" ON "CoachBrief" IS '20270414000000: coach-side direct read of their own brief while every client in its scope_client_ids is still theirs; a brief with no scope list is withheld. Writes stay server-only.';

COMMIT;
