-- Phase 11 — Coach↔Client direct messaging + CheckIn review flag.
--
-- 1) Message: two-party direct messages between users. Sender and recipient
--    are both Users. `read` flips true the moment the recipient opens the
--    thread (recipient-side action only). RLS in the next migration enforces
--    sender OR recipient access only.
--
-- 2) CheckIn.reviewed_by_coach: coach dashboard summary tracks which
--    check-ins still need coach acknowledgement. Defaults false; flipped
--    true when the coach reviews. Backfill is unnecessary — existing rows
--    correctly default to "unreviewed".

-- --------------------------------------------------------------------------
-- 1) Message table
-- --------------------------------------------------------------------------
CREATE TABLE "Message" (
  "id"           TEXT NOT NULL,
  "sender_id"    TEXT NOT NULL,
  "recipient_id" TEXT NOT NULL,
  "body"         TEXT NOT NULL,
  "read"         BOOLEAN NOT NULL DEFAULT false,
  "read_at"      TIMESTAMP(3),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- Dashboard hot path: count unread messages addressed to a coach.
CREATE INDEX "Message_recipient_id_read_idx" ON "Message"("recipient_id", "read");
-- Conversation hot path: load thread between two users ordered by time.
CREATE INDEX "Message_sender_id_recipient_id_created_at_idx"
  ON "Message"("sender_id", "recipient_id", "created_at");

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_sender_id_fkey"
  FOREIGN KEY ("sender_id") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_recipient_id_fkey"
  FOREIGN KEY ("recipient_id") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- 2) CheckIn.reviewed_by_coach
-- --------------------------------------------------------------------------
ALTER TABLE "CheckIn"
  ADD COLUMN "reviewed_by_coach" BOOLEAN NOT NULL DEFAULT false;
