import type { PrismaService } from '../../prisma.service';

/**
 * The trial notice's own truth check, on its own (no service imports), so the
 * one push worker can ask it again when a held trial-ending push goes
 * (FR-1192R2).
 */

/** B-672-3 — why a notice is retired instead of sent. */
export type TrialNoticeSkipCode =
  | 'purchase_canceled'
  | 'purchase_missing'
  | 'trial_ended'
  | 'trial_not_started'
  | 'trial_superseded';

/**
 * B-672-3 — does the notice still describe the purchase's current trial at
 * `at`? null when it does, else the code the notice is retired with.
 */
export function trialNoticeSkipCode(
  notice: { trial_ends_at: Date },
  purchase: { status: string; entitlement_active: boolean; trial_ends_at: Date | null } | null,
  at: Date,
): TrialNoticeSkipCode | null {
  if (!purchase) return 'purchase_missing';
  if (purchase.status === 'canceled') return 'purchase_canceled';
  const end = notice.trial_ends_at.getTime();
  if (end <= at.getTime() || purchase.status !== 'trialing') return 'trial_ended';
  if (!purchase.entitlement_active) return 'trial_not_started';
  if (purchase.trial_ends_at?.getTime() !== end) return 'trial_superseded';
  return null;
}

/**
 * FR-1192R2: a trial-ending push held for 08:00 (or the cap, or a retry)
 * still goes only while its notice describes the current trial
 * (trialNoticeSkipCode, as admit() asks before it queues) and the client has
 * not canceled it since: a push queued to say a charge is coming is not owed
 * once the trial ends with no charge (operator ruling R3).
 */
export async function trialPushStillDue(
  prisma: Pick<PrismaService, 'packageTrialNotice' | 'clientPurchase'>,
  held: { noticeId: string; cancelAtPeriodEnd: boolean },
  now: Date,
): Promise<boolean> {
  const notice = await prisma.packageTrialNotice.findUnique({
    where: { id: held.noticeId },
    select: { trial_ends_at: true, purchase_id: true },
  });
  if (!notice) return false;
  const purchase = await prisma.clientPurchase.findUnique({
    where: { id: notice.purchase_id },
    select: { status: true, entitlement_active: true, trial_ends_at: true, cancel_at_period_end: true },
  });
  if (!purchase || trialNoticeSkipCode(notice, purchase, now) !== null) return false;
  return !(purchase.cancel_at_period_end && !held.cancelAtPeriodEnd);
}
