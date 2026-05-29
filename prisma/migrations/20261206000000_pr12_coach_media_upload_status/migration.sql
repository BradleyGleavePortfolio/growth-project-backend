-- PR-12 — CoachMediaAsset upload pipeline (Supabase PDF + Mux video).
--
-- Three additive changes — no DROP, no RENAME, no type change. All new
-- columns are NULLABLE or have a static DEFAULT, so existing rows (none
-- in prod since PR-3 shipped recently, but we treat the migration as
-- backfill-safe regardless) keep behaving exactly as today.
--
-- WHY each change:
--
--   1. CoachMediaAsset.status — async upload lifecycle state machine.
--      pdf uploads transition uploading -> ready synchronously on
--      confirm; video uploads transition uploading -> processing -> ready
--      via the Mux webhook. A row at any state other than 'ready' MUST
--      NOT be deliverable: MediaAssetResolver gates on this column so a
--      PR-8-attached not-yet-ready video never silently materialises a
--      grant pointing at a broken playback. Default 'ready' keeps any
--      pre-PR-12 rows attachable (there shouldn't be any, but the
--      default makes the migration safe if there are).
--
--   2. CoachMediaAsset.mux_upload_id — the Mux Direct Upload id we mint
--      when the coach starts a video upload. UNIQUE so the Mux webhook's
--      video.upload.asset_created event can resolve a single CoachMediaAsset
--      row by upload id (mirrors ExerciseCatalogItem.mux_upload_id pattern
--      that the existing Mux webhook already uses). Nullable because PDFs
--      and any pre-existing rows don't use Mux at all.
--
--      Implementation note: ExerciseCatalogItem ALREADY has a
--      mux_upload_id column for exercise demo videos. The dual-attach
--      seam (decision #6) means the SAME Mux ingest pipeline is used for
--      both — but ExerciseCatalogItem and CoachMediaAsset are separate
--      tables (exercises vs the coach media library). We keep the
--      tables separate but the upload pipeline single: a Mux upload is
--      created on behalf of EITHER a CoachMediaAsset (kind='video') OR
--      an ExerciseCatalogItem, the webhook resolves to the right row by
--      mux_upload_id. See the coach-media MuxWebhookController for the
--      resolution logic.
--
--   3. MuxProcessedEvent — durable webhook idempotency for CoachMediaAsset
--      Mux events. The existing in-memory dedup in
--      src/video/mux-webhook.controller.ts is process-local and won't
--      survive a restart or a multi-pod deploy; the coach-media webhook
--      uses a durable dedup row identical in shape to StripeProcessedEvent
--      so replays / retries / multi-pod deliveries are all safe. We
--      intentionally do NOT migrate the existing ExerciseCatalogItem
--      webhook to this table in PR-12 (out of scope per the brief — that
--      controller is the workout-demo path and its in-memory dedup keeps
--      working as today). PR-13/PR-18 can unify the two later.
--
-- Index `[coach_id, archived_at, kind, status]` upgrades the existing
-- `[coach_id, archived_at, kind]` to also speed the picker query
-- (filter to status='ready' rows the coach can attach).

ALTER TABLE "CoachMediaAsset"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "CoachMediaAsset"
  ADD COLUMN "mux_upload_id" TEXT;
ALTER TABLE "CoachMediaAsset"
  ADD COLUMN "mux_error_message" TEXT;

CREATE UNIQUE INDEX "CoachMediaAsset_mux_upload_id_key"
  ON "CoachMediaAsset"("mux_upload_id");

CREATE INDEX "CoachMediaAsset_coach_id_archived_at_kind_status_idx"
  ON "CoachMediaAsset"("coach_id", "archived_at", "kind", "status");

-- Durable Mux webhook idempotency. Same shape as StripeProcessedEvent
-- (src/billing/stripe-signature.ts pattern); event id is the PK so a
-- replay no-ops at the INSERT layer regardless of which pod handles it.
CREATE TABLE "MuxProcessedEvent" (
  "mux_event_id"         TEXT          NOT NULL,
  "type"                 TEXT          NOT NULL,
  "processed_at"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "handler_completed_at" TIMESTAMP(3),

  CONSTRAINT "MuxProcessedEvent_pkey" PRIMARY KEY ("mux_event_id")
);
CREATE INDEX "MuxProcessedEvent_processed_at_idx" ON "MuxProcessedEvent"("processed_at");
CREATE INDEX "MuxProcessedEvent_handler_completed_at_idx" ON "MuxProcessedEvent"("handler_completed_at");
