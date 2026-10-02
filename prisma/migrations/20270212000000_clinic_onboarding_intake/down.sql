-- Down for 20270212000000_clinic_onboarding_intake. Destroys stored
-- consultation answers; use only for a confirmed pre-launch defect.
DROP TABLE IF EXISTS "ClinicProgramSet";
DROP TABLE IF EXISTS "ClientOnboardingIntakeRevision";
DROP TABLE IF EXISTS "ClientOnboardingIntake";
DROP FUNCTION IF EXISTS app.can_read_client_consultation(text);
