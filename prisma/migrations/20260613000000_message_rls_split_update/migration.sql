-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260613000000_message_rls_split_update
--
-- WHAT:  Replace the single `message_update_party` policy with two focused
--        policies + a SECURITY DEFINER function for recipient read-receipts.
--
-- WHY (Finding 1 — CRITICAL, audit 2026-05-19):
--   The original `message_update_party` policy allowed ANY party (sender OR
--   recipient) to UPDATE any column. Because WITH CHECK also permitted
--   `sender_id = app.current_user_id() OR recipient_id = app.current_user_id()`,
--   a recipient could issue:
--     UPDATE "Message" SET body = '…', sender_id = <their own id>
--   After the update, sender_id = the recipient's id — which still satisfies
--   the WITH CHECK condition. Net effect: recipients could rewrite message
--   bodies, impersonate the sender, or redirect messages to third parties.
--   This is a data-integrity + legal risk (coaches use messages for
--   client accountability).
--
-- FIX STRATEGY:
--   1. Drop the vulnerable combined policy.
--   2. Add `message_update_sender_only` — sender may update freely (they own
--      the row). Both USING and WITH CHECK require sender_id = caller.
--   3. Do NOT create a recipient UPDATE policy. Instead, route all read-receipt
--      mutations through a SECURITY DEFINER function `app.mark_message_read`.
--      This gives the database complete control over which columns can change:
--      only `read = true` and `read_at = NOW()` are ever touched. The function
--      verifies the caller IS the recipient before updating. Clients (and the
--      application layer) call this function; they never issue raw UPDATE
--      statements on Message rows they received.
--
-- SECURITY HARDENING NOTE:
--   The function sets `search_path = pg_catalog, public` to prevent
--   search_path hijacking attacks where a malicious schema in the session
--   search_path shadows standard types or operators.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Drop the vulnerable combined UPDATE policy ───────────────────────────
DROP POLICY IF EXISTS "message_update_party" ON "Message";

-- ── 2. Sender-only UPDATE policy ────────────────────────────────────────────
-- Senders may update their own rows (e.g. edit body while unsent, mark deleted).
-- Both USING (visibility gate) and WITH CHECK (post-update guard) require that
-- the row's sender_id matches the authenticated user. This means a sender can
-- never change sender_id to another user — the WITH CHECK would fail.
CREATE POLICY "message_update_sender_only" ON "Message"
  FOR UPDATE TO public
  USING  (app.current_user_id() IS NOT NULL AND "sender_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "sender_id" = app.current_user_id());

-- ── 3. SECURITY DEFINER function for recipient read-receipts ─────────────────
-- Recipients CANNOT issue a raw UPDATE — there is no recipient UPDATE policy.
-- Instead, the application calls app.mark_message_read(message_id) which:
--   a) Verifies the caller is the recipient of that specific message.
--   b) Sets ONLY `read = true` and `read_at = NOW()`.
--   c) Touches no other column.
--
-- SECURITY DEFINER means the function runs with the privileges of its owner
-- (the schema owner / superuser), bypassing RLS for the specific UPDATE it
-- executes. The function itself enforces the recipient check, so no escalation
-- is possible — a user calling this function for a message they did NOT
-- receive will get a no-op (0 rows affected).
CREATE OR REPLACE FUNCTION app.mark_message_read(p_message_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller uuid;
BEGIN
  -- Resolve the authenticated caller from the session config var.
  -- app.current_user_id() returns NULL if the session is unauthenticated;
  -- the IS NOT NULL check below makes this function a no-op for anon callers.
  v_caller := app.current_user_id();

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'mark_message_read: unauthenticated caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only update the row if the caller is the recipient.
  -- If p_message_id does not exist or the caller is not the recipient,
  -- the UPDATE simply affects 0 rows — no error is raised, which avoids
  -- leaking message-existence information to non-parties.
  UPDATE "Message"
     SET read    = true,
         read_at = NOW()
   WHERE id           = p_message_id
     AND recipient_id = v_caller
     AND read         = false;  -- idempotent: skip already-read rows
END;
$$;

-- Grant EXECUTE to all authenticated users (public role).
-- The function's own recipient check is the authorization gate.
GRANT EXECUTE ON FUNCTION app.mark_message_read(uuid) TO public;
