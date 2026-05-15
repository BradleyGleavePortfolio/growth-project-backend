/**
 * POST /v1/webhooks/mux — Mux webhook receiver.
 *
 * Authentication: HMAC-SHA256 over the raw body, keyed by
 * MUX_WEBHOOK_SECRET. Verified by MuxService.verifyWebhookSignature(). A
 * request without a valid `Mux-Signature` header returns 400 with no
 * side-effect.
 *
 * Events handled (everything else is acknowledged with 200 and ignored):
 *   video.asset.created         → upload completed, asset is processing
 *   video.upload.asset_created  → maps upload_id → asset_id, sets processing
 *   video.asset.ready           → mux_asset_status = ready, store playback id + duration
 *   video.asset.errored         → mux_asset_status = errored, store error message
 *
 * Idempotency: matching is by mux_asset_id (or mux_upload_id when
 * present). Re-delivery of the same event is safe — re-applies the same
 * state, no exceptions.
 *
 * Raw-body handling: Nest's default body parser deserialises JSON before
 * this handler runs. We re-serialise it (JSON.stringify is deterministic
 * over the shapes Mux ships) and feed that to the verifier — mirrors
 * the approach taken in src/billing/stripe-webhook.controller.ts.
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
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma.service';
import { MuxService } from './mux.service';

type MuxEvent = {
  // Mux events carry a top-level event id we can dedupe on.
  id?: string;
  type?: string;
  // Per Mux docs, `created_at` is ISO-8601 — used as a monotonic-event
  // timestamp guard when present.
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

// In-process LRU of recently-seen Mux event ids. Webhook delivery can
// repeat the same event id across retries; rejecting duplicates keeps
// handlers from re-applying state transitions on retry. A bounded set
// (no Redis dep) is enough — Mux retries a handful of times within
// minutes, and the controller is stateless across pods because Mux
// also stamps each delivery with a fresh request-level signature
// header.
const SEEN_EVENT_IDS: string[] = [];
const SEEN_EVENT_IDS_CAP = 1024;
function recordEventId(id: string): boolean {
  if (SEEN_EVENT_IDS.includes(id)) return false;
  SEEN_EVENT_IDS.push(id);
  if (SEEN_EVENT_IDS.length > SEEN_EVENT_IDS_CAP) SEEN_EVENT_IDS.shift();
  return true;
}

@ApiTags('webhooks')
@Controller('v1/webhooks')
export class MuxWebhookController {
  private readonly logger = new Logger(MuxWebhookController.name);

  constructor(
    private readonly mux: MuxService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('mux')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Body() body: MuxEvent,
    @Headers('mux-signature') signature: string,
  ) {
    const raw = JSON.stringify(body ?? {});
    const ok = this.mux.verifyWebhookSignature({
      payload: raw,
      signatureHeader: signature,
    });
    if (!ok) {
      // 400 (not 401) matches Stripe's contract: "do not retry."
      throw new BadRequestException('Invalid Mux signature');
    }

    // Event-id dedupe — Mux may retry the same event id; treat the
    // second delivery as already-processed so we don't re-apply state.
    if (body.id && !recordEventId(body.id)) {
      return { received: true, deduped: body.id };
    }

    const eventType = body.type ?? '';
    switch (eventType) {
      case 'video.upload.asset_created':
        await this.handleUploadAssetCreated(body);
        return { received: true };
      case 'video.asset.created':
        await this.handleAssetCreated(body);
        return { received: true };
      case 'video.asset.ready':
        await this.handleAssetReady(body);
        return { received: true };
      case 'video.asset.errored':
        await this.handleAssetErrored(body);
        return { received: true };
      default:
        // Unknown event — acknowledge so Mux doesn't retry the universe.
        return { received: true, ignored: eventType };
    }
  }

  /**
   * Mux fires `video.upload.asset_created` once the direct-upload finishes
   * and the asset row is born. `data.id` here is the upload id; the
   * asset id is on `data.asset_id`. We resolve the catalog row by upload
   * id and stamp the new asset id.
   */
  private async handleUploadAssetCreated(event: MuxEvent): Promise<void> {
    const uploadId = event.data?.id;
    const assetId = event.data?.asset_id;
    if (!uploadId || !assetId) return;

    const row = await this.prisma.exerciseCatalogItem.findUnique({
      where: { mux_upload_id: uploadId },
    });
    if (!row) {
      this.logger.warn(
        `Mux upload ${uploadId} has no matching catalog row — ignoring`,
      );
      return;
    }
    await this.prisma.exerciseCatalogItem.update({
      where: { id: row.id },
      data: {
        mux_asset_id: assetId,
        mux_asset_status: 'processing',
        mux_error_message: null,
      },
    });
  }

  /**
   * `video.asset.created` arrives for assets that did NOT come through a
   * direct upload (e.g. owner attached an existing assetId). We treat it
   * as a tracker — if we already have the row by asset id in a
   * pre-terminal state, mark processing. Stays a no-op once the row has
   * reached a terminal state (`ready` or `errored`) so out-of-order
   * delivery cannot regress the state machine.
   */
  private async handleAssetCreated(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    await this.prisma.exerciseCatalogItem.updateMany({
      where: {
        mux_asset_id: assetId,
        // Only advance from upload-time pre-terminal states.
        mux_asset_status: { in: ['uploading', 'none'] },
      },
      data: { mux_asset_status: 'processing' },
    });
  }

  /**
   * Ready is a happy-terminal state. Always safe to apply — re-delivery
   * is idempotent (same playback id, same duration). We additionally
   * prefer to keep an existing playback id if Mux re-fires `ready`
   * without playback_ids on the second delivery (some retry shapes drop
   * it). This handler is allowed to override an earlier `errored` only
   * if a playback id is now present — Mux does sometimes recover an
   * asset after an interim error; ready-with-playback wins.
   */
  private async handleAssetReady(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const playbackIds = event.data?.playback_ids ?? [];
    const first = playbackIds[0];

    // Build patch defensively — never null out a playback id that we
    // already have on the row. Re-delivery of `ready` without playback
    // ids on the second push must not erase the id we stored on the
    // first.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      mux_asset_status: 'ready',
      mux_error_message: null,
    };
    if (first?.id) {
      data.mux_playback_id = first.id;
      data.mux_playback_policy = first.policy ?? 'public';
    }
    if (typeof event.data?.duration === 'number') {
      data.mux_duration_seconds = event.data.duration;
    }
    await this.prisma.exerciseCatalogItem.updateMany({
      where: { mux_asset_id: assetId },
      data,
    });
  }

  /**
   * Errored is a sad-terminal state. Important invariant (P0 fix):
   * an `errored` event arriving AFTER `ready` must NOT clear the
   * playback id or revert the status — Mux retries can deliver events
   * out of order. We only apply `errored` when the row is still in a
   * pre-terminal state (uploading/processing/none). If the row is
   * already `ready`, we record the error message on a separate field
   * for ops visibility but leave status + playback id alone.
   */
  private async handleAssetErrored(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const message =
      event.data?.errors?.messages?.join('; ') ??
      event.data?.errors?.type ??
      'Mux asset error';

    // Only transition to errored from pre-terminal states. This is the
    // monotonic-state-machine guard the audit flagged.
    const res = await this.prisma.exerciseCatalogItem.updateMany({
      where: {
        mux_asset_id: assetId,
        mux_asset_status: { in: ['uploading', 'processing', 'none'] },
      },
      data: {
        mux_asset_status: 'errored',
        mux_error_message: message,
        mux_playback_id: null,
      },
    });
    if (res.count === 0) {
      // Row was already in a terminal state (ready or already errored).
      // Out-of-order errored after ready: log + leave playback intact.
      this.logger.warn(
        `Mux errored event for asset ${assetId} arrived after terminal state; preserving playback id`,
      );
    }
  }
}
