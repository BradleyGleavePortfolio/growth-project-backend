import type { Prisma } from '@prisma/client';
import { isDunningV2Enabled } from './dunning-v2.feature';

/**
 * B-690-5 (Sol): the Stripe subscription statuses of a failed renewal that
 * Smart Dunning v2 keeps entitled on Days 0-9 while the cycle is active and
 * unlocked. Stripe reports `unpaid` instead of `past_due` when the account's
 * "if all retries fail" setting marks the subscription unpaid; both are the
 * same delinquent period, and Day 10 still locks through DunningLockoutGuard.
 */
export const DUNNING_V2_GRACE_STATUSES: readonly string[] = ['past_due', 'unpaid'];

/**
 * PF-2-BE (LS-PAYFAIL B2): the ONE live-grace rule every paid-access read ORs with its own paid
 * window. With v2 on, a failed renewal entitles while its cycle is active and unlocked, even after
 * access_expires_at (a weekly plan's period end + 1 day is Day 8, the lock is Day 10). Null when off.
 */
/**
 * PF-2-BE (LS-PAYFAIL B2, B3): the purchase's own Day-10 lock is not in force. A Stripe resync can
 * set entitlement_active back to true on a locked plan (F6), so a reader of the purchase's own
 * entitlement adds this. Same rule as hasOtherLiveAccess (dunning-effective-access.ts).
 */
export const NOT_DUNNING_LOCKED: Prisma.ClientPurchaseWhereInput = {
  OR: [{ dunning: { is: null } }, { dunning: { isNot: { status: 'active', locked_out_at: { not: null } } } }],
};
export const dunningLockInForce = (d?: { status: string; locked_out_at: Date | null } | null): boolean =>
  d?.status === 'active' && d.locked_out_at != null;

export function dunningGraceWhere(): Prisma.ClientPurchaseWhereInput | null {
  return isDunningV2Enabled()
    ? {
        status: { in: [...DUNNING_V2_GRACE_STATUSES] },
        dunning: { is: { status: 'active', locked_out_at: null } },
      }
    : null;
}

/** Thrown to fail a webhook delivery so Stripe redelivers it (a closed code, never provider text). */
export class DunningWebhookRetryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DunningWebhookRetryError';
  }
}
