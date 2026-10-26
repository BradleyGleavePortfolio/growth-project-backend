-- 20270502009600_community_leave_mute (LEAVE-MUTE-BE, agent 176; owner D2, #170-1): leave a space, mute or
-- leave a thread.
--
-- community_space_reads.left_at: when the person left the space (NULL = they are in it). A left space drops
-- out of their space list and unread counts; it still reads (the "Spaces you left" view) while the coach's
-- access stands, and they join again on their own. The four b#1137 policies on the row are reused.
-- community_thread_prefs: one row per (person, thread first message): 'muted' or 'left', since when. The
-- first message lives in the partitioned community_messages (key id, created_at), so there is no foreign key;
-- the server takes only a first message of that space (a reply id resolves to its first message).
-- Row security, forced: a person reads only their own rows, and inserts, changes or deletes one only for a
-- space app.community_can_access lets them read now. The server (service role) keeps every row.
-- Reverse: down.sql. Live proof: test/rls/community-leave-mute-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "community_space_reads" ADD COLUMN "left_at" TIMESTAMPTZ(6);

CREATE TABLE "community_thread_prefs" (
    "user_id" TEXT NOT NULL,
    "thread_message_id" UUID NOT NULL,
    "cohort_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "since" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_thread_prefs_pkey" PRIMARY KEY ("user_id","thread_message_id")
);

CREATE INDEX "community_thread_prefs_user_id_cohort_id_idx" ON "community_thread_prefs"("user_id", "cohort_id");

ALTER TABLE "community_thread_prefs" ADD CONSTRAINT "community_thread_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_thread_prefs" ADD CONSTRAINT "community_thread_prefs_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_thread_prefs" ADD CONSTRAINT "community_thread_prefs_state_check"
  CHECK ("state" IN ('muted', 'left'));

ALTER TABLE "community_thread_prefs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_thread_prefs" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "community_thread_prefs" FROM anon;

-- One policy per command (LS-1137 C1): a person keeps reading their own row after they lose the space,
-- but every write (insert, change, delete) needs the space to be readable now.
CREATE POLICY "community_thread_prefs_own_select" ON "community_thread_prefs" FOR SELECT TO public
  USING ("user_id" = app.current_user_id());
CREATE POLICY "community_thread_prefs_own_insert" ON "community_thread_prefs" FOR INSERT TO public
  WITH CHECK ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"));
CREATE POLICY "community_thread_prefs_own_update" ON "community_thread_prefs" FOR UPDATE TO public
  USING ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"))
  WITH CHECK ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"));
CREATE POLICY "community_thread_prefs_own_delete" ON "community_thread_prefs" FOR DELETE TO public
  USING ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"));
COMMENT ON POLICY "community_thread_prefs_own_select" ON "community_thread_prefs" IS
  '20270502009600: a person reads only their own thread rows, even after they lose the space.';
COMMENT ON POLICY "community_thread_prefs_own_insert" ON "community_thread_prefs" IS
  '20270502009600: a person adds a thread row only for themselves and a space they can read now.';
COMMENT ON POLICY "community_thread_prefs_own_update" ON "community_thread_prefs" IS
  '20270502009600: a person changes their own thread row only while they can read the space now.';
COMMENT ON POLICY "community_thread_prefs_own_delete" ON "community_thread_prefs" IS
  '20270502009600: a person deletes their own thread row only while they can read the space now.';
COMMENT ON TABLE "community_thread_prefs" IS
  '20270502009600: a person''s muted or left threads (first message id), one row per person and thread.';

COMMIT;
