// B-TRIALS (OR-113-2) — client-facing trial copy. Quiet Luxury rules: plain
// warm words, no emojis, no exclamation marks, no first person. Every string
// names the date and, when a charge is coming, the exact amount.

/**
 * "$49" for whole amounts, "$49.99" otherwise; other currencies by code.
 * B-T12-116 (C-671-3) — amounts are in the currency's own minor unit
 * (Stripe convention): 4900 JPY is 4,900 yen, 4900 USD is 49 dollars.
 */
export function formatTrialAmount(amountCents: number, currency: string): string {
  const code = (currency || 'usd').toUpperCase();
  const digits = currencyMinorDigits(code);
  const scale = 10 ** digits;
  const whole = amountCents % scale === 0;
  const value = amountCents / scale;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(whole ? 0 : digits)} ${code}`;
  }
}

/** Minor-unit digits of an ISO 4217 code (2 when unknown or invalid). */
function currencyMinorDigits(code: string): number {
  try {
    const digits = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === 'number' && digits >= 0 && digits <= 3 ? digits : 2;
  } catch {
    return 2;
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
  /**
   * B-T12-116 (C-672-5) — Stripe may add tax to the trial-end invoice (the
   * subscription has automatic tax enabled): the charge line then says
   * "plus any tax" so the named amount never understates the charge.
   */
  taxMayApply?: boolean;
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
    body: `Your free trial ends on ${dateLabel}. Your card will be charged ${chargeLabel(amountLabel, input.taxMayApply)} then. Cancel anytime before.`,
    dateLabel,
    amountLabel,
  };
}

/** "$49" or, when tax may apply, "$49 plus any tax" (C-672-5). */
export function chargeLabel(amountLabel: string, taxMayApply?: boolean): string {
  return taxMayApply ? `${amountLabel} plus any tax` : amountLabel;
}

/**
 * B-TRIALS-3 (B-656-5) — will the trial end really charge a card? The
 * subscription's own payment method (as last observed) or the customer's
 * invoice default. Tri-state: true, false (confirmed: no card on the
 * subscription and no customer default), or null (unknown: the customer
 * default could not be read). Unknown is never reported as "no card". A
 * subscription card never observed counts as a card when the customer read
 * succeeded: the app never says "nothing will be charged" without evidence.
 */
export function willChargeCard(
  subscriptionCard: boolean | null | undefined,
  customerDefault: boolean | null,
): boolean | null {
  if (subscriptionCard === true || customerDefault === true) return true;
  if (customerDefault === null) return null;
  return subscriptionCard !== false;
}
