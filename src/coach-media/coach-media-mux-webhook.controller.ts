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
 * HMAC algorithm, same MUX_WEBHOOK_SECRET, applied to req.rawBody (the
 * exact bytes Mux signed). A forged event returns 400 (matching the
 * workout-demo controller's contract). Mux retries on 4xx stop by
 * design, which is what we want for an unsigned event.
 *
 * Audit P1-2 fix: previously this controller verified HMAC over
 * JSON.stringify(parsedBody). Since HMAC is byte-exact, any minor
 * divergence between Mux's transmitted bytes and the re-serialised JS
 * object (key order, whitespace, number formatting) silently rejected
 * legit events. We now use req.rawBody, identical to
 * stripe-webhook.controller.ts. If rawBody is missing (middleware
 * misconfigured) we reject with 400.
 *
 * Idempotency (audit P1-1 fix):
 *   - MuxProcessedEvent.PK = mux_event_id. We do an optimistic INSERT
 *     INSIDE the same $transaction that runs the handler. If the
 *     handler's coachMediaAsset.update throws transiently, the dedup
 *     row rolls back too — Mux's retry re-runs the handler instead of
 *     short-circuiting on a stale dedup. This mirrors the
 *     StripeProcessedEvent discipline in billing.service.ts:191-200
 *     (the previous implementation inserted OUTSIDE any transaction,
 *     so a handler failure permanently lost the state transition).
 *   - A P2002 on the insert means we have ALREADY processed this
 *     event id in a prior committed transaction — that is the true
 *     duplicate case, and we 200 the redelivery without re-running.
 *   - handler_completed_at is stamped in a separate post-commit update
 *     for observability only; bookkeeping failure does not affect
 *     dedup correctness.
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
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma.service';
import { MuxService } from '../video/mux.service';
import {
  STATUS_ERRORED,
  STATUS_PROCESSING,
  STATUS_READY,
  STATUS_UPLOADING,
} from './coach-media.service';

type TxClient = Prisma.TransactionClient;

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
    @Req() req: Request,
    @Body() body: MuxEvent,
    @Headers('mux-signature') signature: string,
  ) {
    // Audit P1-2 fix: HMAC must verify against the EXACT bytes Mux sent,
    // not a re-serialised JS object. main.ts wires `rawBody: true` so
    // req.rawBody is a Buffer on every request. If middleware is
    // misconfigured we fail loudly rather than fall back to JSON.stringify
    // (that fallback is what would silently reject legit events).
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Mux webhook received without rawBody. Verify rawBody:true is wired in main.ts.',
      );
      throw new BadRequestException('Mux webhook raw body unavailable');
    }
    const raw = rawBody.toString('utf8');
    const ok = this.mux.verifyWebhookSignature({
      payload: raw,
      signatureHeader: signature,
    });
    if (!ok) {
      throw new BadRequestException('Invalid Mux signature');
    }

    const eventType = body.type ?? '';
    const eventId = body.id;

    // Audit P1-1 fix: dedup row INSERT + handler.update run inside the
    // SAME $transaction. If the handler throws transiently the dedup row
    // rolls back too — Mux's retry then re-runs the handler. The previous
    // implementation inserted the dedup row outside any tx, which meant a
    // handler error left the dedup row committed and the next retry
    // short-circuited as "deduped" without re-running. Mirrors
    // billing.service.ts:191-200.
    try {
      await this.prisma.$transaction(async (tx) => {
        if (eventId) {
          await tx.muxProcessedEvent.create({
            data: { mux_event_id: eventId, type: body.type ?? 'unknown' },
          });
        }
        await this.dispatch(tx, eventType, body);
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // True duplicate: a prior tx ALREADY committed this event id, so
        // the handler has already run successfully. 200 the redelivery.
        // Note: a P2002 raised *here* could in principle also come from a
        // unique-constraint inside the handler, but the only unique we
        // touch in this transaction is MuxProcessedEvent.mux_event_id, so
        // attributing the conflict to dedup is safe.
        if (eventId) {
          return { received: true, deduped: eventId };
        }
      }
      throw err;
    }

    // Post-commit bookkeeping (handler succeeded → stamp completion). A
    // failure here does not affect dedup correctness — the row is already
    // committed and the state transition has landed.
    if (eventId) {
      await this.prisma.muxProcessedEvent
        .update({
          where: { mux_event_id: eventId },
          data: { handler_completed_at: new Date() },
        })
        .catch(() => {
          // Best-effort — leave the row without handler_completed_at if
          // the bookkeeping update flakes.
        });
    }

    if (eventType.length === 0) {
      return { received: true, ignored: 'no_type' };
    }
    return { received: true };
  }

  private async dispatch(
    tx: TxClient,
    eventType: string,
    body: MuxEvent,
  ): Promise<void> {
    switch (eventType) {
      case 'video.upload.asset_created':
        await this.handleUploadAssetCreated(tx, body);
        return;
      case 'video.asset.created':
        // Tracker-only; if we have the row in upload state advance to
        // processing. No-op for terminal states.
        await this.handleAssetCreated(tx, body);
        return;
      case 'video.asset.ready':
        await this.handleAssetReady(tx, body);
        return;
      case 'video.asset.errored':
        await this.handleAssetErrored(tx, body);
        return;
      default:
        // Unknown event — acknowledge so Mux stops retrying.
        return;
    }
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
  private async handleUploadAssetCreated(
    tx: TxClient,
    event: MuxEvent,
  ): Promise<void> {
    const uploadId = event.data?.id;
    const assetId = event.data?.asset_id;
    if (!uploadId || !assetId) return;

    const row = await tx.coachMediaAsset.findUnique({
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
    await tx.coachMediaAsset.update({
      where: { id: row.id },
      data: {
        storage_key: assetId,
        status: STATUS_PROCESSING,
        mux_error_message: null,
      },
    });
  }

  private async handleAssetCreated(
    tx: TxClient,
    event: MuxEvent,
  ): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const row = await this.findRowByAssetOrUpload(tx, assetId);
    if (!row) return;
    if (row.status !== STATUS_UPLOADING) return;
    await tx.coachMediaAsset.update({
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
  private async handleAssetReady(
    tx: TxClient,
    event: MuxEvent,
  ): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const row = await this.findRowByAssetOrUpload(tx, assetId);
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
    await tx.coachMediaAsset.update({
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
  private async handleAssetErrored(
    tx: TxClient,
    event: MuxEvent,
  ): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const row = await this.findRowByAssetOrUpload(tx, assetId);
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
    await tx.coachMediaAsset.update({
      where: { id: row.id },
      data: {
        status: STATUS_ERRORED,
        mux_error_message: message,
        mux_playback_id: null,
      },
    });
  }

  private async findRowByAssetOrUpload(tx: TxClient, assetId: string) {
    // Try storage_key (set on upload_asset_created -> the asset id) first,
    // then mux_upload_id (covers the out-of-order case where
    // video.asset.ready arrives before video.upload.asset_created).
    const byAsset = await tx.coachMediaAsset.findFirst({
      where: { provider: 'mux', storage_key: assetId },
    });
    if (byAsset) return byAsset;
    const byUpload = await tx.coachMediaAsset.findFirst({
      where: { provider: 'mux', mux_upload_id: assetId },
    });
    return byUpload;
  }
}
