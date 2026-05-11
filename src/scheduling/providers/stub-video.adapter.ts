import { Injectable } from '@nestjs/common';
import {
  CreateVideoLinkInput,
  VideoLinkResult,
  VideoProvider,
} from './scheduling-provider.types';

// Default video adapter — returns a tgp-stub:// URL. The mobile/web
// client recognises this scheme as "no real video link yet" and surfaces
// a manual-link affordance in the coach UI.
@Injectable()
export class StubVideoAdapter implements VideoProvider {
  readonly name = 'stub' as const;

  async createMeeting(input: CreateVideoLinkInput): Promise<VideoLinkResult> {
    return {
      joinUrl: `tgp-stub://session/${input.idempotencyKey}`,
      externalMeetingId: `stub-vid-${input.idempotencyKey}`,
      resolvedProvider: 'stub',
    };
  }

  async cancelMeeting(_externalMeetingId: string): Promise<void> {
    // No-op.
  }
}
