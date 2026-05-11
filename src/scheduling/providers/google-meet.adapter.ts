import { Injectable, Logger } from '@nestjs/common';
import {
  CreateVideoLinkInput,
  VideoLinkResult,
  VideoProvider,
} from './scheduling-provider.types';

// Google Meet doesn't have its own API for ad-hoc meetings — the real
// path is "create the Calendar event with conferenceData=true". This
// adapter exists so the service layer can declare video_provider=
// google_meet on a session and the registry routes correctly. When the
// google_calendar adapter is wired up, it will populate the meeting
// link, and this adapter delegates to the same idempotency key.
@Injectable()
export class GoogleMeetAdapter implements VideoProvider {
  readonly name = 'google_meet' as const;
  private readonly logger = new Logger(GoogleMeetAdapter.name);

  async createMeeting(input: CreateVideoLinkInput): Promise<VideoLinkResult> {
    this.logger.warn(
      `GoogleMeetAdapter.createMeeting called but real implementation is not wired up yet — returning stub-shaped meeting for idempotencyKey=${input.idempotencyKey}`,
    );
    return {
      joinUrl: `https://meet.google.com/pending-${input.idempotencyKey}`,
      externalMeetingId: `gmeet-pending-${input.idempotencyKey}`,
      resolvedProvider: 'google_meet',
    };
  }

  async cancelMeeting(_externalMeetingId: string): Promise<void> {
    // Cancellation rides on the Calendar event delete; nothing to do here.
  }
}
