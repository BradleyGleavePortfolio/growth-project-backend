-- Reverse of migration.sql: drops the additive, server-only lifecycle table.
-- Dropping the table also removes its indexes and RLS policies, so this fully
-- restores the pre-migration schema. IF EXISTS keeps the down-path idempotent.
BEGIN;
DROP TABLE IF EXISTS "ScoutImport";
COMMIT;
