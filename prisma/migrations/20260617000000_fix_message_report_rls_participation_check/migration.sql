-- ============================================================================
-- Security fix: tighten MessageReport RLS INSERT policy.
--
-- The original policy added in 20260616000000_add_message_reports_and_user_blocks
-- only enforced `reporter_id = app.current_user_id()`. A direct Supabase client
-- with an authenticated user's RLS context could therefore create reports
-- against ANY known CoachMessage UUID while setting themselves as reporter,
-- bypassing the service-layer message-participant ownership check in
-- src/messages-safety/messages-safety.service.ts.
--
-- This migration replaces the INSERT policy with one that additionally
-- requires the reporter to be a thread participant of the message being
-- reported (coach_id, client_id, or sender_id on the referenced CoachMessage),
-- mirroring the HTTP service's IDOR check. Owner role retains its escape hatch.
--
-- Defence-in-depth: with this in place, both the NestJS service and the
-- database row-level enforcement reject a foreign-message report. A regression
-- in either layer no longer opens an abuse vector on its own.
-- ============================================================================

DROP POLICY IF EXISTS "message_report_insert_reporter_or_owner" ON "MessageReport";

CREATE POLICY "message_report_insert_reporter_or_owner" ON "MessageReport"
  FOR INSERT TO public
  WITH CHECK (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "reporter_id" = app.current_user_id()
      AND EXISTS (
        SELECT 1
        FROM "CoachMessage" cm
        WHERE cm."id" = "MessageReport"."message_id"
          AND (
            cm."coach_id"  = app.current_user_id()
            OR cm."client_id" = app.current_user_id()
            OR cm."sender_id" = app.current_user_id()
          )
      )
    )
  );
