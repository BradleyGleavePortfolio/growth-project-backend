// B-TRIALS (OR-113-2) — client-facing trial copy. Quiet Luxury rules: plain
// warm words, no emojis, no exclamation marks, no first person. Every string
// names the date and, when a charge is coming, the exact amount.

/** "$49" for whole amounts, "$49.99" otherwise; other currencies by code. */
export function formatTrialAmount(amountCents: number, currency: string): string {
  const code = (currency || 'usd').toUpperCase();
  const whole = amountCents % 100 === 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(whole ? 0 : 2)} ${code}`;
  }
}

/** "Oct 12" in the client's time zone (falls back to UTC on a bad zone). */
export function formatTrialDate(date: Date, timeZone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timeZone || 'UTC' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(date);
  }
}

export interface TrialEndingCopyInput {
  trialEndsAt: Date;
  amountCents: number;
  currency: string;
  timeZone?: string | null;
  /** The client already cancelled: the plan ends with the trial, no charge. */
  cancelAtPeriodEnd: boolean;
  /**
   * B-TRIALS-3 (B-656-5) — false when no card is saved any more (removed
   * during the trial): Stripe cancels at the trial end and charges nothing.
   * Omitted / true = a card will be charged.
   */
  cardOnFile?: boolean;
}

/** Why a trial end charges nothing (null = a card will be charged). */
export type TrialNoChargeReason = 'cancelled' | 'no_card' | null;

export function trialNoChargeReason(input: {
  cancelAtPeriodEnd: boolean;
  cardOnFile?: boolean;
}): TrialNoChargeReason {
  if (input.cancelAtPeriodEnd) return 'cancelled';
  if (input.cardOnFile === false) return 'no_card';
  return null;
}

export interface TrialEndingCopy {
  title: string;
  body: string;
  dateLabel: string;
  amountLabel: string;
}

/**
 * The trial-ending notice (push + in-app + email lead line).
 *
 *   "Your free trial ends on Oct 12. Your card will be charged $49 then.
 *    Cancel anytime before."
 *
 * When the client already cancelled during the trial, or removed the card
 * (B-TRIALS-3), the notice says truthfully that nothing will be charged.
 */
export function trialEndingCopy(input: TrialEndingCopyInput): TrialEndingCopy {
  const dateLabel = formatTrialDate(input.trialEndsAt, input.timeZone);
  const amountLabel = formatTrialAmount(input.amountCents, input.currency);
  const reason = trialNoChargeReason(input);
  if (reason === 'no_card') {
    return {
      title: 'Your free trial',
      body: `Your free trial ends on ${dateLabel}. No card is saved, so nothing will be charged and your plan ends then.`,
      dateLabel,
      amountLabel,
    };
  }
  if (reason === 'cancelled') {
    return {
      title: 'Your free trial',
      body: `Your free trial ends on ${dateLabel}. Your card will not be charged, and your plan ends then.`,
      dateLabel,
      amountLabel,
    };
  }
  return {
    title: 'Your free trial',
    body: `Your free trial ends on ${dateLabel}. Your card will be charged ${amountLabel} then. Cancel anytime before.`,
    dateLabel,
    amountLabel,
  };
}

/**
 * B-TRIALS-3 (B-656-5) — will the trial end really charge a card? The
 * subscription's own payment method (as last observed) or the customer's
 * invoice default. Unknown (never observed, no customer default) counts as a
 * card: the app never says "nothing will be charged" without evidence.
 */
export function willChargeCard(
  subscriptionCard: boolean | null | undefined,
  customerDefault: boolean,
): boolean {
  if (subscriptionCard === true || customerDefault) return true;
  return subscriptionCard !== false;
}
