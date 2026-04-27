-- Audit log + GDPR account-lifecycle foundation.
--
-- Additive only. Existing rows stay valid. No backfill required.
--
-- 1. User: add deletion_scheduled_at + deleted_at (both nullable).
--    deletion_scheduled_at is set when a user invokes DELETE /users/me/account
--    (grace-period start; account locked but recoverable). deleted_at is
--    set by the post-grace scrub. These are distinct from `archived_at`
--    (which is a coach-side soft archive of a client and unrelated to the
--    user's own GDPR delete request).
-- 2. AuditLog: append-only record of sensitive actions (role changes,
--    account deletions, data exports, ownership transfers, etc.).
-- 3. DataExportRequest: tracks GDPR/CCPA personal-data export requests
--    with status + inline JSON payload until file-storage upload is wired.

-- 1. User additions -------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "deletion_scheduled_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "User_deletion_scheduled_at_idx" ON "User"("deletion_scheduled_at");

-- 2. AuditLog -------------------------------------------------------------
CREATE TABLE "AuditLog" (
    "id"                   TEXT NOT NULL,
    "action"               TEXT NOT NULL,
    "actor_id"             TEXT,
    "actor_role"           TEXT,
    "actor_email_snapshot" TEXT,
    "target_user_id"       TEXT,
    "target_type"          TEXT,
    "target_id"            TEXT,
    "tenant_coach_id"      TEXT,
    "ip"                   TEXT,
    "user_agent"           TEXT,
    "metadata"             JSONB,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_action_created_at_idx"          ON "AuditLog"("action", "created_at");
CREATE INDEX "AuditLog_actor_id_created_at_idx"        ON "AuditLog"("actor_id", "created_at");
CREATE INDEX "AuditLog_target_user_id_created_at_idx"  ON "AuditLog"("target_user_id", "created_at");
CREATE INDEX "AuditLog_tenant_coach_id_created_at_idx" ON "AuditLog"("tenant_coach_id", "created_at");
ALTER TABLE "AuditLog"
    ADD CONSTRAINT "AuditLog_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog"
    ADD CONSTRAINT "AuditLog_target_user_id_fkey"
    FOREIGN KEY ("target_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. DataExportRequest ----------------------------------------------------
CREATE TABLE "DataExportRequest" (
    "id"            TEXT NOT NULL,
    "user_id"       TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'pending',
    "payload"       JSONB,
    "error"         TEXT,
    "requested_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilled_at"  TIMESTAMP(3),
    "delivered_at"  TIMESTAMP(3),
    CONSTRAINT "DataExportRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DataExportRequest_user_id_requested_at_idx" ON "DataExportRequest"("user_id", "requested_at");
CREATE INDEX "DataExportRequest_status_idx" ON "DataExportRequest"("status");
ALTER TABLE "DataExportRequest"
    ADD CONSTRAINT "DataExportRequest_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
