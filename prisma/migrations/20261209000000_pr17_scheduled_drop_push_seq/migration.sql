-- PR-17 B1 — ScheduledDrop.push_seq re-send sequence + widened unique key.
--
-- PR-17 lets a coach push package-content updates to ALREADY-PURCHASED
-- buyers. Decision #5: an already-FIRED drop is IMMUTABLE; a coach
-- "re-send updated version" must create a FRESH delivery, never mutate the
-- fired row. Today the unique key (client_purchase_id, content_id) blocks a
-- second row for the same pair, so a re-send is impossible at the schema
-- level — and the resolver idempotency keys ride that same stable pair, so
-- even if a second row existed the auto_message / workout resolvers would
-- collapse it to the cached delivery. See PR17_EXPANSION_PLAN.md §1.3.
--
-- FIX (fully additive — no data backfill, no type change, no NOT-NULL
-- backfill script):
--   * Add push_seq INTEGER NOT NULL DEFAULT 0. Every existing row and every
--     original fan-out insert keeps push_seq = 0 (the DEFAULT applies on the
--     metadata-only ALTER), so behaviour is byte-compatible. A re-send
--     inserts a NEW row at push_seq = prior max + 1 for that pair.
--   * Replace the 2-column unique index with a 3-column one that includes
--     push_seq. The old uniqueness is preserved as the (pair, 0) subset, so
--     the fan-out createMany({ skipDuplicates: true }) still dedups
--     originals exactly as before (they all use seq 0).
--
-- The dropped index name `ScheduledDrop_client_purchase_id_content_id_key`
-- is Prisma's generated name from the original @@unique([client_purchase_id,
-- content_id]) — created in 20261202000000_pr3_drip_schema_foundation
-- (migration.sql:121). The new index name matches Prisma's generated name
-- for @@unique([client_purchase_id, content_id, push_seq]) so a subsequent
-- `prisma migrate diff` shows no drift.
ALTER TABLE "ScheduledDrop" ADD COLUMN "push_seq" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "ScheduledDrop_client_purchase_id_content_id_key";

CREATE UNIQUE INDEX "ScheduledDrop_client_purchase_id_content_id_push_seq_key"
  ON "ScheduledDrop"("client_purchase_id", "content_id", "push_seq");
