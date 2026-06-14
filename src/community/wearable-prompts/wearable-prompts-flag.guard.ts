import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { COMMUNITY_DISABLED_BODY } from '../dto/disabled-response.dto';

/**
 * v3-4 wearable-aware coaching-prompts kill-switch.
 *
 * Rides ON TOP of the master CommunityFeatureFlagGuard (FEATURE_COMMUNITY_API),
 * mirroring the v3-2 / v3-3 / search siblings. Gates BOTH the coach read surface
 * (list / dismiss / act-on prompts) and the generation endpoint. Read at the
 * call site every request (never boot-cached) so a runtime kill is immediate.
 *
 * FEATURE_COMMUNITY_WEARABLE_PROMPTS defaults OFF: any value other than the
 * literal 'true' resolves to OFF, matching the established resolve* convention.
 *
 * Defined locally (in src/community/wearable-prompts/**) so the v3-4 slice owns
 * its kill switch outright and never collides with parallel lanes (R77 scope).
 */
export const FEATURE_COMMUNITY_WEARABLE_PROMPTS =
  'FEATURE_COMMUNITY_WEARABLE_PROMPTS';

export function resolveWearablePromptsFlag(): boolean {
  return process.env[FEATURE_COMMUNITY_WEARABLE_PROMPTS] === 'true';
}

@Injectable()
export class CommunityWearablePromptsEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveWearablePromptsFlag()) return true;
    throw new HttpException(
      COMMUNITY_DISABLED_BODY,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
