-- Reverse of migration.sql: drops the additive User.signup_ref column.
-- IF EXISTS keeps the down-path idempotent if the column was already removed.
ALTER TABLE "User" DROP COLUMN IF EXISTS "signup_ref";
