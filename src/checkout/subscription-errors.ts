// B-RECUR (split R1 of #654; inert until R2 wires it) — the coded answers
// of the native subscription checkout, moved verbatim out of
// subscription-checkout.service.ts (R2) as plain functions (operator 116
// size ruling). Nothing in R1 calls this file.
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { StripeConnectApiError } from '../connect/stripe-connect-api.service';
import { SUPPORT_EMAIL } from '../public-pages/trust-pages.html';
import { iso } from './subscription-plan';

/** B-679-6 — the next step of an outcome the payment service has not confirmed. */
const CHECK_THEN_SUPPORT = `Open Your plan to check whether it started before you try again. If it keeps happening, contact support at ${SUPPORT_EMAIL} and include the reference shown with this message.`;

export function alreadyIncluded(row: ClientPurchase): HttpException {
  const source = row.source ?? '';
  const includedBy: 'invite' | 'free_claim' | 'purchase' = source.startsWith('invite_grant')
    ? 'invite'
    : source === 'free_package_claim'
      ? 'free_claim'
      : 'purchase';
  return new ConflictException({
    code: 'PACKAGE_ALREADY_INCLUDED',
    error: 'PACKAGE_ALREADY_INCLUDED',
    message:
      includedBy === 'purchase'
        ? 'You already have this plan, so nothing was charged. Open Your plan to see it.'
        : 'This plan is already included for you through your coach, so there is nothing to pay. Open Your plan to see it.',
    purchase_id: row.id,
    included_by: includedBy,
    access_expires_at: iso(row.access_expires_at),
  });
}

export function coachNotConnected(reason: 'no_coach' | 'other_coach'): HttpException {
  return new ConflictException({
    code: 'PACKAGE_COACH_NOT_CONNECTED',
    error: 'PACKAGE_COACH_NOT_CONNECTED',
    message:
      reason === 'no_coach'
        ? 'This plan is from a coach you are not connected with yet, so it cannot be started from this account. Nothing was charged. Ask that coach for their invite code, join with it, then open the link again.'
        : 'This plan is from a different coach than yours, so it cannot be started from this account. Nothing was charged. Message the coach who shared the link.',
    reason,
  });
}

export function attemptExpired(reason: 'timed_out' | 'terms_changed'): HttpException {
  return new ConflictException({
    code: 'SUBSCRIPTION_ATTEMPT_EXPIRED',
    error: 'SUBSCRIPTION_ATTEMPT_EXPIRED',
    message:
      reason === 'terms_changed'
        ? 'The terms of this plan changed after this checkout started, so it was closed. Nothing was charged. Start again to see the current terms.'
        : 'This checkout timed out before it was paid. Nothing was charged. Start again to see the current price.',
    reason,
  });
}

export function packageIsFree(): HttpException {
  return new BadRequestException({
    code: 'PACKAGE_IS_FREE',
    error: 'PACKAGE_IS_FREE',
    message: 'This plan is free. Claim it from the plan screen; no card is needed.',
  });
}

export function alreadyActive(row: ClientPurchase): HttpException {
  return new ConflictException({
    code: 'SUBSCRIPTION_ALREADY_ACTIVE',
    error: 'SUBSCRIPTION_ALREADY_ACTIVE',
    message: row.cancel_at_period_end
      ? 'You already have this plan, and it is set to end at the close of this period. Keep it from Your plan instead of starting it again.'
      : 'You already have this plan, so nothing more was charged. Open Your plan to see your next charge date.',
    purchase_id: row.id,
    cancel_at_period_end: row.cancel_at_period_end,
    current_period_end: iso(row.current_period_end),
  });
}

export function packageUnavailable(): HttpException {
  return new NotFoundException({
    code: 'PACKAGE_NOT_FOUND',
    error: 'PACKAGE_NOT_FOUND',
    message:
      'This plan is no longer available. Pull down to refresh your coach’s plans, or message your coach.',
  });
}

export function planNotFound(): HttpException {
  return new NotFoundException({
    code: 'PURCHASE_NOT_FOUND',
    error: 'PURCHASE_NOT_FOUND',
    message: 'That plan was not found on your account. Pull down to refresh your plans.',
  });
}

export function inProgress(retryable: boolean): HttpException {
  return retryable
    ? new ServiceUnavailableException({
        code: 'PAYMENT_RETRY',
        error: 'PAYMENT_RETRY',
        // B-679-6 — the outcome is unknown here: never a no-charge claim.
        message: `The last attempt to start this plan did not finish, and its result is not confirmed yet. ${CHECK_THEN_SUPPORT}`,
      })
    : new ServiceUnavailableException({
        code: 'PAYMENT_IN_PROGRESS',
        error: 'PAYMENT_IN_PROGRESS',
        message: 'This plan is still being set up. Give it a few seconds, then try again.',
      });
}

/**
 * B-679-6 — `noCharge` only where it is proven (nothing reached Stripe, or
 * Stripe refused the create); otherwise the answer says the result is unknown.
 */
export function stripeFailure(err: unknown, noCharge = false): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof StripeConnectApiError) {
    const status = err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
    return new HttpException(
      {
        code: 'STRIPE_CHECKOUT_ERROR',
        error: 'STRIPE_CHECKOUT_ERROR',
        message: noCharge
          ? 'The payment service did not answer as expected. Nothing was charged. Try again in a minute.'
          : `The payment service did not answer as expected, so this step did not finish. ${CHECK_THEN_SUPPORT}`,
        stripeCode: err.stripeCode,
      },
      status === 400 || status === 402 ? 502 : status,
    );
  }
  throw err;
}

/** B-679-2 — a client key already started another plan; it never relabels that attempt. */
export function keyOtherPlan(): HttpException {
  return new ConflictException({
    code: 'CHECKOUT_KEY_OTHER_PLAN',
    error: 'CHECKOUT_KEY_OTHER_PLAN',
    message:
      'This checkout was opened for a different plan. Close it, then start this plan again from your coach’s plans.',
  });
}

/** B-679-6 — the sheet could not be prepared; no-charge only once the attempt is confirmed closed. */
export function setupUnavailable(closed: boolean): HttpException {
  return new ServiceUnavailableException({
    code: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
    error: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
    message: closed
      ? 'The card screen could not be prepared for this plan. Nothing was charged. Try again in a minute.'
      : `The card screen could not be prepared for this plan, and closing it is not confirmed yet. ${CHECK_THEN_SUPPORT}`,
  });
}

/** Sol B-679-4 — the change was sent, but Stripe's current state was not read back. */
export function planChangeUnconfirmed(): HttpException {
  return new ServiceUnavailableException({
    code: 'PLAN_CHANGE_UNCONFIRMED',
    error: 'PLAN_CHANGE_UNCONFIRMED',
    message: `The change to this plan was sent, but the payment service has not confirmed it yet. Refresh Your plan in a minute, and choose Keep plan again if it still shows an end date. If it keeps happening, contact support at ${SUPPORT_EMAIL}.`,
  });
}
