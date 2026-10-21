-- VOICE-BE (agent 163): the server half of community voice notes, style B
-- ("Studio"). Two new tables; one existing policy changes (below); no existing
-- table or column changes. The waveform uses the existing community_voice_notes.waveform_peaks
-- column, and a space voice note's chat message is a community_messages row
-- (kind 'voice') that shares the voice note's id.
--
-- Row rules (RLS enabled and forced on both tables; anon has no table access;
-- the server's service-role connection bypasses RLS):
--   * community_voice_note_listens (the heard marker, one row per listener per
--     voice note): a person reads and writes only their own rows, and writes
--     only on a voice note they can read, so the voice note's own rules decide
--     (a live note in a space they share, or the workspace coach).
--   * community_voice_consents (the voice consent card was shown once): a
--     person reads and writes only their own row.
--   * community_messages_space_takes_insert (20270502004600) now also counts a
--     plain voice message as a reply when its parent is a live plain message of
--     the same space (app.community_voice_reply), so a member may answer in a
--     coach-only space such as Announcements, as a comment does. A top-level
--     voice message keeps the start permission; a section still takes nothing.
-- Reverse: down.sql. Live proof: test/rls/community-voice-studio-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "community_voice_note_listens" (
    "voice_note_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "heard_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_voice_note_listens_pkey" PRIMARY KEY ("voice_note_id","user_id")
);

CREATE TABLE "community_voice_consents" (
    "user_id" TEXT NOT NULL,
    "seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_voice_consents_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX "community_voice_note_listens_user_id_idx" ON "community_voice_note_listens"("user_id");

ALTER TABLE "community_voice_note_listens" ADD CONSTRAINT "community_voice_note_listens_voice_note_id_fkey" FOREIGN KEY ("voice_note_id") REFERENCES "community_voice_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_voice_note_listens" ADD CONSTRAINT "community_voice_note_listens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_voice_consents" ADD CONSTRAINT "community_voice_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_voice_note_listens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_voice_note_listens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_voice_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_voice_consents" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "community_voice_note_listens", "community_voice_consents" FROM anon;

CREATE POLICY "community_voice_note_listens_own" ON "community_voice_note_listens" FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id() AND EXISTS (
    SELECT 1 FROM public."community_voice_notes" n WHERE n."id" = "community_voice_note_listens"."voice_note_id"));
CREATE POLICY "community_voice_consents_own" ON "community_voice_consents" FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

CREATE FUNCTION app.community_voice_reply(p_cohort_id uuid, p_parent_id uuid, p_parent_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."community_messages" p
    WHERE p."id" = p_parent_id AND p."created_at" = p_parent_at
      AND p."scope" = 'cohort' AND p."cohort_id" = p_cohort_id
      AND p."deleted_at" IS NULL AND p."plan_context_type" IS NULL
  )
$fn$;
ALTER FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) IS
  '20270502007900: the parent of a voice reply is a live plain message of the same space.';

ALTER POLICY "community_messages_space_takes_insert" ON "community_messages"
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin')
         OR ("kind" = 'voice' AND "plan_context_type" IS NULL AND "parent_message_id" IS NOT NULL
             AND app.community_voice_reply("cohort_id", "parent_message_id", "parent_message_at")))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502007900: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment, a challenge opt-in, or a voice message whose parent is a live plain message of the same space). DMs and Hall rows pass.';

COMMIT;
