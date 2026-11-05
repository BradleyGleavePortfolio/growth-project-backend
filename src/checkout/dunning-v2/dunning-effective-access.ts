import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma.service';
import { dunningGraceWhere, NOT_DUNNING_LOCKED } from './dunning-grace';

/**
 * S-DUNNING-R3 (B-628-7): the ONE rule for "does a Day-10 lock actually stop
 * this client", shared by the request guard (DunningLockoutGuard) and the
 * client read model (GET /v1/me/dunning-status). Before this the guard waived
 * the lock for a client holding another live entitlement (comp / invite-code
 * grant, another paid package, access the coach kept on) while the status
 * endpoint still answered `locked`, so the app showed a lockout screen to a
 * client whose requests all went through.
 */
type Db = Prisma.TransactionClient | PrismaService;

export interface EffectiveLock {
  /** The locked cycle's purchase, or null when no cycle is locked. */
  lockedPurchaseId: string | null;
  /** True when a locked cycle exists but other live access waives it. */
  waived: boolean;
  /** True when the client is actually locked out (locked and not waived). */
  locked: boolean;
}

/**
 * Live access other than `excludePurchaseId`: an entitled purchase whose own
 * cycle (if any) is not locked, unexpired in a paid status or in live grace.
 */
export async function hasOtherLiveAccess(
  db: Db,
  clientUserId: string,
  excludePurchaseId: string,
  now: Date = new Date(),
): Promise<boolean> {
  // B-687-1 (Sol): "not itself locked" is part of the query, so the one row
  // fetched is a live grant however many locked alternatives the client
  // holds (a page of the first N rows could be all locked and hide it). The
  // same test on the row keeps the answer right for any caller-supplied db.
  const grace = dunningGraceWhere();
  const others = await db.clientPurchase.findMany({
    where: {
      client_user_id: clientUserId,
      id: { not: excludePurchaseId },
      entitlement_active: true,
      AND: [
        // FR-1190 (LS-1190 B3): a paid plan inside its window, or (v2 on) another failed renewal in
        // its live grace, the rule the guard and the shared reads give that plan's own access.
        {
          OR: [
            {
              status: { in: ['paid', 'active', 'trialing'] },
              OR: [{ access_expires_at: null }, { access_expires_at: { gt: now } }],
            },
            ...(grace ? [grace] : []),
          ],
        },
        NOT_DUNNING_LOCKED,
      ],
    },
    select: {
      id: true,
      dunning: { select: { status: true, locked_out_at: true } },
    },
    take: 1,
  });
  return others.some((p) => !(p.dunning?.status === 'active' && p.dunning.locked_out_at != null));
}

export async function effectiveLock(
  db: Db,
  clientUserId: string,
  now: Date = new Date(),
): Promise<EffectiveLock> {
  const lockedRow = await db.dunningState.findFirst({
    where: {
      locked_out_at: { not: null },
      status: 'active',
      purchase: { client_user_id: clientUserId },
    },
    select: { id: true, purchase_id: true },
  });
  if (lockedRow == null) return { lockedPurchaseId: null, waived: false, locked: false };
  const waived = await hasOtherLiveAccess(db, clientUserId, lockedRow.purchase_id, now);
  return { lockedPurchaseId: lockedRow.purchase_id, waived, locked: !waived };
}
