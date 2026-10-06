-- Reverse of 20270401000000_roman_memory. Drops only what the migration
-- creates (tables, with their indexes, FKs, CHECKs and policies). Loses every
-- Roman note, summary and memory job state; only for a confirmed defect
-- before the memory writers are switched on.
DROP TABLE IF EXISTS "RomanMemoryState";
DROP TABLE IF EXISTS "RomanClientSummary";
DROP TABLE IF EXISTS "RomanClientNote";
