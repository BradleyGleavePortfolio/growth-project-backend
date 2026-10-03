import { BadRequestException } from '@nestjs/common';

// B-TRIALS (OR-113-2) — free trial rules for packages.
//
// Owner decision 2026-10-02 16:34 PDT: "Real free trials on packages: yes".
// A coach sets a free trial on a RECURRING package. The card is collected up
// front, the client is charged automatically when the trial ends unless they
// cancel, one trial per client per coach (PackageTrialUsage), and cancelling
// during the trial means the client is never charged and access ends at the
// trial end.
//
// This file is the single source of truth for the trial length rules; the
// database CHECK "CoachPackage_trial_days_check" mirrors them as a backstop.

/** No trial. Every package created before trials existed has this value. */
export const TRIAL_DAYS_NONE = 0;
/** Longest free trial a coach can offer, in days. */
export const TRIAL_DAYS_MAX = 30;
/** Lengths the coach editor recommends (any whole number 1..30 is valid). */
export const TRIAL_DAY_PRESETS: readonly number[] = [3, 7, 14, 30];

/** Stable machine codes for every trial refusal. */
export const TrialErrorCode = {
  /** trial_days is not a whole number between 0 and 30. */
  OUT_OF_RANGE: 'PACKAGE_TRIAL_DAYS_OUT_OF_RANGE',
  /** A trial was set on a one-time package or a one-time + recurring combo. */
  REQUIRES_RECURRING: 'PACKAGE_TRIAL_REQUIRES_RECURRING',
  /** A trial was set on a free ($0) package. */
  NOT_ON_FREE: 'PACKAGE_TRIAL_NOT_ON_FREE',
  /** This client already had a free trial with this coach. */
  ALREADY_USED: 'TRIAL_ALREADY_USED',
} as const;
export type TrialErrorCode = (typeof TrialErrorCode)[keyof typeof TrialErrorCode];

export interface TrialShape {
  trial_days: number;
  amount_cents: number;
  billing_type?: string | null;
  recurring_amount_cents?: number | null;
  recurring_interval?: string | null;
  recurring_interval_count?: number | null;
}

/**
 * Refuses any trial the product does not offer, with a machine code and a
 * message that tells the coach what to change. Called by PackagesService on
 * create, update (merged shape) and publish.
 */
export function assertValidTrial(input: TrialShape): void {
  const days = input.trial_days;
  if (!Number.isInteger(days) || days < TRIAL_DAYS_NONE || days > TRIAL_DAYS_MAX) {
    throw new BadRequestException({
      error: TrialErrorCode.OUT_OF_RANGE,
      code: TrialErrorCode.OUT_OF_RANGE,
      message: `A free trial is a whole number of days from 1 to ${TRIAL_DAYS_MAX}, or 0 for no trial. 3, 7, 14 or 30 days work well.`,
      field: 'trial_days',
      min_days: TRIAL_DAYS_NONE,
      max_days: TRIAL_DAYS_MAX,
      presets: TRIAL_DAY_PRESETS,
    });
  }
  if (days === TRIAL_DAYS_NONE) return;
  if (input.amount_cents === 0) {
    throw new BadRequestException({
      error: TrialErrorCode.NOT_ON_FREE,
      code: TrialErrorCode.NOT_ON_FREE,
      message: 'A free package has nothing to try first. Remove the trial, or set a price.',
      field: 'trial_days',
    });
  }
  const hasCompanion =
    input.recurring_amount_cents != null ||
    input.recurring_interval != null ||
    input.recurring_interval_count != null;
  if (input.billing_type !== 'recurring' || hasCompanion) {
    throw new BadRequestException({
      error: TrialErrorCode.REQUIRES_RECURRING,
      code: TrialErrorCode.REQUIRES_RECURRING,
      message: hasCompanion
        ? 'Free trials work on plans that renew with no charge today. Remove the one-time price or the trial.'
        : 'Free trials work on plans that renew. Make this package renew, or remove the trial.',
      field: 'trial_days',
    });
  }
}

/**
 * Stripe subscription parameters for a trial (Stripe-Version
 * 2024-09-30.acacia). For the subscription creator (lane B-RECUR): spread the
 * result into the subscriptions.create body when `trialDays > 0`.
 *
 * `trial_settings.end_behavior.missing_payment_method = cancel` is the
 * server-side "card up front" guarantee: if the PaymentSheet was abandoned
 * and no card was saved, Stripe cancels the subscription at the trial end
 * instead of issuing an unpaid invoice, so nobody is ever charged without a
 * card on file and nobody keeps access for free.
 */
export function stripeTrialParams(trialDays: number): Record<string, string> {
  if (!Number.isInteger(trialDays) || trialDays <= 0) return {};
  return {
    trial_period_days: String(trialDays),
    'trial_settings[end_behavior][missing_payment_method]': 'cancel',
    // The card saved through the setup-mode PaymentSheet must land on the
    // subscription itself: the webhook grants trial access only when
    // subscription.default_payment_method is set (card collected up front).
    'payment_settings[save_default_payment_method]': 'on_subscription',
  };
}
