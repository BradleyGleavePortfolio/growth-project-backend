-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260613000001_message_fk_cascade
--
-- WHAT:  Change Message FK constraints from ON DELETE RESTRICT (default) to
--        ON DELETE CASCADE ON UPDATE CASCADE for both sender_id and
--        recipient_id.
--
-- WHY (Finding 2 — CRITICAL, audit 2026-05-19):
--   Both Message.sender_id and Message.recipient_id were created with the
--   Prisma default ON DELETE RESTRICT. The `finalizeUserDeletion` transaction
--   in account-deletion.service.ts deleted every table known at the time the
--   service was written, but did NOT include a message.deleteMany call because
--   the Message model was introduced in PR #230 (shipped same day as the audit).
--
--   Consequence: when the $transaction attempts to tombstone (or delete) a User
--   row for ANY user who has ever sent or received a direct message, Postgres
--   raises:
--     ForeignKeyConstraintViolation: null value in column "sender_id" or
--     "recipient_id" violates not-null constraint
--   The entire GDPR erasure transaction is rolled back. A 500 surfaces to the
--   admin caller. Right-to-erasure silently fails.
--
-- FIX:
--   Switch both FKs to ON DELETE CASCADE — when a User is deleted, all Message
--   rows where they were sender OR recipient are automatically removed.
--   This matches the semantic of direct messages: a message between two parties
--   has no meaning once either party's account is gone (unlike CoachMessage
--   which uses ON DELETE SET NULL to preserve coaching history).
--
--   The application-layer explicit deleteMany is added separately in
--   account-deletion.service.ts as belt-and-suspenders (gives an explicit row
--   count in the audit log even in environments where CASCADE fires first).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Drop existing RESTRICT foreign keys ──────────────────────────────────
ALTER TABLE "Message" DROP CONSTRAINT "Message_sender_id_fkey";
ALTER TABLE "Message" DROP CONSTRAINT "Message_recipient_id_fkey";

-- ── 2. Re-add with CASCADE semantics ────────────────────────────────────────
-- ON DELETE CASCADE: deleting a User removes all Message rows where they were
--   sender or recipient. Ensures GDPR erasure is never blocked by this FK.
-- ON UPDATE CASCADE: if a User PK is ever updated (rare; tombstone path does
--   not change the id), the FK columns update automatically — no orphaned rows.
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_sender_id_fkey"
    FOREIGN KEY ("sender_id")
    REFERENCES "User"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_recipient_id_fkey"
    FOREIGN KEY ("recipient_id")
    REFERENCES "User"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
