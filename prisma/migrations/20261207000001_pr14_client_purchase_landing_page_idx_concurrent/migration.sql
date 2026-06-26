-- PR-14 R2 P3 — concurrent build of the ClientPurchase.landing_page_id index.
--
-- Split out of 20261207000000 so this file contains a SINGLE statement.
-- Prisma 6.19 runs a one-statement migration file OUTSIDE a transaction, which
-- is required because CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block (SQLSTATE 25001). A multi-statement file is wrapped in a transaction,
-- which is why the index could not stay in 20261207000000.
--
-- ClientPurchase is a hot, populated production table (it backs every paid
-- purchase across in-app + storefront + guest). A plain CREATE INDEX takes an
-- ACCESS EXCLUSIVE lock for the build, blocking all writes; CONCURRENTLY builds
-- under a ShareUpdateExclusive lock that does not conflict with normal DML.
--
-- IF NOT EXISTS makes it safe to re-run if a previous CONCURRENTLY build failed
-- mid-way (Postgres leaves an INVALID index; operators should check
-- pg_index.indisvalid and DROP any invalid leftovers before re-running).
--
-- Index name matches Prisma's auto-generated name for ClientPurchase's
-- @@index([landing_page_id]) so `prisma migrate diff` stays drift-free.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ClientPurchase_landing_page_id_idx"
  ON "ClientPurchase" ("landing_page_id");
