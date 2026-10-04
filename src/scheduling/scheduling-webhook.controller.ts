import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';

// Webhook handler stubs for Google / Zoom callbacks.
//
// C9: Webhook handlers will be implemented when real calendar/video
// integrations ship. Until then all handlers are no-ops.
//
// Real handlers will:
//   - Verify the provider signature on the request (Google's
//     X-Goog-Channel-Token, Zoom's signature header).
//   - Look up the CoachingSession by external id.
//   - Record an audit entry under SESSION_PROVIDER_* and update the
//     row to mirror provider-side state.
//
// This stub:
//   - Accepts and 200s any payload (signature unverified) so smoke
//     tests can exercise the route shape end-to-end.
//   - Is gated by @Public() because providers don't carry our JWT.
//   - Logs the payload's shape (event name, top-level keys) at debug
//     level, never its values (C-611-17).
//
// SECURITY: do NOT add any state mutation here without first wiring
// signature verification. The current handler is read-only / log-only.
@ApiTags('scheduling')
@Controller('scheduling/webhooks')
export class SchedulingWebhookController {
  private readonly logger = new Logger(SchedulingWebhookController.name);

  @ApiOperation({
    summary: 'Google Calendar push-notification webhook (stub)',
    description:
      'Stub: returns 200 without verifying the X-Goog-Channel-Token. Wire signature verification before any state mutation lands here.',
  })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged.' })
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('google-calendar')
  @HttpCode(HttpStatus.OK)
  async googleCalendar(@Body() body: unknown, @Req() req: Request) {
    // SECURITY: signature validation must be wired before any state mutation
    // is added to this handler.
    const secret = process.env.SCHEDULING_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-webhook-secret'];
      if (provided !== secret) throw new ForbiddenException('Invalid webhook secret');
    }
    this.logger.debug(
      `google-calendar webhook stub received payload (no-op): ${payloadShape(body)}`,
    );
    return { ok: true, handler: 'stub' };
  }

  @ApiOperation({
    summary: 'Zoom event webhook (stub)',
    description:
      'Stub: returns 200 without verifying the Zoom signature. Wire signature verification before any state mutation lands here.',
  })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged.' })
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('zoom')
  @HttpCode(HttpStatus.OK)
  async zoom(@Body() body: unknown, @Req() req: Request) {
    // SECURITY: signature validation must be wired before any state mutation
    // is added to this handler.
    const secret = process.env.SCHEDULING_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-webhook-secret'];
      if (provided !== secret) throw new ForbiddenException('Invalid webhook secret');
    }
    this.logger.debug(
      `zoom webhook stub received payload (no-op): ${payloadShape(body)}`,
    );
    return { ok: true, handler: 'stub' };
  }
}

// C-611-17: provider payloads carry participant names and email addresses
// (Zoom's participant.user_name / participant.email), so the stub logs the
// payload's shape only: the event name when it is a plain dotted token, and
// the top-level keys. Never a value.
const EVENT_TOKEN = /^[a-z0-9_.-]{1,64}$/i;
const KEY_TOKEN = /^[a-z0-9_$-]{1,40}$/i;
function payloadShape(v: unknown): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return `type=${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v}`;
  }
  const record = v as Record<string, unknown>;
  const event =
    typeof record.event === 'string' && EVENT_TOKEN.test(record.event) ? record.event : 'none';
  const keys = Object.keys(record)
    .slice(0, 20)
    .map((k) => (KEY_TOKEN.test(k) ? k : '?'))
    .join(',');
  return `event=${event} keys=${keys}`;
}
