-- Enable RLS on MessageDraft.
-- Drafts are coach-authored; clients have no draft API surface.
-- Direct Supabase/PostgREST access (outside the app) must enforce the same
-- tenant isolation as the application layer.

ALTER TABLE "MessageDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageDraft" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "message_draft_coach_access" ON "MessageDraft";
CREATE POLICY "message_draft_coach_access" ON "MessageDraft"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );
