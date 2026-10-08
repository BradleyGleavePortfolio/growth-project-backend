import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

// CF-COACH-PAY-BE-128: coach payments per client (list, refund, pause/resume,
// cancel). Default off: only the exact value "true" turns it on.
export function isCoachPaymentActionsEnabled(): boolean {
  return process.env.FEATURE_COACH_PAYMENT_ACTIONS === 'true';
}

/** While the flag is off every route answers 404, as if it did not exist. */
@Injectable()
export class CoachPaymentActionsFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (!isCoachPaymentActionsEnabled()) throw new NotFoundException('Not Found');
    return true;
  }
}
