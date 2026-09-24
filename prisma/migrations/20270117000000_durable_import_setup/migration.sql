-- Additive setup-only expansion. No legacy backfill, run authority or cleanup.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE "ImportIntent" (
  "id" UUID NOT NULL,
  "coach_id" TEXT NOT NULL,
  "setup_nonce" UUID,
  "chosen_platform" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paired_at" TIMESTAMP(3),
  "superseded_at" TIMESTAMP(3),
  CONSTRAINT "ImportIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportIntent_coach_id_fkey" FOREIGN KEY ("coach_id")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ImportIntent_id_coach_id_key" ON "ImportIntent"("id", "coach_id");
CREATE UNIQUE INDEX "ImportIntent_coach_id_setup_nonce_key" ON "ImportIntent"("coach_id", "setup_nonce");
CREATE UNIQUE INDEX "ImportIntent_one_current_key" ON "ImportIntent"("coach_id")
  WHERE "superseded_at" IS NULL;
CREATE INDEX "ImportIntent_coach_id_superseded_at_idx" ON "ImportIntent"("coach_id", "superseded_at");
ALTER TABLE "ImportIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportIntent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "deny_all_anon_import_intent" ON "ImportIntent"
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_authenticated_import_intent" ON "ImportIntent"
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
-- Same privileged access posture as ExtensionPairCode; no client grants.
ALTER TABLE "ExtensionPairCode" ADD COLUMN "import_intent_id" UUID;
CREATE UNIQUE INDEX "ExtensionPairCode_import_intent_id_key" ON "ExtensionPairCode"("import_intent_id");
CREATE UNIQUE INDEX "ExtensionPairCode_import_intent_id_coach_id_key"
  ON "ExtensionPairCode"("import_intent_id", "coach_id");
ALTER TABLE "ExtensionPairCode" ADD CONSTRAINT "ExtensionPairCode_import_intent_id_coach_id_fkey"
  FOREIGN KEY ("import_intent_id", "coach_id") REFERENCES "ImportIntent"("id", "coach_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
