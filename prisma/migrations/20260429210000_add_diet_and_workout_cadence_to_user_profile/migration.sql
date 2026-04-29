-- Profile-fill UX audit (audits/profile_fill_ux_audit.md): the lean
-- onboarding cannot capture diet shape, allergens, or weekly training
-- cadence because UserProfile has no slots for them. Without these the
-- AI structured-context endpoint cannot recommend macro splits or
-- workout volume that respect the client's actual constraints.
--
-- Additive only. Existing rows stay valid:
--   - dietary_pattern is nullable; pre-existing rows read NULL ("unset").
--   - dietary_restrictions defaults to '{}' (empty TEXT[]) so legacy
--     readers do not have to handle NULL.
--   - workout_days_per_week is nullable; the DTO bounds writes to 0..7.

ALTER TABLE "UserProfile" ADD COLUMN "dietary_pattern" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "dietary_restrictions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserProfile" ADD COLUMN "workout_days_per_week" INTEGER;
