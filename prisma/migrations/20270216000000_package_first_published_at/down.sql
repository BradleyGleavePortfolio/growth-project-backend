-- Reverse of 20270216000000_package_first_published_at. Drops only the column
-- the forward migration added; published_at is untouched. After rollback the
-- pre-#629 behaviour (floor keyed on current published_at) applies again.
ALTER TABLE "CoachPackage" DROP COLUMN IF EXISTS "first_published_at";
