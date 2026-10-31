import { isDunningV2Enabled } from './dunning-v2.feature';

/**
 * PF-7-BE (owner #PF-STRIPE option 1, LO-PAYFAIL P-2): a renewal that fails
 * while the coach's own Stripe account can't take payments is not the
 * client's fault. It waits instead of starting the ten failed-payment days:
 * the client keeps access and is told nothing, the coach is told (PF-W8 at
 * once, PF-W9 in every brief), and TGP pays it once the account is fixed.
 *
 * A waiting renewal is the purchase's DunningState row kept `active`, never
 * claimed (`step_index` -1, so the v2 sweep, the phone status and the lock
 * never see a cycle) and marked by this reason. No new column (R9).
 */
export const COACH_ACCOUNT_HOLD_REASON = 'coach_account_not_ready';

/** At most one retry per waiting renewal per hour (R5). */
export const COACH_ACCOUNT_HOLD_RETRY_MS = 60 * 60 * 1000;

/**
 * The switch (R6): ON unless FEATURE_COACH_ACCOUNT_HOLD is exactly "false".
 * It rides on Smart Dunning v2: with v2 off there is no ten-day cycle to hold.
 */
export function isCoachAccountHoldEnabled(): boolean {
  return process.env['FEATURE_COACH_ACCOUNT_HOLD'] !== 'false' && isDunningV2Enabled();
}

export function isCoachAccountHoldReason(reason: string | null | undefined): boolean {
  return reason === COACH_ACCOUNT_HOLD_REASON;
}

/** PF-W8, owner-approved; only the count changes. */
export function coachAccountHoldNotice(count: number): string {
  const n = Math.max(1, Math.floor(count));
  const who = n === 1 ? "1 client's renewal" : `${n} clients' renewals`;
  return (
    `Your Stripe account can't take payments right now, so ${who} did not go through. ` +
    'Their access continues. Fix it in Stripe, and TGP tries again.'
  );
}

/** PF-W9, owner-approved; only the count changes. */
export function coachAccountWaitingLine(count: number): string {
  const n = Math.max(1, Math.floor(count));
  const what = n === 1 ? '1 renewal is' : `${n} renewals are`;
  return `${what} waiting on your Stripe account. Fix it in Stripe, and TGP tries again.`;
}

/** The coach's calendar day (YYYY-MM-DD) in their zone; LA when unknown or invalid. */
export function coachLocalDay(at: Date, timeZone: string | null | undefined): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  try {
    return fmt(timeZone || 'America/Los_Angeles');
  } catch {
    return fmt('America/Los_Angeles');
  }
}

/** One Stripe idempotency key per invoice and hold (R5). */
export function coachAccountHoldRetryKey(
  invoiceId: string,
  dunningStateId: string,
  heldAt: Date | null,
): string {
  return `pf7-hold-pay:${invoiceId}:${dunningStateId}:${heldAt ? heldAt.getTime() : 0}`;
}
