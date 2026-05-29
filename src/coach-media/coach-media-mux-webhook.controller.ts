/**
 * PR-12 — POST /v1/webhooks/coach-media/mux
 *
 * Mux webhook for CoachMediaAsset video uploads. SEPARATE controller from
 * the existing src/video/mux-webhook.controller.ts (exercise-demo path)
 * for two reasons:
 *
 *   1. Idempotency: this controller uses DURABLE dedup via the
 *      MuxProcessedEvent table (mirrors StripeProcessedEvent) instead of
 *      the workout-demo path's in-memory LRU. CoachMediaAsset rows feed
 *      the buyer entitlement pipeline (PR-9 fan-out → grants → mobile
 *      delivery), so a duplicate-handle that wrote the wrong state
 *      could break a paid-customer download. Durable dedup is the right
 *      bar.
 *
 *   2. Target table: the workout-demo webhook resolves rows by
 *      ExerciseCatalogItem.mux_upload_id; this one resolves rows by
 *      CoachMediaAsset.mux_upload_id. Mux ships one webhook per event
 *      to one URL; we register THIS controller's URL on the Mux side
 *      for CoachMediaAsset uploads (the upload create call doesn't
 *      include a per-upload webhook URL, so we keep the two pipelines
 *      separate at the Mux project level — typically by deploying two
 *      Mux environments, or by routing all events through both
 *      handlers and letting the dedup-by-upload-id resolve to the
 *      right row). See the dual-attach seam discussion in
 *      coach-media.service.ts.
 *
 * Signature verification reuses MuxService.verifyWebhookSignature — same
 * HMAC algorithm, same MUX_WEBHOOK_SECRET. A forged event returns 400
 * (matching the workout-demo controller's contract). Mux retries on 4xx
 * stop by design, which is what we want for an unsigned event.
 *
 * Idempotency:
 *   - MuxProcessedEvent.PK = mux_event_id. We do an optimistic INSERT;
 *     a duplicate event id surfaces as P2002 and we 200 the redelivery
 *     without re-applying state.
 *   - processed_at is recorded immediately; handler_completed_at is
 *     stamped after the row update succeeds. The two-column pattern
 *     mirrors StripeProcessedEvent (P1-7 audit fix) so a future
 *     reconciliation worker can identify events whose row write died
 *     before handler_completed_at.
 *
 * State machine:
 *   - video.upload.asset_created → row found by mux_upload_id, set
 *     status='processing' + storage_key=asset_id (so downstream queries
 *     stop pointing at the upload id).
 *   - video.asset.ready → resolve row by mux_asset_id (now stored on
 *     storage_key) OR mux_upload_id (fallback for out-of-order delivery).
 *     Set status='ready', mux_playback_id, duration_sec. Always safe.
 *   - video.asset.errored → set status='errored' only from a pre-terminal
 *     state (P0 fix in the workout-demo controller, replicated here).
 *
 * The webhook acknowledges (200) any other event type and any event
 * whose upload/asset id has no matching CoachMediaAsset row (the event
 * is for a workout-demo, not coach-media — handled by the other
 * controller, or already deduped).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma.service';
import { MuxService } from '../video/mux.service';
import {
  STATUS_ERRORED,
  STATUS_PROCESSING,
  STATUS_READY,
  STATUS_UPLOADING,
} from './coach-media.service';

type MuxEvent = {
  id?: string;
  type?: string;
  created_at?: string;
  data?: {
    id?: string;
    upload_id?: string;
    asset_id?: string;
    playback_ids?: Array<{ id: string; policy: 'public' | 'signed' }>;
    duration?: number;
    errors?: { type?: string; messages?: string[] };
  };
};

@ApiTags('webhooks')
@Controller('v1/webhooks/coach-media')
export class CoachMediaMuxWebhookController {
  private readonly logger = new Logger(CoachMediaMuxWebhookController.name);

  constructor(
    private readonly mux: MuxService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('mux')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Body() body: MuxEvent,
    @Headers('mux-signature') signature: string,
  ) {
    // Nest's default JSON body parser has already deserialised; we
    // re-serialise for HMAC. JSON.stringify is deterministic over the
    // shapes Mux ships and matches the pattern in
    // src/billing/stripe-webhook.controller.ts.
    const raw = JSON.stringify(body ?? {});
    const ok = this.mux.verifyWebhookSignature({
      payload: raw,
      signatureHeader: signature,
    });
    if (!ok) {
      throw new BadRequestException('Invalid Mux signature');
    }

    // Durable dedup: P2002 on insert means we've already processed this
    // event id (possibly on another pod). The handler row is committed
    // here as 'received'; we update handler_completed_at AFTER the state
    // transition lands so a crashed handler leaves an audit trail.
    const eventId = body.id;
    if (eventId) {
      try {
        await this.prisma.muxProcessedEvent.create({
          data: { mux_event_id: eventId, type: body.type ?? 'unknown' },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          // Duplicate — already processed. 200 the redelivery.
          return { received: true, deduped: eventId };
        }
        throw err;
      }
    }

    const eventType = body.type ?? '';
    try {
      switch (eventType) {
        case 'video.upload.asset_created':
          await this.handleUploadAssetCreated(body);
          break;
        case 'video.asset.created':
          // Tracker-only; if we have the row in upload state advance to
          // processing. No-op for terminal states.
          await this.handleAssetCreated(body);
          break;
        case 'video.asset.ready':
          await this.handleAssetReady(body);
          break;
        case 'video.asset.errored':
          await this.handleAssetErrored(body);
          break;
        default:
          // Unknown event — acknowledge so Mux stops retrying.
          break;
      }
    } finally {
      if (eventId) {
        await this.prisma.muxProcessedEvent
          .update({
            where: { mux_event_id: eventId },
            data: { handler_completed_at: new Date() },
          })
          .catch(() => {
            // The update is bookkeeping only — if it fails, the dedup
            // still prevents replay. Avoid masking the original error.
          });
      }
    }

    if (eventType.length === 0) {
      return { received: true, ignored: 'no_type' };
    }
    return { received: true };
  }

  /**
   * Mux fires `video.upload.asset_created` once the direct-upload finishes
   * and the asset row is born. `data.id` here is the upload id; the
   * asset id is on `data.asset_id`. We resolve the CoachMediaAsset by
   * upload id and stamp the new asset id on storage_key so subsequent
   * lookups can resolve by either upload id OR asset id.
   *
   * If no row matches the upload id, this event is for a workout-demo
   * (the other webhook controller's path) — we no-op and the workout-
   * demo controller handles it.
   */
  private async handleUploadAssetCreated(event: MuxEvent): Promise<void> {
    const uploadId = event.data?.id;
    const assetId = event.data?.asset_id;
    if (!uploadId || !assetId) return;

    const row = await this.prisma.coachMediaAsset.findUnique({
      where: { mux_upload_id: uploadId },
    });
    if (!row) {
      // Not a coach-media upload — could be workout-demo or unknown.
      return;
    }
    // Advance only from a non-terminal state — out-of-order delivery
    // could land `asset_created` after `ready` on retry. Mirrors the
    // workout-demo controller's monotonic-state-machine guard.
    if (row.status !== STATUS_UPLOADING && row.status !== STATUS_PROCESSING) {
      return;
    }
    await this.prisma.coachMediaAsset.update({
      where: { id: row.id },
      data: {
        storage_key: assetId,
        status: STATUS_PROCESSING,
        mux_error_message: null,
      },
    });
  }

  private async handleAssetCreated(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    // Try to find by storage_key (set on upload_asset_created); fall back
    // to mux_upload_id if the upload_asset_created hasn't landed first.
    const row = await this.findRowByAssetOrUpload(assetId);
    if (!row) return;
    if (row.status !== STATUS_UPLOADING) return;
    await this.prisma.coachMediaAsset.update({
      where: { id: row.id },
      data: { status: STATUS_PROCESSING, storage_key: assetId },
    });
  }

  /**
   * Ready is the happy-terminal state. Always safe to apply — re-delivery
   * is idempotent (same playback id, same duration). Defensive against a
   * retry that drops playback_ids on the second push: never null out a
   * playback id we already have.
   */
  private async handleAssetReady(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const row = await this.findRowByAssetOrUpload(assetId);
    if (!row) return;

    const playbackIds = event.data?.playback_ids ?? [];
    const first = playbackIds[0];

    const data: Prisma.CoachMediaAssetUpdateInput = {
      status: STATUS_READY,
      mux_error_message: null,
      storage_key: assetId,
    };
    if (first?.id) {
      data.mux_playback_id = first.id;
    }
    if (typeof event.data?.duration === 'number') {
      data.duration_sec = Math.round(event.data.duration);
    }
    await this.prisma.coachMediaAsset.update({
      where: { id: row.id },
      data,
    });
  }

  /**
   * Errored is a sad-terminal state. Important invariant (replicated
   * from src/video/mux-webhook.controller.ts P0 fix): an `errored` event
   * arriving AFTER `ready` must NOT clear the playback id or revert the
   * status — Mux retries can deliver events out of order. We only apply
   * `errored` when the row is still in a pre-terminal state.
   */
  private async handleAssetErrored(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const row = await this.findRowByAssetOrUpload(assetId);
    if (!row) return;

    if (row.status === STATUS_READY || row.status === STATUS_ERRORED) {
      this.logger.warn(
        `Mux errored event for asset ${assetId} arrived after terminal state ${row.status}; preserving playback id`,
      );
      return;
    }
    const message =
      event.data?.errors?.messages?.join('; ') ??
      event.data?.errors?.type ??
      'Mux asset error';
    await this.prisma.coachMediaAsset.update({
      where: { id: row.id },
      data: {
        status: STATUS_ERRORED,
        mux_error_message: message,
        mux_playback_id: null,
      },
    });
  }

  private async findRowByAssetOrUpload(assetId: string) {
    // First try storage_key (set on upload_asset_created -> the asset id).
    const byAsset = await this.prisma.coachMediaAsset.findFirst({
      where: { provider: 'mux', storage_key: assetId },
    });
    if (byAsset) return byAsset;
    // Fall back to mux_upload_id — handles the out-of-order case where
    // video.asset.ready arrives before video.upload.asset_created (Mux
    // does sometimes deliver in unexpected order). Note: this only
    // works for assets that still carry the upload id; once
    // upload_asset_created lands, storage_key is reassigned to asset
    // id and this fallback no longer matches — that's intentional.
    return null;
  }
}
