import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { coachBriefRomanEnabled } from './roman-brief.feature';

/**
 * A5-COACH-BRIEF — 404 on every /coach/brief/drafts route while
 * FEATURE_COACH_BRIEF_ROMAN is not exactly 'true'. 404 (not 403) so a dark
 * surface does not advertise itself; mobile treats it as "hide the entry
 * point". Same posture as CoachBriefEnabledGuard and AiTriageFeatureFlagGuard.
 */
@Injectable()
export class RomanBriefFlagGuard implements CanActivate {
  canActivate(): boolean {
    if (!coachBriefRomanEnabled()) {
      throw new NotFoundException({
        code: 'coach_brief.roman_unavailable',
        message: 'Roman drafts are not available on this account yet.',
      });
    }
    return true;
  }
}
