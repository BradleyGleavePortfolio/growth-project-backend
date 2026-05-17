import { Injectable } from '@nestjs/common';
import {
  CreateVideoLinkInput,
  VideoLinkResult,
  VideoProvider,
} from './scheduling-provider.types';

// Default video adapter — returns null for joinUrl to signal that no
// real video link has been provisioned. The service layer and mobile
// client must treat a null/empty joinUrl as "no video link yet" and
// surface the manual-link entry affordance in the coach UI.
// Previously this returned a `tgp-stub://session/<key>` URL, which
// leaked into booking emails and session rows as a fake link. Setting
// it to null ensures sessions only carry a video link when the coach
// explicitly attaches one via POST /scheduling/sessions/:id/manual-video-link.
@Injectable()
export class StubVideoAdapter implements VideoProvider {
  readonly name = 'stub' as const;

  async createMeeting(input: CreateVideoLinkInput): Promise<VideoLinkResult> {
    return {
      // Intentionally null: no video link is provisioned by the stub.
      // Coaches must attach a manual link via the dedicated endpoint.
      joinUrl: null as unknown as string,
      externalMeetingId: `stub-vid-${input.idempotencyKey}`,
      resolvedProvider: 'stub',
    };
  }

  async cancelMeeting(_externalMeetingId: string): Promise<void> {
    // No-op.
  }
}
