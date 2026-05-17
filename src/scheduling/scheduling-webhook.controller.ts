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
//   - Logs the body at debug level so operators can replay if needed.
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
      `google-calendar webhook stub received payload (no-op): ${safeStringify(body)}`,
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
      `zoom webhook stub received payload (no-op): ${safeStringify(body)}`,
    );
    return { ok: true, handler: 'stub' };
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 1000);
  } catch {
    return '[unserializable]';
  }
}
