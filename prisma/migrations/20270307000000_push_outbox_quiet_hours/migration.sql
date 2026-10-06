-- B-NOTIF-5 (backend #648): durable device-push outbox + proven-twin inbox
-- provenance. Additive. Reverse: down.sql.
--
-- 1) PushOutbox: one row per device push. Written by the emitter (inside its
--    transaction when it has one) and sent by the PushDeliveryService worker
--    (one row per FOR UPDATE SKIP LOCKED lease, fenced by lease_token and
--    handed_off_at: B-648-8), so no request waits on Expo (B-648-6),
--    a restart drops nothing (C-648-5), quiet hours 21:00-08:00 in the
--    recipient's zone defer non-urgent pushes to 08:00 local (OR-113-5), and
--    distinct events are never dropped by a rate limit (B-648-1). The table
--    is backend-only: RLS forced, anon/authenticated denied, service_role
--    bypass (same pattern as community_workspace_bans). Account deletion
--    cascades from "User".
-- 2) Notification.inbox_hidden (B-648-7): only proven duplicates are hidden
--    from the inbox and unread counts. The backfill marks a `push` row hidden
--    only when an `inapp` row for the same user, kind, deep link and text was
--    written within 10 seconds of it, and never a coach-AI row
--    (ai_draft_id). A sole push row of any kind stays visible.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "inbox_hidden" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Notification" AS p
SET "inbox_hidden" = true
WHERE p."channel" = 'push'
  AND p."ai_draft_id" IS NULL
  AND p."inbox_hidden" = false
  AND EXISTS (
    SELECT 1 FROM "Notification" AS i
    WHERE i."user_id" = p."user_id"
      AND i."channel" = 'inapp'
      AND i."kind" = p."kind"
      AND i."deep_link" IS NOT DISTINCT FROM p."deep_link"
      AND i."body" = p."body"
      AND i."created_at" BETWEEN p."created_at" - INTERVAL '10 seconds' AND p."created_at" + INTERVAL '10 seconds'
  );

-- CreateTable
CREATE TABLE IF NOT EXISTS "PushOutbox" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT,
    "collapse_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "context" JSONB,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "time_zone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deferred_reason" TEXT,
    "lease_until" TIMESTAMP(3),
    "lease_token" TEXT,
    "handed_off_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result_code" TEXT,
    "ticket_id" TEXT,
    "token" TEXT,
    "sent_at" TIMESTAMP(3),
    "receipt_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushOutbox_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PushOutbox" DROP CONSTRAINT IF EXISTS "PushOutbox_status_check";
ALTER TABLE "PushOutbox"
    ADD CONSTRAINT "PushOutbox_status_check"
    CHECK ("status" IN ('pending', 'sending', 'sent', 'dropped'));

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PushOutbox_status_not_before_idx" ON "PushOutbox"("status", "not_before");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PushOutbox_user_id_collapse_key_created_at_idx" ON "PushOutbox"("user_id", "collapse_key", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PushOutbox_user_id_sent_at_idx" ON "PushOutbox"("user_id", "sent_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PushOutbox_sent_at_receipt_checked_at_idx" ON "PushOutbox"("sent_at", "receipt_checked_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PushOutbox_result_code_idx" ON "PushOutbox"("result_code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PushOutbox_user_id_dedupe_key_key" ON "PushOutbox"("user_id", "dedupe_key");

-- AddForeignKey
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PushOutbox_user_id_fkey') THEN
    ALTER TABLE "PushOutbox" ADD CONSTRAINT "PushOutbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$fk$;

ALTER TABLE "PushOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushOutbox" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_push_outbox_service_role_all" ON "PushOutbox";
CREATE POLICY "p_push_outbox_service_role_all" ON "PushOutbox" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_push_outbox_service_role_all" ON "PushOutbox" IS
  'B-NOTIF-5: service_role bypass. The push outbox is reached only by the backend Prisma client.';

DROP POLICY IF EXISTS "deny_all_anon_push_outbox" ON "PushOutbox";
CREATE POLICY "deny_all_anon_push_outbox" ON "PushOutbox" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_all_authenticated_push_outbox" ON "PushOutbox";
CREATE POLICY "deny_all_authenticated_push_outbox" ON "PushOutbox" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE "PushOutbox" FROM anon, authenticated;
