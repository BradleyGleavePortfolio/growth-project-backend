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
 * PF-2-BE (LS-PAYFAIL B2, B3): the purchase's own Day-10 lock is not in force. A Stripe resync can
 * set entitlement_active back to true on a locked plan (F6), so a reader of the purchase's own
 * entitlement adds this. Same rule as hasOtherLiveAccess (dunning-effective-access.ts).
 */
export const NOT_DUNNING_LOCKED: Prisma.ClientPurchaseWhereInput = {
  OR: [{ dunning: { is: null } }, { dunning: { isNot: { status: 'active', locked_out_at: { not: null } } } }],
};
export const dunningLockInForce = (d?: { status: string; locked_out_at: Date | null } | null): boolean =>
  d?.status === 'active' && d.locked_out_at != null;

/**
 * PF-2-BE (LS-PAYFAIL B2): the ONE live-grace rule every paid-access read ORs with its own paid
 * window. With v2 on, a failed renewal entitles while its cycle is active and unlocked, even after
 * access_expires_at (a weekly plan's period end + 1 day is Day 8, the lock is Day 10). Null when off.
 */
export function dunningGraceWhere(): Prisma.ClientPurchaseWhereInput | null {
  return isDunningV2Enabled()
    ? {
        status: { in: [...DUNNING_V2_GRACE_STATUSES] },
        dunning: { is: { status: 'active', locked_out_at: null } },
      }
    : null;
}

/**
 * FR-1190 (LS-1190 B1-B5): the ONE live paid-access rule for a purchase's own access, the rule the
 * app guard and the shared reads already use: entitled, not under its own Day-10 lock, and inside
 * its paid window or (v2 on) its live grace. Every paid reader and delivery path uses this pair.
 */
export function liveAccessWhere(now: Date = new Date()): Prisma.ClientPurchaseWhereInput {
  const window: Prisma.ClientPurchaseWhereInput[] = [{ access_expires_at: null }, { access_expires_at: { gt: now } }];
  const grace = dunningGraceWhere();
  return { entitlement_active: true, AND: [NOT_DUNNING_LOCKED, { OR: grace ? [...window, grace] : window }] };
}

/** The same rule on a loaded row (select status, entitlement_active, access_expires_at, dunning). */
export function isLiveAccess(
  p: {
    entitlement_active: boolean;
    status: string;
    access_expires_at?: Date | null;
    dunning?: { status: string; locked_out_at: Date | null } | null;
  },
  now: Date = new Date(),
): boolean {
  if (!p.entitlement_active || dunningLockInForce(p.dunning)) return false;
  if (p.access_expires_at == null || p.access_expires_at.getTime() > now.getTime()) return true;
  return (
    isDunningV2Enabled() &&
    DUNNING_V2_GRACE_STATUSES.includes(p.status) &&
    p.dunning?.status === 'active' &&
    p.dunning.locked_out_at == null
  );
}

/** Thrown to fail a webhook delivery so Stripe redelivers it (a closed code, never provider text). */
export class DunningWebhookRetryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DunningWebhookRetryError';
  }
}
