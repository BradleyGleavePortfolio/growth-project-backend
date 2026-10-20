-- VOICE-BE (agent 163): the server half of community voice notes, style B
-- ("Studio"). Additive: two new tables; no existing table, column or policy
-- changes. The waveform uses the existing community_voice_notes.waveform_peaks
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

COMMIT;
