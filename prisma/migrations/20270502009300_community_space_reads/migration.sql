-- 20270502009100_community_space_reads (SC-BE2, agent 168): the space chat's read line, unread count,
-- per-space notification mode and the coach's high-alert mark.
--
-- community_space_reads holds one row per (person, space): where they stopped reading, their notification
-- mode for that space (NULL = the space's default: Announcements "all", every other space "mute_low") and
-- an optional silence end. Clients read an open "clients" space without a community_memberships row, so the
-- read line cannot live on memberships (SPACE-CHAT plan section 3).
-- Row security, forced: a person reads only their own rows, and inserts, changes or deletes one only for a
-- space app.community_can_access lets them read now (a banned person, a moved client or another coach's client
-- cannot write one). The server (service role) keeps every row.
-- community_messages.high_alert marks a coach's high-alert message (#167-8 HIGH-ALERT); b#1138 (SC-PUSH) sets and caps it.
-- Reverse: down.sql. Live proof: test/rls/community-space-reads-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "community_space_reads" (
    "user_id" TEXT NOT NULL,
    "cohort_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ(6),
    "last_read_message_id" UUID,
    "notify_mode" TEXT,
    "silenced_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_space_reads_pkey" PRIMARY KEY ("user_id","cohort_id")
);

CREATE INDEX "community_space_reads_cohort_id_idx" ON "community_space_reads"("cohort_id");

ALTER TABLE "community_space_reads" ADD CONSTRAINT "community_space_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_space_reads" ADD CONSTRAINT "community_space_reads_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_space_reads" ADD CONSTRAINT "community_space_reads_notify_mode_check"
  CHECK ("notify_mode" IS NULL OR "notify_mode" IN ('all', 'mute_low', 'mute_all'));

ALTER TABLE "community_messages" ADD COLUMN "high_alert" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "community_space_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_space_reads" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "community_space_reads" FROM anon;

-- One policy per command (LS-1137 C1): a person keeps reading their own row after they lose the space,
-- but every write (insert, change, delete) needs the space to be readable now.
CREATE POLICY "community_space_reads_own_select" ON "community_space_reads" FOR SELECT TO public
  USING ("user_id" = app.current_user_id());
CREATE POLICY "community_space_reads_own_insert" ON "community_space_reads" FOR INSERT TO public
  WITH CHECK ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"));
CREATE POLICY "community_space_reads_own_update" ON "community_space_reads" FOR UPDATE TO public
  USING ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"))
  WITH CHECK ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"));
CREATE POLICY "community_space_reads_own_delete" ON "community_space_reads" FOR DELETE TO public
  USING ("user_id" = app.current_user_id() AND app.community_can_access("cohort_id", "user_id"));
COMMENT ON POLICY "community_space_reads_own_select" ON "community_space_reads" IS
  '20270502009100: a person reads only their own read rows, even after they lose the space.';
COMMENT ON POLICY "community_space_reads_own_insert" ON "community_space_reads" IS
  '20270502009100: a person adds a read row only for themselves and a space they can read now.';
COMMENT ON POLICY "community_space_reads_own_update" ON "community_space_reads" IS
  '20270502009100: a person changes their own read row only while they can read the space now.';
COMMENT ON POLICY "community_space_reads_own_delete" ON "community_space_reads" IS
  '20270502009100: a person deletes their own read row only while they can read the space now.';

COMMIT;
