-- PR-6 — CoachPackage draft/publish lifecycle + pricing-combo config.
--
-- Purely additive on CoachPackage. Two concerns rolled into one
-- migration:
--
-- 1. Draft/publish lifecycle (B10). New column `published_at` (nullable
--    DateTime). null = DRAFT (not purchasable), non-null = PUBLISHED
--    (purchasable, value is the most recent publish timestamp). New
--    packages default to null (DRAFT) so an empty package isn't live
--    the instant a coach saves it. EXISTING rows are backfilled to
--    NOW() so already-selling packages stay published and behave
--    exactly as today (gate added downstream on `published_at IS NOT
--    NULL`).
--
-- 2. Pricing config (operator decision #1). A coach can configure a
--    one-time price, a recurring price, OR both together. The existing
--    `amount_cents`/`billing_type`/`interval` triple stays as the
--    PRIMARY price (semantics unchanged — preserves single-price
--    packages and the entire lazy Stripe-Price cache). The new
--    `recurring_*` columns are an OPTIONAL SECOND price that materialises
--    as its own Stripe Price (per master plan §3) when the package has a
--    one-time + recurring combo. recurring_stripe_price_id is the lazy
--    cache for the second price, mirroring stripe_price_id for the
--    first. All four new columns are nullable so existing rows
--    (single-price packages) remain valid with no data change.
--
-- Additive-only confirmation: no DROP, no RENAME, no column type
-- changes on existing columns; only new nullable columns and a
-- one-shot UPDATE backfilling published_at for pre-existing rows.

-- AlterTable — add publish state + second-price config.
ALTER TABLE "CoachPackage"
  ADD COLUMN "published_at" TIMESTAMP(3),
  ADD COLUMN "recurring_amount_cents" INTEGER,
  ADD COLUMN "recurring_interval" TEXT,
  ADD COLUMN "recurring_interval_count" INTEGER,
  ADD COLUMN "recurring_stripe_price_id" TEXT;

-- Backfill: every package that exists at migration time has been
-- "live" up to now (the only gate was is_active / archived_at). Mark
-- them PUBLISHED so the downstream `published_at IS NOT NULL` gate
-- does not silently hide active packages from the storefront /
-- checkout the instant this PR ships.
UPDATE "CoachPackage" SET "published_at" = NOW() WHERE "published_at" IS NULL;

-- Index on published_at for storefront-style filters
-- ("packages a coach has published" + ordering by publish time).
CREATE INDEX "CoachPackage_coach_id_published_at_idx"
  ON "CoachPackage" ("coach_id", "published_at");
