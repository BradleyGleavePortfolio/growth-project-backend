-- Email send log — idempotency + receipts ledger for transactional email.
-- See prisma/schema.prisma EmailSendLog for column doctrine.

CREATE TABLE "EmailSendLog" (
    "id"                  TEXT NOT NULL,
    "idempotency_key"     TEXT NOT NULL,
    "template_key"        TEXT NOT NULL,
    "recipient_email"     TEXT NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'sending',
    "provider_message_id" TEXT,
    "error"               TEXT,
    "sent_at"             TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailSendLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSendLog_idempotency_key_key"  ON "EmailSendLog" ("idempotency_key");
CREATE INDEX "EmailSendLog_recipient_email_created_at_idx" ON "EmailSendLog" ("recipient_email", "created_at");
CREATE INDEX "EmailSendLog_template_key_created_at_idx"   ON "EmailSendLog" ("template_key",   "created_at");
CREATE INDEX "EmailSendLog_status_created_at_idx"          ON "EmailSendLog" ("status",         "created_at");
