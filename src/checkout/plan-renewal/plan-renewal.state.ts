import type { PlanRenewal, Prisma, PrismaClient } from '@prisma/client';
import { firstNameOf } from '../../engagement/welcome-template';
import { isPlanRenewalEnabled, PLAN_RENEWAL_STEPS } from './plan-renewal.cadence';

type Db = PrismaClient | Prisma.TransactionClient;

/** The `renewal` block of GET /v1/checkout/entitlement (contract: ops164/work/RENEWAL-CONTRACT.md). */
export interface PlanRenewalView {
  state: 'none' | 'ended' | 'revoked';
  ended_at: string | null;
  step: number | null;
  popup_due: boolean;
  popup_step: number | null;
  coach: { id: string; first_name: string | null } | null;
}

export const NO_RENEWAL: PlanRenewalView = {
  state: 'none',
  ended_at: null,
  step: null,
  popup_due: false,
  popup_step: null,
  coach: null,
};

/** Checkout attempts that never became a plan. */
const NEVER_A_PLAN = ['pending', 'expired', 'incomplete_expired'];
const FAILED_PAYMENT = ['payment_failed', 'past_due', 'unpaid'];
const MONEY_REVERSED = ['refunded', 'disputed', 'chargeback_lost'];
/** invite-grant.service GRANT_REVOKED_STATUS (not imported: the push worker loads this file). */
const REVOKED = 'revoked';

export type PlanRenewalBlock =
  | 'account'
  | 'moved'
  | 'archived'
  | 'active_plan'
  | 'revoked'
  | 'refund_or_dispute'
  | 'failed_payment';

/**
 * Why a renewal sequence for this client and coach must not run (or must stop
 * at once), or null when it may. One rule for opening, every step, every coach
 * message, the push worker's send-time check and the entitlement answer.
 */
export async function planRenewalBlock(
  db: Db,
  clientUserId: string,
  coachUserId: string,
  now: Date,
): Promise<PlanRenewalBlock | null> {
  const pair = { client_user_id: clientUserId, coach_user_id: coachUserId };
  const [client, plans, reversed, dunning] = await Promise.all([
    db.user.findUnique({
      where: { id: clientUserId },
      select: { role: true, coach_id: true, archived_at: true, deleted_at: true, deletion_scheduled_at: true },
    }),
    db.clientPurchase.findMany({
      where: { ...pair, status: { notIn: NEVER_A_PLAN } },
      orderBy: { created_at: 'desc' },
      select: { status: true, entitlement_active: true, access_expires_at: true },
    }),
    db.clientPurchase.count({
      where: { ...pair, OR: [{ status: { in: MONEY_REVERSED } }, { refunds: { some: {} } }, { disputes: { some: {} } }] },
    }),
    db.dunningState.count({
      where: { purchase: pair, OR: [{ status: { not: 'resolved' } }, { locked_out_at: { not: null } }] },
    }),
  ]);
  if (!client || client.role !== 'student' || client.deleted_at || client.deletion_scheduled_at) return 'account';
  if (client.coach_id !== coachUserId) return 'moved';
  if (client.archived_at) return 'archived';
  if (plans.some((p) => p.entitlement_active && (!p.access_expires_at || p.access_expires_at > now))) {
    return 'active_plan';
  }
  if (plans[0]?.status === REVOKED) return 'revoked';
  if (reversed > 0) return 'refund_or_dispute';
  if (dunning > 0 || plans.some((p) => FAILED_PAYMENT.includes(p.status))) return 'failed_payment';
  return null;
}

/** The renewal block for the signed-in user and their CURRENT coach, plus the running row behind "ended". */
export async function loadPlanRenewal(
  db: Db,
  userId: string,
  coachUserId?: string,
  now = new Date(),
): Promise<{ view: PlanRenewalView; row: PlanRenewal | null }> {
  const none = { view: NO_RENEWAL, row: null };
  const me = await db.user.findUnique({ where: { id: userId }, select: { role: true, coach_id: true } });
  const coachId = me?.role === 'student' ? me.coach_id : null;
  if (!coachId || (coachUserId && coachUserId !== coachId)) return none;
  const block = await planRenewalBlock(db, userId, coachId, now);
  if (block && block !== 'revoked') return none;
  const coachRow = await db.user.findUnique({ where: { id: coachId }, select: { name: true } });
  const coach = { id: coachId, first_name: firstNameOf(coachRow?.name) };
  if (block === 'revoked') return { view: { ...NO_RENEWAL, state: 'revoked', coach }, row: null };
  const row = await db.planRenewal.findFirst({
    where: { client_user_id: userId, coach_user_id: coachId, status: { in: ['active', 'done'] }, step_index: { gte: 0 } },
    orderBy: { ended_at: 'desc' },
  });
  if (!row) return none;
  const due = row.popup_step > row.popup_acked_step;
  const view: PlanRenewalView = {
    state: 'ended',
    ended_at: row.ended_at.toISOString(),
    step: PLAN_RENEWAL_STEPS[row.step_index].day,
    popup_due: due,
    popup_step: due ? PLAN_RENEWAL_STEPS[row.popup_step].day : null,
    coach,
  };
  return { view, row };
}

export const readPlanRenewal = async (db: Db, userId: string, coachUserId?: string): Promise<PlanRenewalView> =>
  (await loadPlanRenewal(db, userId, coachUserId)).view;

/** Push worker send-time check: a renewal push goes out only while the sequence still runs. */
export async function planRenewalPushStillDue(db: Db, userId: string): Promise<boolean> {
  return isPlanRenewalEnabled() && (await readPlanRenewal(db, userId)).state === 'ended';
}
