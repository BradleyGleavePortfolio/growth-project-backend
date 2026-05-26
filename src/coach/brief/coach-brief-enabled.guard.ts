// src/coach/brief/coach-brief-enabled.guard.ts
//
// P1-2 \u2014 server-side kill switch for the Coach Brief surface. Reads the
// boot-validated `COACH_BRIEF_ENABLED` env var (see env-validation.ts) and
// returns 404 NOT_FOUND on every Coach Brief route when the flag is "off".
//
// 404 (not 403) by design \u2014 a disabled feature should not advertise its
// existence to authenticated callers. The mobile app already treats 404
// from this surface as "feature unavailable, hide the entry point", so
// flipping the flag at runtime drains the surface cleanly without a
// client deploy.
//
// The flag is also enforced at the scheduler boundary (see
// CoachBriefScheduler.dispatchDailyBriefs). That separation is intentional:
// the controller guard protects on-demand reads/writes; the scheduler
// short-circuit protects the cron-driven push path.

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export function coachBriefEnabled(config: ConfigService): boolean {
  const raw = config.get<string>('COACH_BRIEF_ENABLED');
  if (raw === undefined || raw === null) return true;
  return raw.trim().toLowerCase() !== 'off';
}

@Injectable()
export class CoachBriefEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(_context: ExecutionContext): boolean {
    if (!coachBriefEnabled(this.config)) {
      // 404 hides the surface from disabled deployments. The message
      // string is intentionally generic \u2014 see R17 (no internal state
      // leak in error payloads).
      throw new NotFoundException('Not Found');
    }
    return true;
  }
}
