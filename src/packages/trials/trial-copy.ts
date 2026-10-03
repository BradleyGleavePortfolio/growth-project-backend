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
 * When the client already cancelled during the trial the notice confirms
 * nothing will be charged instead.
 */
export function trialEndingCopy(input: TrialEndingCopyInput): TrialEndingCopy {
  const dateLabel = formatTrialDate(input.trialEndsAt, input.timeZone);
  const amountLabel = formatTrialAmount(input.amountCents, input.currency);
  if (input.cancelAtPeriodEnd) {
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
