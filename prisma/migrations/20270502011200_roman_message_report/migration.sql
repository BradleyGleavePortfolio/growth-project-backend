-- 20270502011200_roman_message_report (ROMAN-HOLD-BE, agent 198; owner #197-D3, 11-04: "click and hold
-- any other persons chat (opens reply, report, etc)"): the report target for one of Roman's replies.
-- Additive only; no data change.
--
--   * RomanMessageReport: one row per client report on a Roman reply in their own chat. It names the
--     reporter and the held message by id, with a reason from the DM report list (MessageReport) and
--     optional details (1000 characters at most, as the DM report). No copy of the chat is kept.
--   * One report per reporter and message (unique); a second report keeps the first.
--   * Goes with the message (ON DELETE CASCADE: erasing the chat erases the report, so the chat delete
--     promise holds) and with the account (ON DELETE CASCADE on the reporter; the erasure manifest also
--     deletes it by reporter_id before the Roman messages).
--
-- Row rules (RLS enabled and forced; anon has no table access): only TGP's team reads a report
-- (app.is_owner(), the platform owner role that already reads RomanMessage). The reporter, their coach
-- and every other user read none. No API role writes, changes or deletes one: the server writes through
-- Prisma's service-role connection (bypasses RLS) behind POST /roman/messages/:id/report, which checks
-- the message is Roman's reply in the caller's own live chat.
-- Live proof: test/rls/roman-message-report-rls.spec.ts (rls-live-tests). Reverse: down.sql.
-- Placement: sorts after 20270502011100 (main at 1016add4).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "RomanMessageReport" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "roman_message_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RomanMessageReport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RomanMessageReport_reason_check" CHECK ("reason" IN ('spam', 'harassment', 'sexual', 'self_harm', 'other')),
    CONSTRAINT "RomanMessageReport_details_check" CHECK ("details" IS NULL OR char_length("details") <= 1000)
);

CREATE UNIQUE INDEX "RomanMessageReport_reporter_id_roman_message_id_key" ON "RomanMessageReport"("reporter_id", "roman_message_id");
CREATE INDEX "RomanMessageReport_roman_message_id_idx" ON "RomanMessageReport"("roman_message_id");
CREATE INDEX "RomanMessageReport_created_at_idx" ON "RomanMessageReport"("created_at");

ALTER TABLE "RomanMessageReport" ADD CONSTRAINT "RomanMessageReport_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RomanMessageReport" ADD CONSTRAINT "RomanMessageReport_roman_message_id_fkey" FOREIGN KEY ("roman_message_id") REFERENCES "RomanMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RomanMessageReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RomanMessageReport" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "RomanMessageReport" FROM anon;

CREATE POLICY "p_romanmessagereport_select_tgp_team" ON "RomanMessageReport"
  FOR SELECT TO public
  USING (app.is_owner());
COMMENT ON POLICY "p_romanmessagereport_select_tgp_team" ON "RomanMessageReport" IS '20270502011200: only TGP''s team (platform owner) reads a report on a Roman reply; never the reporter''s coach. No API role writes.';

COMMIT;
