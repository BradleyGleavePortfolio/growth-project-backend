-- R3 (PLAN_roman_intelligence §2.6): provenance of the client-data block on
-- each Roman turn. Additive only: two nullable columns, no backfill, no
-- index (read by id when a specific answer is disputed).
ALTER TABLE "RomanMessage" ADD COLUMN "context_hash" TEXT;
ALTER TABLE "RomanMessage" ADD COLUMN "context_generated_at" TIMESTAMP(3);
