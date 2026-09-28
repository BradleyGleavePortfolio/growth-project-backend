-- S8-D3 step 9 of 11 rollback: drop the index CONCURRENTLY (no transaction block; one statement).
-- Runs after the step-10 down (which drops the constraints / FKs that may depend on this index).
DROP INDEX CONCURRENTLY IF EXISTS public."ImportNativeProvenance_person_id_idx";
