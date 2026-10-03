import { CanActivate, Injectable } from '@nestjs/common';
import { COACHLESS_ERROR, CoachlessError } from './coachless.errors';

/** Kill switch name. Defaults OFF: only the literal 'true' enables the coachless surfaces. */
export const COACHLESS_FLAG_ENV = 'FEATURE_COACHLESS_HOME';

/** Read per request (never boot-cached) so a runtime kill takes effect without a redeploy. */
export function coachlessHomeEnabled(): boolean {
  return process.env.FEATURE_COACHLESS_HOME === 'true';
}

/** Every client-facing /coachless/* route answers 404 coachless_disabled while the flag is off. */
@Injectable()
export class CoachlessFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (!coachlessHomeEnabled()) throw new CoachlessError(COACHLESS_ERROR.COACHLESS_DISABLED);
    return true;
  }
}
