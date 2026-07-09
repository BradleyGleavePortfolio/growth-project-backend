-- Reverse of migration.sql: drops the two additive, server-only tables.
-- Dropping each table also removes its indexes and RLS policies, so this
-- fully restores the pre-migration schema (forward → down → forward parity).
-- IF EXISTS keeps the down-path idempotent.
BEGIN;
DROP TABLE IF EXISTS "ScoutImportCompletion";
DROP TABLE IF EXISTS "ScoutProgressSnapshot";
COMMIT;
