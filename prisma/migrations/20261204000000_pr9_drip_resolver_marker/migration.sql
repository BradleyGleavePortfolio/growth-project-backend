-- PR-9 R1 audit-fix — durable idempotency marker for drip-fan-out
-- resolver side-effects whose commit lands OUTSIDE the outer fan-out
-- $transaction.
--
-- Today only `auto_message` uses this table — `MessagingService.sendAsCoach`
-- commits CoachMessage on its own connection, so a resolver throw / a
-- post-resolver in-tx failure (the `tx.scheduledDrop.update` or the
-- `tx.purchaseFanout.update` that follows) rolls back the outer tx +
-- regenerates ScheduledDrop UUIDs on Stripe retry, but the CoachMessage
-- already exists in the DB. Without a stable, rollback-survivable key
-- the buyer received a second message on retry (PR-9 audit P1-2).
--
-- Workout does NOT need a row here — it uses the existing
-- WorkoutBuilderIdempotencyKey ledger and PR-9 R1 changes the key it
-- supplies from `drip:workout:{client}:{plan}:{scheduledDropId}` to
-- `drip:workout:{purchase_id}:{content_id}` (both stable across
-- rollback+retry). Media + meal_plan ride the outer tx and roll back
-- with it, so they do not need this table either.
--
-- Why (purpose, purchase_id, content_id)? `purpose` is the resolver
-- namespace (today literal 'auto_message') so a single table can host
-- markers for future resolver types without further migrations.
-- (purchase_id, content_id) are STABLE across an outer-tx rollback +
-- Stripe webhook retry: the ClientPurchase row predates the entitlement
-- flip and is not touched by the rollback, and content_id is the
-- CoachPackageContent authoring id (also unaffected by retries). This is
-- the only pair we can key on that the retry sees identically.
--
-- Additive-only: no DROP, no RENAME, no type change on any existing
-- column. The new table starts empty so the migration is
-- metadata-only.

-- CreateTable
CREATE TABLE "DripResolverMarker" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "content_id" TEXT NOT NULL,
    "materialised_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DripResolverMarker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DripResolverMarker_purpose_purchase_id_content_id_key" ON "DripResolverMarker"("purpose", "purchase_id", "content_id");

-- CreateIndex
CREATE INDEX "DripResolverMarker_purchase_id_idx" ON "DripResolverMarker"("purchase_id");
