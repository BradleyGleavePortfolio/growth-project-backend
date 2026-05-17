import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  CreateVideoLinkInput,
  VideoLinkResult,
  VideoProvider,
} from './scheduling-provider.types';

// Placeholder Zoom adapter. Same pattern as GoogleCalendarAdapter —
// gated behind ZOOM_ENABLED, not invoked unless explicitly opted in.
// The real implementation will call POST /users/{coachAccount}/meetings
// with the Zoom Server-to-Server OAuth token and persist the
// id/join_url.
@Injectable()
export class ZoomVideoAdapter implements VideoProvider {
  readonly name = 'zoom' as const;
  private readonly logger = new Logger(ZoomVideoAdapter.name);

  async createMeeting(input: CreateVideoLinkInput): Promise<VideoLinkResult> {
    // QA P0-S1. See GoogleMeetAdapter for the rationale — refuse to
    // fabricate a `zoom.us/j/pending-<key>` URL when ZOOM_ENABLED=true
    // but the real adapter hasn't shipped.
    this.logger.error(
      `ZoomVideoAdapter.createMeeting called but real implementation is not wired up; idempotencyKey=${input.idempotencyKey}`,
    );
    throw new ServiceUnavailableException({
      error: 'VIDEO_PROVIDER_NOT_IMPLEMENTED',
      provider: 'zoom',
      message:
        'Zoom integration is enabled but the real adapter has not shipped. Set ZOOM_ENABLED=false to route through the stub provider, or wait for the real adapter.',
    });
  }

  async cancelMeeting(externalMeetingId: string): Promise<void> {
    this.logger.warn(
      `ZoomVideoAdapter.cancelMeeting called; no-op for ${externalMeetingId}`,
    );
  }
}
