-- Reverse of 20270307000000_push_outbox_quiet_hours. Unsent pushes in the
-- outbox are discarded; the inbox shows proven twins again.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "PushOutbox";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "inbox_hidden";
