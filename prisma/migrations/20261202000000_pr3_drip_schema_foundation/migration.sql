-- PR-3 — Packages & Drip-Feed foundation (additive schema only).
--
-- Adds the data-model foundation for the content-agnostic Packages &
-- Drip-Feed engine. Purely additive: one nullable-defaulted column on
-- CoachPackage plus six brand-new tables + their indexes + their FKs.
-- No service logic, no endpoints, no behavior change yet — every
-- existing package keeps behaving exactly as today (paywall-only,
-- zero content rows) until later PRs attach content and wire fan-out.
--
-- Additive-only confirmation: NO DROP, NO RENAME, NO column type
-- changes on existing tables. The single ALTER TABLE on CoachPackage
-- adds `is_sellable BOOLEAN NOT NULL DEFAULT false`, so existing rows
-- get the safe default without any backfill step.

-- AlterTable
ALTER TABLE "CoachPackage" ADD COLUMN     "is_sellable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CoachPackageContent" (
    "id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "asset_revision_id" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "cadence_kind" TEXT NOT NULL DEFAULT 'immediate',
    "cadence_payload" JSONB NOT NULL,
    "display_title" TEXT,
    "display_caption" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "CoachPackageContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledDrop" (
    "id" TEXT NOT NULL,
    "client_purchase_id" TEXT NOT NULL,
    "content_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "asset_revision_id" TEXT,
    "cadence_kind" TEXT NOT NULL,
    "cadence_payload" JSONB NOT NULL,
    "display_title" TEXT,
    "display_caption" TEXT,
    "fire_at" TIMESTAMP(3),
    "fired_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "materialised_ref" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledDrop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseFanout" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "entrypoint" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseFanout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachMediaAsset" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "storage_key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "byte_size" BIGINT,
    "content_type" TEXT,
    "duration_sec" INTEGER,
    "page_count" INTEGER,
    "mux_playback_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "CoachMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAssetGrant" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "media_asset_id" TEXT NOT NULL,
    "granted_via_drop_id" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "ClientAssetGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachPackageContent_package_id_removed_at_display_order_idx" ON "CoachPackageContent"("package_id", "removed_at", "display_order");

-- CreateIndex
CREATE INDEX "CoachPackageContent_asset_type_asset_id_idx" ON "CoachPackageContent"("asset_type", "asset_id");

-- CreateIndex
CREATE INDEX "ScheduledDrop_status_fire_at_idx" ON "ScheduledDrop"("status", "fire_at");

-- CreateIndex
CREATE INDEX "ScheduledDrop_client_purchase_id_status_idx" ON "ScheduledDrop"("client_purchase_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledDrop_client_purchase_id_content_id_key" ON "ScheduledDrop"("client_purchase_id", "content_id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseFanout_purchase_id_key" ON "PurchaseFanout"("purchase_id");

-- CreateIndex
CREATE INDEX "CoachMediaAsset_coach_id_archived_at_kind_idx" ON "CoachMediaAsset"("coach_id", "archived_at", "kind");

-- CreateIndex
CREATE INDEX "ClientAssetGrant_client_id_revoked_at_idx" ON "ClientAssetGrant"("client_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAssetGrant_client_id_media_asset_id_key" ON "ClientAssetGrant"("client_id", "media_asset_id");

-- AddForeignKey
ALTER TABLE "CoachPackageContent" ADD CONSTRAINT "CoachPackageContent_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "CoachPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledDrop" ADD CONSTRAINT "ScheduledDrop_client_purchase_id_fkey" FOREIGN KEY ("client_purchase_id") REFERENCES "ClientPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseFanout" ADD CONSTRAINT "PurchaseFanout_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachMediaAsset" ADD CONSTRAINT "CoachMediaAsset_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
