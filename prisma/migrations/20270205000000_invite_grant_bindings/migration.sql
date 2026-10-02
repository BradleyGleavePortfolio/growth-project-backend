-- Clinic launch C01 — invite code → package bindings and $0 grant rows.
-- ADDITIVE ONLY: one new enum type, nullable columns / defaulted enum columns,
-- SET NULL foreign keys, indexes. No existing row changes meaning:
--   * ClientPurchase.source IS NULL  ⇒ a real Stripe purchase (all prior rows)
--   * InviteCode.grant_mode / CoachProfile.invite_code_grant_mode default 'none'
-- RLS: the three tables already have RLS enabled + forced with their existing
-- policies; new columns inherit them. No policy changes.

-- Enum
DO $$ BEGIN
  CREATE TYPE "InviteGrantMode" AS ENUM ('none', 'free', 'prepaid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- InviteCode binding
ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "package_id" TEXT;
ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "grant_mode" "InviteGrantMode" NOT NULL DEFAULT 'none';
CREATE INDEX IF NOT EXISTS "InviteCode_package_id_idx" ON "InviteCode"("package_id");
DO $$ BEGIN
  ALTER TABLE "InviteCode"
    ADD CONSTRAINT "InviteCode_package_id_fkey"
    FOREIGN KEY ("package_id") REFERENCES "CoachPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CoachProfile permanent-code binding
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "invite_code_package_id" TEXT;
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "invite_code_grant_mode" "InviteGrantMode" NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE "CoachProfile"
    ADD CONSTRAINT "CoachProfile_invite_code_package_id_fkey"
    FOREIGN KEY ("invite_code_package_id") REFERENCES "CoachPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ClientPurchase grant provenance
ALTER TABLE "ClientPurchase" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "ClientPurchase" ADD COLUMN IF NOT EXISTS "grant_metadata" JSONB;
CREATE INDEX IF NOT EXISTS "ClientPurchase_source_idx" ON "ClientPurchase"("source");
