import { Injectable, Logger } from '@nestjs/common';
import {
  CreateVideoLinkInput,
  VideoLinkResult,
  VideoProvider,
} from './scheduling-provider.types';

// Placeholder Zoom adapter. Same pattern as GoogleCalendarAdapter —
// gated behind ZOOM_ENABLED, not invoked unless explicitly opted in.
// The real implementation will call POST /users/{coachAccount}/meetings
// with the Zoom Server-to-Server OAuth token and persist the
// id/join_url. For now it logs and returns a stub-shaped result so
// integration code can exercise the path without credentials.
@Injectable()
export class ZoomVideoAdapter implements VideoProvider {
  readonly name = 'zoom' as const;
  private readonly logger = new Logger(ZoomVideoAdapter.name);

  async createMeeting(input: CreateVideoLinkInput): Promise<VideoLinkResult> {
    this.logger.warn(
      `ZoomVideoAdapter.createMeeting called but real implementation is not wired up yet — returning stub-shaped meeting for idempotencyKey=${input.idempotencyKey}`,
    );
    return {
      joinUrl: `https://zoom.us/j/pending-${input.idempotencyKey}`,
      externalMeetingId: `zoom-pending-${input.idempotencyKey}`,
      resolvedProvider: 'zoom',
    };
  }

  async cancelMeeting(externalMeetingId: string): Promise<void> {
    this.logger.warn(
      `ZoomVideoAdapter.cancelMeeting called but real implementation is not wired up yet — no-op for ${externalMeetingId}`,
    );
  }
}
