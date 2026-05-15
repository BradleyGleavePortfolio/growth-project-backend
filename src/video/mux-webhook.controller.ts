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
  type?: string;
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
   * as a tracker — if we already have the row by asset id, mark
   * processing; otherwise no-op (the attach endpoint set processing
   * inline).
   */
  private async handleAssetCreated(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    await this.prisma.exerciseCatalogItem.updateMany({
      where: { mux_asset_id: assetId, mux_asset_status: 'uploading' },
      data: { mux_asset_status: 'processing' },
    });
  }

  private async handleAssetReady(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const playbackIds = event.data?.playback_ids ?? [];
    const first = playbackIds[0];
    await this.prisma.exerciseCatalogItem.updateMany({
      where: { mux_asset_id: assetId },
      data: {
        mux_asset_status: 'ready',
        mux_playback_id: first?.id ?? null,
        mux_playback_policy: first?.policy ?? 'public',
        mux_duration_seconds: event.data?.duration ?? null,
        mux_error_message: null,
      },
    });
  }

  private async handleAssetErrored(event: MuxEvent): Promise<void> {
    const assetId = event.data?.id;
    if (!assetId) return;
    const message =
      event.data?.errors?.messages?.join('; ') ??
      event.data?.errors?.type ??
      'Mux asset error';
    await this.prisma.exerciseCatalogItem.updateMany({
      where: { mux_asset_id: assetId },
      data: {
        mux_asset_status: 'errored',
        mux_error_message: message,
        mux_playback_id: null,
      },
    });
  }
}
