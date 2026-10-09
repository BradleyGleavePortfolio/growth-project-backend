-- Reverse of 20270406000000_clinic_program_set_house. Drops the house flag.
-- Only for a confirmed defect, and only after the code that reads it is
-- rolled back: without it, clients whose coach has no set (and coachless
-- clients) can no longer finish the consultation.

ALTER TABLE "ClinicProgramSet" DROP COLUMN IF EXISTS "is_house";
