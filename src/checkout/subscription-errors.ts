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
import { iso } from './subscription-plan';

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
        message:
          'The last attempt to start this plan did not finish. Nothing was charged. Try again.',
      })
    : new ServiceUnavailableException({
        code: 'PAYMENT_IN_PROGRESS',
        error: 'PAYMENT_IN_PROGRESS',
        message: 'This plan is still being set up. Give it a few seconds, then try again.',
      });
}

export function stripeFailure(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof StripeConnectApiError) {
    const status = err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
    return new HttpException(
      {
        code: 'STRIPE_CHECKOUT_ERROR',
        error: 'STRIPE_CHECKOUT_ERROR',
        message:
          'The payment service did not answer as expected. Nothing was charged. Try again in a minute.',
        stripeCode: err.stripeCode,
      },
      status === 400 || status === 402 ? 502 : status,
    );
  }
  throw err;
}
