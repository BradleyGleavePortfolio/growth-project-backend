-- Adds User.signup_ref for signup attribution (e.g. "importer-extension").
--
-- REVERSIBLE (R82): additive, nullable column with no default and no backfill.
-- The reverse step lives in the companion down.sql
-- (ALTER TABLE "User" DROP COLUMN IF EXISTS "signup_ref";).
--
-- BACKWARDS-COMPATIBLE (expand phase): the column is nullable, so the
-- previously-deployed code that never writes it continues to work unchanged
-- during the rollout window. No contract step is required for this feature.
ALTER TABLE "User" ADD COLUMN "signup_ref" TEXT;
