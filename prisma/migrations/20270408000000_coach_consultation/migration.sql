-- COACH-CONSULT-BE-134 (B02 B03, decision 134-1): the coach consultation K0-K8.
-- Additive only (reverse: down.sql), no backfill. "CoachProfile": the card and
-- practice answers (K1-K5, vocabularies in src/coach/consultation/
-- coach-consultation.vocab.ts). "CoachOnboardingProgress": the resumable draft
-- and the finish time (K8). Nullable or constant-default columns: catalog-only
-- ADD COLUMN on Postgres 11+. RLS unchanged.

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "CoachOnboardingProgress" ADD COLUMN "consultation_completed_at" TIMESTAMP(3),
ADD COLUMN "consultation_draft" JSONB;

-- AlterTable
ALTER TABLE "CoachProfile" ADD COLUMN "clients_today" TEXT,
ADD COLUMN "coaching_touch" TEXT,
ADD COLUMN "headline" VARCHAR(120),
ADD COLUMN "programming_style" TEXT,
ADD COLUMN "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "years_coaching" INTEGER;

RESET lock_timeout;
