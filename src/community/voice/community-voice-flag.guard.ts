import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { COMMUNITY_DISABLED_BODY } from '../dto/disabled-response.dto';

/**
 * v3-3 voice-notes kill-switch.
 *
 * Rides ON TOP of the master CommunityFeatureFlagGuard (FEATURE_COMMUNITY_API),
 * mirroring the v3-2 sibling in community-classroom-flag.guard.ts. Gates the
 * voice-note WRITE/UPLOAD handlers (issue signed upload URL, publish a voice
 * note). The list/detail GET handlers carry ONLY the master guard so a member's
 * already-published voice notes stay READABLE if the authoring surface is
 * killed mid-rollout.
 *
 * FEATURE_COMMUNITY_VOICE_NOTES defaults OFF (execution plan v3-3 rollout): any
 * value other than the literal 'true' resolves to OFF, matching the
 * resolveClassroomFlag convention v3-2 established. The flag is read at the call
 * site every request (never boot-cached) so a runtime kill takes effect without
 * a redeploy.
 *
 * Defined locally (in src/community/voice/**) rather than appended to the shared
 * write-flag file so the v3-3 slice owns its own kill switch outright and never
 * collides with the parallel v3-2 classroom lane (R71 / R77 scope).
 */
export const FEATURE_COMMUNITY_VOICE_NOTES = 'FEATURE_COMMUNITY_VOICE_NOTES';

/**
 * Optional entitlement gate. When FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT
 * is 'true', a non-entitled caller is rejected (403) at the service layer even
 * if the master + voice flags are on. Default OFF (brief §Feature flags).
 */
export const FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT =
  'FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT';

export function resolveVoiceNotesFlag(): boolean {
  return process.env[FEATURE_COMMUNITY_VOICE_NOTES] === 'true';
}

export function resolveVoiceEntitlementRequired(): boolean {
  return (
    process.env[FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT] === 'true'
  );
}

@Injectable()
export class CommunityVoiceEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveVoiceNotesFlag()) return true;
    throw new HttpException(
      COMMUNITY_DISABLED_BODY,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
