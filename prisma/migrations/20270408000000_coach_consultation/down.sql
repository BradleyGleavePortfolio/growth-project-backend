-- Reverse of 20270408000000_coach_consultation. Only for a confirmed defect:
-- every saved consultation draft and every coach card answer (headline, years,
-- specialties, clients today, coaching touch, programming style) is lost.

ALTER TABLE "CoachOnboardingProgress" DROP COLUMN IF EXISTS "consultation_draft";
ALTER TABLE "CoachOnboardingProgress" DROP COLUMN IF EXISTS "consultation_completed_at";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "years_coaching";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "specialties";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "programming_style";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "headline";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "coaching_touch";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "clients_today";
