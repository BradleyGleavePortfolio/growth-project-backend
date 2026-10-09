-- CONSULT-ALL-BE-133 (B14, B33, owner decision 28): the HOUSE program set.
--
-- Additive only. Reverse: down.sql. No backfill: every existing row gets
-- false (production read-only count on 2026-10-08 16:2x PDT: 0
-- ClinicProgramSet rows).
--
-- "ClinicProgramSet"."is_house": true on the ONE set the platform offers to
-- every client whose coach has no active set of their own, and to coachless
-- clients (POST /me/onboarding/complete, GET /me/onboarding
-- consultation_available). Written only by scripts/seed-clinic-programs.ts
-- --house (an operator step). OnboardingService reads the newest active
-- house set whose owner is a live coach or owner account.
--
-- Why a column and not an env var: the env route needs a new ENV_RULES entry
-- in src/common/env-validation.ts plus a Fly secret; the column keeps the
-- choice with the seeded data, so one audited seed run turns it on and no
-- flag is touched.
--
-- Constant default, so on Postgres 11+ ADD COLUMN is a catalog-only change
-- (no table rewrite). RLS on "ClinicProgramSet" is unchanged.

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "ClinicProgramSet" ADD COLUMN "is_house" BOOLEAN NOT NULL DEFAULT false;

RESET lock_timeout;
