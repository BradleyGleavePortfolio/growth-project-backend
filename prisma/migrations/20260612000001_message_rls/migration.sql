-- Enable RLS on Message.
-- Messages are two-party (sender + recipient). Either party can read their
-- own messages; only the sender can insert/update/delete their own rows.
-- Direct Supabase/PostgREST access (outside the app) must enforce the same
-- tenant isolation as the application layer.
--
-- Owners (platform staff) retain full access for support/audit (mirrors the
-- pattern used by other Phase-7+ RLS migrations via app.is_owner()).

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;

-- Read: either party of the conversation, or an owner.
DROP POLICY IF EXISTS "message_select_party_or_owner" ON "Message";
CREATE POLICY "message_select_party_or_owner" ON "Message"
  FOR SELECT TO public
  USING (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND (
        "sender_id"    = app.current_user_id()
        OR "recipient_id" = app.current_user_id()
      )
    )
  );

-- Write (insert/update/delete): only the sender of the row, or an owner.
-- Recipient-side state changes (e.g. flipping `read` true) are performed
-- by the app under the recipient's session via a dedicated UPDATE policy
-- so we keep INSERT/DELETE restricted to the sender.
DROP POLICY IF EXISTS "message_insert_sender" ON "Message";
CREATE POLICY "message_insert_sender" ON "Message"
  FOR INSERT TO public
  WITH CHECK (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "sender_id" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS "message_update_party" ON "Message";
CREATE POLICY "message_update_party" ON "Message"
  FOR UPDATE TO public
  USING (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND (
        "sender_id"    = app.current_user_id()
        OR "recipient_id" = app.current_user_id()
      )
    )
  )
  WITH CHECK (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND (
        "sender_id"    = app.current_user_id()
        OR "recipient_id" = app.current_user_id()
      )
    )
  );

DROP POLICY IF EXISTS "message_delete_sender" ON "Message";
CREATE POLICY "message_delete_sender" ON "Message"
  FOR DELETE TO public
  USING (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "sender_id" = app.current_user_id()
    )
  );
