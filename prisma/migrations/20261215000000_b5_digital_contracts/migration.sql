-- B5 — Digital Contracts + E-Signatures (HelloSign Embedded)
--
-- ADDITIVE-ONLY migration. ZERO DROP / RENAME / ALTER COLUMN TYPE.
--
-- Adds:
--   * enum  "ContractEnvelopeStatus"
--   * table "ContractTemplate"
--   * table "ContractEnvelope"
--   * table "ContractAuditEvent"
--   * 2 new columns on "CoachPackage": requires_contract (NOT NULL DEFAULT
--     false) + contract_template_id (nullable FK) — Layer-2 opt-in.
--   * 1 new column on "ClientPurchase": contract_envelope_id (nullable,
--     @unique FK) — binds one signed envelope to one realized purchase.
--
-- Every column added to an existing table is either nullable OR NOT NULL
-- with a static default, so this is a metadata-only ALTER on Postgres
-- (no table rewrite, no backfill script). Existing CoachPackage rows keep
-- requires_contract = false (no contract step) and existing ClientPurchase
-- rows keep contract_envelope_id = NULL. Behavior is unchanged for every
-- pre-existing row. The migration is reversible.

-- ─── Enum ─────────────────────────────────────────────────────────────────────
CREATE TYPE "ContractEnvelopeStatus" AS ENUM (
  'DRAFT',
  'SENT',
  'VIEWED',
  'SIGNED',
  'DECLINED',
  'EXPIRED'
);

-- ─── ContractTemplate ───────────────────────────────────────────────────────
CREATE TABLE "ContractTemplate" (
  "id"                  TEXT NOT NULL,
  "coach_id"            TEXT NOT NULL,
  "is_platform"         BOOLEAN NOT NULL DEFAULT false,
  "name"                TEXT NOT NULL,
  "body_markdown"       TEXT NOT NULL,
  "version"             INTEGER NOT NULL DEFAULT 1,
  "dynamic_fields_json" JSONB NOT NULL,
  "requires_signature"  BOOLEAN NOT NULL DEFAULT true,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContractTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContractTemplate_coach_id_idx" ON "ContractTemplate" ("coach_id");
CREATE INDEX "ContractTemplate_is_platform_version_idx" ON "ContractTemplate" ("is_platform", "version");

ALTER TABLE "ContractTemplate"
  ADD CONSTRAINT "ContractTemplate_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "User" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── ContractEnvelope ─────────────────────────────────────────────────────────
CREATE TABLE "ContractEnvelope" (
  "id"                   TEXT NOT NULL,
  "template_id"          TEXT NOT NULL,
  "template_version"     INTEGER NOT NULL,
  "client_id"            TEXT NOT NULL,
  "coach_id"             TEXT NOT NULL,
  "purchase_id"          TEXT,
  "status"               "ContractEnvelopeStatus" NOT NULL DEFAULT 'DRAFT',
  "hellosign_request_id" TEXT,
  "signed_pdf_url"       TEXT,
  "ip"                   TEXT,
  "user_agent"           TEXT,
  "signed_at"            TIMESTAMP(3),
  "expires_at"           TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContractEnvelope_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContractEnvelope_client_id_idx" ON "ContractEnvelope" ("client_id");
CREATE INDEX "ContractEnvelope_coach_id_idx" ON "ContractEnvelope" ("coach_id");
CREATE INDEX "ContractEnvelope_status_idx" ON "ContractEnvelope" ("status");
CREATE INDEX "ContractEnvelope_hellosign_request_id_idx" ON "ContractEnvelope" ("hellosign_request_id");
CREATE INDEX "ContractEnvelope_client_id_template_id_template_version_sta_idx"
  ON "ContractEnvelope" ("client_id", "template_id", "template_version", "status");

ALTER TABLE "ContractEnvelope"
  ADD CONSTRAINT "ContractEnvelope_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "ContractTemplate" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ContractEnvelope"
  ADD CONSTRAINT "ContractEnvelope_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "User" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ContractEnvelope"
  ADD CONSTRAINT "ContractEnvelope_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "User" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── ContractAuditEvent ───────────────────────────────────────────────────────
CREATE TABLE "ContractAuditEvent" (
  "id"          TEXT NOT NULL,
  "envelope_id" TEXT NOT NULL,
  "actor_id"    TEXT,
  "action"      TEXT NOT NULL,
  "ip"          TEXT,
  "user_agent"  TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContractAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContractAuditEvent_envelope_id_idx" ON "ContractAuditEvent" ("envelope_id");

ALTER TABLE "ContractAuditEvent"
  ADD CONSTRAINT "ContractAuditEvent_envelope_id_fkey"
  FOREIGN KEY ("envelope_id") REFERENCES "ContractEnvelope" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── CoachPackage: Layer-2 opt-in (additive) ──────────────────────────────────
ALTER TABLE "CoachPackage"
  ADD COLUMN "requires_contract" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CoachPackage"
  ADD COLUMN "contract_template_id" TEXT;

CREATE INDEX "CoachPackage_contract_template_id_idx" ON "CoachPackage" ("contract_template_id");

ALTER TABLE "CoachPackage"
  ADD CONSTRAINT "CoachPackage_contract_template_id_fkey"
  FOREIGN KEY ("contract_template_id") REFERENCES "ContractTemplate" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── ClientPurchase: signed-envelope linkage (additive, nullable @unique) ─────
ALTER TABLE "ClientPurchase"
  ADD COLUMN "contract_envelope_id" TEXT;

CREATE UNIQUE INDEX "ClientPurchase_contract_envelope_id_key"
  ON "ClientPurchase" ("contract_envelope_id");
CREATE INDEX "ClientPurchase_contract_envelope_id_idx"
  ON "ClientPurchase" ("contract_envelope_id");

ALTER TABLE "ClientPurchase"
  ADD CONSTRAINT "ClientPurchase_contract_envelope_id_fkey"
  FOREIGN KEY ("contract_envelope_id") REFERENCES "ContractEnvelope" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
