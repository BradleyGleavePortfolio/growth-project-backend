import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { z } from 'zod';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { OuraConnector } from './oura.connector';
import { OuraWebhookEvent } from './oura.types';

/**
 * PR-HK-2.k — Oura webhook receiver.
 *
 * `POST /v1/wearables/webhooks/oura` — Oura pushes one event per changed
 * object. Security model (mirrors StripeWebhookController):
 *  1. `@Public` — Oura is not a Supabase user; auth is the HMAC, not a JWT.
 *  2. Raw-body HMAC verify FIRST (constant-time). Invalid → 401, no handling.
 *  3. Zod-validate the parsed payload (#8). Malformed → 400.
 *  4. Replay/idempotency via `WearableProcessedEvent` (provider='OURA',
 *     provider_event_id) — a duplicate is a 200 no-op (#28/#29).
 *  5. Resolve the connection (by Oura user_id), fetch ONLY the just-changed
 *     record, normalize, and batch-ingest via IngestionService (#21 no N+1).
 *  6. Mark the event handled.
 * Throttled (#6). Never logs raw payloads — only redacted metadata (#12/#36).
 *
 * Oura also performs a one-time GET verification handshake when a subscription
 * is created (`?verification_token=&challenge=`): we echo the challenge.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
export class OuraWebhookController {
  private readonly logger = new Logger(OuraWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly connector: OuraConnector,
  ) {}

  /**
   * Oura subscription verification handshake. Oura issues a GET with the
   * `verification_token` we configured and a random `challenge`; we must echo
   * `{ challenge }`. The token is matched against `OURA_VERIFICATION_TOKEN` to
   * reject spoofed verification probes.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('oura')
  @ApiOperation({ summary: 'Oura webhook subscription verification handshake' })
  verify(
    @Query('verification_token') token: string,
    @Query('challenge') challenge: string,
  ): { challenge: string } {
    const expected = process.env.OURA_VERIFICATION_TOKEN;
    if (!expected || token !== expected || !challenge) {
      throw new UnauthorizedException('Invalid Oura verification handshake');
    }
    return { challenge };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('oura')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive an Oura Cloud webhook event' })
  async handle(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    // (2) Raw body is the only signature source we trust.
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Oura webhook received without rawBody. Verify rawBody middleware is wired for /v1/wearables/webhooks/oura in main.ts.',
      );
      throw new BadRequestException('Oura webhook raw body unavailable');
    }

    const verified = this.connector.verifyWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!verified) {
      // Do NOT reveal which check failed. One 401 for all signature failures.
      throw new UnauthorizedException('Invalid Oura webhook signature');
    }

    // (3) Zod-validate the parsed payload. Unknown fields are ignored safely.
    const event = this.parseAndValidate(rawBody);

    const providerEventId = this.connector.eventId(event);

    // (4) Replay protection. A prior row for (OURA, providerEventId) means we
    // already handled this delivery → 200 no-op.
    const existing = await this.prisma.wearableProcessedEvent.findUnique({
      where: {
        provider_provider_event_id: {
          provider: WearableProvider.OURA,
          provider_event_id: providerEventId,
        },
      },
    });
    if (existing) {
      this.logger.log({
        msg: 'wearables.oura.webhook.replay_noop',
        provider: 'OURA',
        data_type: event.data_type,
        event_type: event.event_type,
      });
      return { ok: true };
    }

    // Record the event up-front so concurrent redeliveries collapse to a
    // single handling (composite PK makes the insert idempotent).
    try {
      await this.prisma.wearableProcessedEvent.create({
        data: {
          provider: WearableProvider.OURA,
          provider_event_id: providerEventId,
          type: `${event.data_type}.${event.event_type}`,
        },
      });
    } catch (err) {
      // Unique-violation → a concurrent delivery beat us to it: treat as
      // replay no-op rather than 500.
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log({
          msg: 'wearables.oura.webhook.concurrent_replay_noop',
          provider: 'OURA',
          data_type: event.data_type,
        });
        return { ok: true };
      }
      throw err;
    }

    // (5) Resolve the connection by Oura user id, fetch the just-changed
    // record, normalize, and batch-ingest. A delete event has nothing to
    // fetch — we record it and stop.
    if (event.event_type !== 'delete') {
      const connection = await this.prisma.wearableConnection.findFirst({
        where: {
          provider: WearableProvider.OURA,
          external_account_id: event.user_id,
          disconnected_at: null,
        },
      });

      if (connection) {
        try {
          const raw = await this.connector.fetchChangedRecord(
            connection,
            event,
          );
          const samples = this.connector.normalize(raw);
          if (samples.length > 0) {
            await this.ingestion.ingest(samples);
          }
        } catch (err) {
          // Fail-explicit: mark the connection in error, log redacted, and
          // rethrow so the delivery is retried (no silent swallow, #36/#50).
          await this.prisma.wearableConnection
            .update({
              where: { id: connection.id },
              data: {
                status: 'error',
                last_error: (err as Error)?.message?.slice(0, 500) ?? 'unknown',
              },
            })
            .catch(() => undefined);
          this.logger.error({
            msg: 'wearables.oura.webhook.ingest_failure',
            provider: 'OURA',
            data_type: event.data_type,
            error_message: (err as Error)?.message ?? String(err),
          });
          throw err;
        }
      } else {
        this.logger.warn({
          msg: 'wearables.oura.webhook.no_connection',
          provider: 'OURA',
          data_type: event.data_type,
        });
      }
    }

    // (6) Mark handled.
    await this.prisma.wearableProcessedEvent
      .update({
        where: {
          provider_provider_event_id: {
            provider: WearableProvider.OURA,
            provider_event_id: providerEventId,
          },
        },
        data: { handler_completed_at: new Date() },
      })
      .catch(() => undefined);

    this.logger.log({
      msg: 'wearables.oura.webhook.handled',
      provider: 'OURA',
      data_type: event.data_type,
      event_type: event.event_type,
    });
    return { ok: true };
  }

  /**
   * Zod schema for the Oura webhook event payload. `.passthrough()` keeps
   * unknown fields from rejecting the request (ignored safely), but the five
   * fields we depend on are required + typed.
   */
  private parseAndValidate(rawBody: Buffer): OuraWebhookEvent {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Oura webhook payload is not valid JSON');
    }

    const schema = z
      .object({
        event_type: z.enum(['create', 'update', 'delete']),
        data_type: z.string().min(1),
        object_id: z.string().min(1),
        event_time: z.string().min(1),
        user_id: z.string().min(1),
      })
      .passthrough();

    const result = schema.safeParse(json);
    if (!result.success) {
      // Redacted: report field paths, never the raw payload values.
      throw new BadRequestException(
        `Oura webhook payload failed validation: ${result.error.issues
          .map((i) => i.path.join('.'))
          .join(', ')}`,
      );
    }
    return result.data as OuraWebhookEvent;
  }
}
