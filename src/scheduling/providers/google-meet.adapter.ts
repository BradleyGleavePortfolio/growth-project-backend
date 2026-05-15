import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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
    // QA P0-S1. The previous behaviour returned a `pending-<key>` URL and
    // only logged a warning. That URL was then persisted on the session,
    // shipped in booking-reminder emails/pushes, and recorded in audit as
    // a successful provisioning. The honest failure is the operator either
    // (a) leaves GOOGLE_MEET_ENABLED unset (registry falls back to stub),
    // or (b) ships the real adapter. Until (b), an explicit
    // ServiceUnavailable forces the call site to handle it instead of
    // silently producing fake invites.
    this.logger.error(
      `GoogleMeetAdapter.createMeeting called but real implementation is not wired up; idempotencyKey=${input.idempotencyKey}`,
    );
    throw new ServiceUnavailableException({
      error: 'VIDEO_PROVIDER_NOT_IMPLEMENTED',
      provider: 'google_meet',
      message:
        'Google Meet integration is enabled but the real adapter has not shipped. Set GOOGLE_MEET_ENABLED=false to route through the stub provider, or wait for the real adapter.',
    });
  }

  async cancelMeeting(_externalMeetingId: string): Promise<void> {
    // Cancellation rides on the Calendar event delete; nothing to do here.
  }
}
