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
//   - Logs the payload's shape at debug level: a known event name and
//     known top-level keys, a count of the rest, never a value
//     (C-611-17, B-700-2).
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
// payload's shape only. B-700-2 / C-700-5: the stubs are public and
// unauthenticated when SCHEDULING_WEBHOOK_SECRET is unset, so any string in
// the body (an event name, a key) can be a name someone typed. The line names
// only labels from these finite lists; anything else is counted, never shown.
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  // Zoom (developers.zoom.us webhook reference): the meeting events a
  // session mirror would use, plus the endpoint check.
  'endpoint.url_validation',
  'meeting.created',
  'meeting.updated',
  'meeting.deleted',
  'meeting.started',
  'meeting.ended',
  'meeting.participant_joined',
  'meeting.participant_left',
  'recording.completed',
]);
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  // Zoom envelope.
  'event',
  'event_ts',
  'payload',
  'download_token',
  // Google Calendar push-notification channel fields.
  'kind',
  'id',
  'resourceId',
  'resourceUri',
  'token',
  'expiration',
]);
function payloadShape(v: unknown): string {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return `type=${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v}`;
  }
  const record = v as Record<string, unknown>;
  const event =
    typeof record.event !== 'string'
      ? 'none'
      : KNOWN_EVENTS.has(record.event)
        ? record.event
        : 'other';
  const allKeys = Object.keys(record);
  const known = allKeys.filter((k) => KNOWN_KEYS.has(k));
  const otherKeys = allKeys.length - known.length;
  return `event=${event} keys=${known.join(',') || 'none'} other_keys=${otherKeys}`;
}
