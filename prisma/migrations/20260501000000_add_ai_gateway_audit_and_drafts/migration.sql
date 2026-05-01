-- AI Gateway foundation: per-call audit + human-approval drafts.
--
-- Additive only. No backfill required. Both tables are read/written
-- behind the AiGatewayService and AiApprovalService; existing AI paths
-- (POST /api/ai/chat) keep working until they are migrated to route
-- through the gateway.

-- 1. AiRequestAudit -------------------------------------------------------
CREATE TABLE "AiRequestAudit" (
    "id"                      TEXT NOT NULL,
    "request_id"              TEXT NOT NULL,
    "capability"              TEXT NOT NULL,
    "requester_id"            TEXT,
    "requester_role"          TEXT,
    "subject_user_id"         TEXT,
    "tenant_coach_id"         TEXT,
    "provider"                TEXT NOT NULL,
    "model"                   TEXT,
    "enabled"                 BOOLEAN NOT NULL DEFAULT false,
    "context_source_count"    INTEGER NOT NULL DEFAULT 0,
    "context_source_refs"     JSONB,
    "redactions_applied"      JSONB,
    "prompt_token_estimate"   INTEGER,
    "response_token_estimate" INTEGER,
    "prompt_hash"             TEXT,
    "response_hash"           TEXT,
    "approval_status"         TEXT NOT NULL DEFAULT 'not_required',
    "approval_draft_id"       TEXT,
    "error"                   TEXT,
    "ip"                      TEXT,
    "user_agent"              TEXT,
    "metadata"                JSONB,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiRequestAudit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiRequestAudit_request_id_key"          ON "AiRequestAudit"("request_id");
CREATE UNIQUE INDEX "AiRequestAudit_approval_draft_id_key"   ON "AiRequestAudit"("approval_draft_id");
CREATE INDEX "AiRequestAudit_capability_created_at_idx"      ON "AiRequestAudit"("capability", "created_at");
CREATE INDEX "AiRequestAudit_requester_id_created_at_idx"    ON "AiRequestAudit"("requester_id", "created_at");
CREATE INDEX "AiRequestAudit_subject_user_id_created_at_idx" ON "AiRequestAudit"("subject_user_id", "created_at");
CREATE INDEX "AiRequestAudit_tenant_coach_id_created_at_idx" ON "AiRequestAudit"("tenant_coach_id", "created_at");
CREATE INDEX "AiRequestAudit_approval_status_created_at_idx" ON "AiRequestAudit"("approval_status", "created_at");

-- 2. AiActionDraft --------------------------------------------------------
CREATE TABLE "AiActionDraft" (
    "id"               TEXT NOT NULL,
    "capability"       TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "requester_id"     TEXT,
    "subject_user_id"  TEXT,
    "tenant_coach_id"  TEXT,
    "payload"          JSONB NOT NULL,
    "rationale"        TEXT,
    "redacted_inputs"  JSONB,
    "provenance"       JSONB,
    "decided_by_id"    TEXT,
    "decided_at"       TIMESTAMP(3),
    "decision_note"    TEXT,
    "expires_at"       TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiActionDraft_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiActionDraft_status_created_at_idx"          ON "AiActionDraft"("status", "created_at");
CREATE INDEX "AiActionDraft_requester_id_created_at_idx"    ON "AiActionDraft"("requester_id", "created_at");
CREATE INDEX "AiActionDraft_subject_user_id_created_at_idx" ON "AiActionDraft"("subject_user_id", "created_at");
CREATE INDEX "AiActionDraft_tenant_coach_id_created_at_idx" ON "AiActionDraft"("tenant_coach_id", "created_at");
CREATE INDEX "AiActionDraft_capability_status_idx"          ON "AiActionDraft"("capability", "status");

-- 3. Foreign keys ---------------------------------------------------------
ALTER TABLE "AiRequestAudit"
    ADD CONSTRAINT "AiRequestAudit_requester_id_fkey"
    FOREIGN KEY ("requester_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiRequestAudit"
    ADD CONSTRAINT "AiRequestAudit_subject_user_id_fkey"
    FOREIGN KEY ("subject_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiRequestAudit"
    ADD CONSTRAINT "AiRequestAudit_approval_draft_id_fkey"
    FOREIGN KEY ("approval_draft_id") REFERENCES "AiActionDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiActionDraft"
    ADD CONSTRAINT "AiActionDraft_requester_id_fkey"
    FOREIGN KEY ("requester_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiActionDraft"
    ADD CONSTRAINT "AiActionDraft_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
