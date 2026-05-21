import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { GoogleOAuthService } from '../google-oauth/google-oauth.service';

// GoogleCalendarWebhookController
//
// Receives Google Calendar Push Notifications:
//   POST /webhooks/google-calendar
//
// RFC-142 (docs/rfcs/142-concierge-scheduling.md) governs this surface.
// Two contracts from that RFC are enforced here:
//
//   1. When FEATURE_GOOGLE_CALENDAR_SYNC is off, this route must answer
//      404 with a structured { code: 'FEATURE_DISABLED' } body — "feature
//      truly not available, not 'configured but broken'". A silent
//      {ok:true} would hide misconfiguration from operators and from
//      Google's delivery dashboard.
//   2. When the feature is on, the X-Goog-Channel-Id header is the
//      *primary* identifier the caller-supplied channel-token check is
//      bound to. We reject malformed deliveries (missing channel-id /
//      resource-id / resource-state) with a structured 400 rather than
//      writing a partial audit row, because Google posts no body —
//      these headers ARE the request, and a missing one almost always
//      indicates a forged request or a proxy that stripped them.
//
// Google posts a request with no body and the following headers
// (https://developers.google.com/calendar/api/guides/push):
//
//   X-Goog-Channel-Id        — channel identifier we supplied at watch().
//                              Bound to the per-channel token check.
//   X-Goog-Channel-Token     — opaque verification token we set at watch().
//   X-Goog-Resource-Id       — opaque ID of the watched resource.
//   X-Goog-Resource-State    — sync | exists | not_exists.
//   X-Goog-Resource-Uri      — URI of the watched resource.
//   X-Goog-Message-Number    — monotonically increasing per-channel.
//
// v1 posture: validate the required headers, write an audit row, and
// return 200 fast. Real sync logic (reconcile the affected event)
// lands in a follow-up; the existing CalendarSyncJob cron remains the
// primary reconciler until then. Returning 200 quickly is mandatory —
// Google retries with backoff if we 5xx, and we do not want to back
// up the push channel.
//
// Auth posture: this route is `@Public()` (Google posts without our
// JWT). The CSRF/poisoning guard is `X-Goog-Channel-Token` — when we
// register the watch we set a per-channel token; if the inbound token
// does not match the row we stored at watch() time, we reject. v1
// hard-codes the token to a single env-driven shared secret because
// the per-channel-token-store table is not yet introduced; documented
// as a follow-up below.
@ApiTags('scheduling')
@Controller('webhooks/google-calendar')
export class GoogleCalendarWebhookController {
  private readonly logger = new Logger(GoogleCalendarWebhookController.name);

  constructor(private readonly audit: AuditService) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: Request): Promise<{ ok: true }> {
    if (!GoogleOAuthService.isFeatureFlagOn()) {
      throw new NotFoundException({
        code: 'FEATURE_DISABLED',
        message: 'Google Calendar integration is not enabled on this environment.',
      });
    }
    const channelId = headerOf(req, 'x-goog-channel-id');
    const resourceId = headerOf(req, 'x-goog-resource-id');
    const resourceState = headerOf(req, 'x-goog-resource-state');
    const messageNumber = headerOf(req, 'x-goog-message-number');
    const channelToken = headerOf(req, 'x-goog-channel-token');
    const resourceUri = headerOf(req, 'x-goog-resource-uri');

    if (!channelId || !resourceId || !resourceState) {
      throw new BadRequestException({
        code: 'GOOGLE_CALENDAR_WEBHOOK_MALFORMED',
        message:
          'Required Google Calendar webhook headers are missing (X-Goog-Channel-Id, X-Goog-Resource-Id, X-Goog-Resource-State).',
      });
    }

    // Shared-secret token check. The watch caller sets the token; we
    // verify it here. When the feature is enabled, a webhook token MUST be
    // configured — fail closed rather than allowing unauthenticated requests
    // through when the env var is absent.
    const expectedToken = process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN?.trim();
    const featureEnabled = process.env.FEATURE_GOOGLE_CALENDAR_SYNC?.toLowerCase() === 'true';

    if (featureEnabled && !expectedToken) {
      this.logger.error('GOOGLE_CALENDAR_WEBHOOK_TOKEN not set — rejecting webhook');
      throw new ForbiddenException({
        code: 'WEBHOOK_TOKEN_NOT_CONFIGURED',
        message: 'Google Calendar webhook token is not configured on this environment.',
      });
    }

    if (expectedToken && channelToken !== expectedToken) {
      throw new ForbiddenException({
        code: 'GOOGLE_CALENDAR_WEBHOOK_TOKEN_MISMATCH',
        message: 'The provided webhook token does not match the configured value.',
      });
    }

    // The very first delivery after we register a watch is always a
    // `sync` event with no real change. We acknowledge it and do
    // nothing else.
    if (resourceState === 'sync') {
      this.logger.log(
        `GoogleCalendar webhook sync handshake channel=${channelId}`,
      );
      await this.audit.write({
        action: AuditAction.CALENDAR_WATCH_STARTED,
        targetId: channelId,
        targetType: 'CalendarChannel',
        metadata: {
          resource_id: resourceId,
          resource_state: resourceState,
          message_number: messageNumber,
          phase: 'sync_handshake',
        },
      });
      return { ok: true };
    }

    this.logger.log(
      `GoogleCalendar webhook channel=${channelId} state=${resourceState} msg=${messageNumber}`,
    );

    // v1: log + audit, dispatch a no-op sync trigger. Follow-up PR
    // wires this to actually reconcile the affected CoachingSession
    // rows. Calling the trigger here keeps the seam discoverable.
    await this.triggerSync({ channelId, resourceId, resourceUri, resourceState });

    await this.audit.write({
      action: AuditAction.CALENDAR_EVENT_UPDATED,
      targetId: channelId,
      targetType: 'CalendarChannel',
      metadata: {
        resource_id: resourceId,
        resource_state: resourceState,
        resource_uri: resourceUri,
        message_number: messageNumber,
      },
    });

    return { ok: true };
  }

  // Visible for tests. v1 is a no-op; replaced by the real reconciler
  // in the follow-up. Returning a Promise so the wiring change is
  // type-stable.
  protected triggerSync(args: {
    channelId: string;
    resourceId: string;
    resourceUri: string | null;
    resourceState: string;
  }): Promise<void> {
    this.logger.debug(
      `Sync trigger is a no-op in v1 — channel=${args.channelId} state=${args.resourceState}`,
    );
    return Promise.resolve();
  }
}

function headerOf(req: Request, key: string): string | null {
  const raw = req.headers?.[key];
  if (Array.isArray(raw)) return raw[0] ?? null;
  if (typeof raw === 'string') return raw;
  return null;
}
