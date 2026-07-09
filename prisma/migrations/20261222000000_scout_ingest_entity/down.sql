-- Reverse of 20261222000000_scout_ingest_entity (R82/R106).
-- Drops the scout ingest receiver table and its RLS policies (policies are
-- dropped with the table).
DROP TABLE IF EXISTS "ScoutIngestEntity";
