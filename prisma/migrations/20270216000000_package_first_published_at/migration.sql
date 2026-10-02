-- S-FEE (backend #629, B-629-2) — durable "was this package ever on sale".
--
-- CoachPackage.published_at is the CURRENT visibility (unpublish clears it),
-- so it cannot tell a previously sold offer from a never-published draft. The
-- $19.99 paid-package floor grandfathers an offer that was already on sale with
-- an unchanged price configuration; first_published_at records the first
-- publication and is never cleared.
--
-- Additive and nullable; no RLS change (CoachPackage policies are row-level and
-- cover every column). Backfill, oldest evidence first:
--   1. a package that is published now has been on sale since at least its
--      current published_at;
--   2. a package with a real purchase or a guest checkout was on sale when the
--      first of those was created (this recovers packages that were sold and
--      later unpublished). Round 4 (B-629-3): only real Stripe purchases count
--      ("source" IS NULL AND "amount_cents" > 0). Invite-grant and free-claim
--      rows (#595, "source" set, $0) are written for draft packages too, so
--      they are not evidence that the package was ever on sale.
-- A package with neither has no recoverable history and is treated as a draft
-- (the floor applies on its next publish), which is the conservative side.
ALTER TABLE "CoachPackage" ADD COLUMN IF NOT EXISTS "first_published_at" TIMESTAMP(3);

UPDATE "CoachPackage"
SET "first_published_at" = "published_at"
WHERE "published_at" IS NOT NULL AND "first_published_at" IS NULL;

UPDATE "CoachPackage" AS p
SET "first_published_at" = sold."first_sold_at"
FROM (
  SELECT s."package_id", MIN(s."created_at") AS "first_sold_at"
  FROM (
    SELECT "package_id", "created_at" FROM "ClientPurchase"
    WHERE "source" IS NULL AND "amount_cents" > 0
    UNION ALL
    SELECT "package_id", "created_at" FROM "GuestCheckout"
  ) AS s
  GROUP BY s."package_id"
) AS sold
WHERE p."id" = sold."package_id" AND p."first_published_at" IS NULL;
