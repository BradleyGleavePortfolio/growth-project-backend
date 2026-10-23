import type { ClientPurchase, PlanRenewal, Prisma, PrismaClient } from '@prisma/client';
import { firstNameOf } from '../../engagement/welcome-template';
import { resolveRecipientTimeZone } from '../../notifications/recipient-timezone';
import {
  houseCoachUserId,
  isPlanRenewalEnabled,
  PLAN_RENEWAL_BANNER_DAYS,
  PLAN_RENEWAL_STEP_DAYS,
  planRenewalDay,
} from './plan-renewal.cadence';

type Db = PrismaClient | Prisma.TransactionClient;

export interface PlanRenewalPerson {
  id: string;
  first_name: string | null;
}

/** TGP's house coach also carries the full name (owner W-168-HC: "Bradley Gleave" on the house pages). */
export interface PlanRenewalHouseCoach extends PlanRenewalPerson {
  full_name: string | null;
}

/** The `renewal` block of GET /v1/checkout/entitlement (CONTRACT comment on b#1127). */
export interface PlanRenewalView {
  state: 'none' | 'ended' | 'revoked';
  ended_at: string | null;
  popup_due: boolean;
  popup_step: number | null;
  /** Home's "Renew now" banner (local days 0 to 29 while the state is ended). */
  banner_due: boolean;
  coach: PlanRenewalPerson | null;
  house_coach: PlanRenewalHouseCoach | null;
}

export const NO_RENEWAL: PlanRenewalView = {
  state: 'none',
  ended_at: null,
  popup_due: false,
  popup_step: null,
  banner_due: false,
  coach: null,
  house_coach: null,
};

/** Checkout attempts that never became a plan (plus a one-off card declined at checkout, below). */
const NEVER_A_PLAN = ['pending', 'expired', 'incomplete_expired'];
const FAILED_PAYMENT = ['payment_failed', 'past_due', 'unpaid'];
const declinedAtCheckout = (p: { status: string; billing_type: string }) =>
  p.status === 'payment_failed' && p.billing_type !== 'recurring';
const MONEY_REVERSED = ['refunded', 'disputed', 'chargeback_lost'];
/** invite-grant.service GRANT_REVOKED_STATUS (not imported: the push worker loads this file). */
const REVOKED = 'revoked';

export type PlanEndFields = Pick<
  ClientPurchase,
  'billing_type' | 'access_expires_at' | 'canceled_at' | 'current_period_end' | 'cancel_at_period_end'
>;
const PLAN_END_SELECT = {
  status: true,
  billing_type: true,
  entitlement_active: true,
  access_expires_at: true,
  canceled_at: true,
  current_period_end: true,
  cancel_at_period_end: true,
} as const;

/**
 * The plan-end rule (one rule for the sweep, the entitlement answer and
 * CHURN-BE). A package ends on its last day. A subscription cancelled at
 * period end ends at that period end; one cancelled at once ends when it was
 * cancelled, before and after its old period end passes (never read off the
 * clock). Null for a subscription still running.
 */
export function planEndedAt(p: PlanEndFields): Date | null {
  if (p.billing_type !== 'recurring') return p.access_expires_at;
  return p.cancel_at_period_end && p.current_period_end ? p.current_period_end : p.canceled_at;
}

/**
 * The purchases whose plan may have ended normally in (since, now]: the
 * sweep's and CHURN-BE's one candidate rule (planEndedAt says when it ended;
 * planRenewalBlock says whether it still counts).
 */
export const endedPlanWhere = (since: Date, now: Date): Prisma.ClientPurchaseWhereInput => ({
  OR: [
    { billing_type: 'one_time', status: { in: ['paid', 'active'] }, entitlement_active: true, access_expires_at: { gt: since, lte: now } },
    {
      billing_type: 'recurring',
      status: 'canceled',
      OR: [{ cancel_at_period_end: true, current_period_end: { gt: since, lte: now } }, { canceled_at: { gt: since } }],
    },
  ],
});

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
 * at once), or null when it may. One rule for opening, each step's push, the
 * push worker's send-time check and the entitlement answer.
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
    pairPlans(db, clientUserId, coachUserId),
    db.clientPurchase.count({
      where: { ...pair, OR: [{ status: { in: MONEY_REVERSED } }, { refunds: { some: {} } }, { disputes: { some: {} } }] },
    }),
    // A cycle that was never recovered (LO B1): a recovered one keeps resolved_at when a later normal
    // end relabels it abandoned, and every reopen clears resolved_at.
    db.dunningState.count({ where: { purchase: pair, resolved_at: null } }),
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

/** Every plan between the client and the coach, newest first. */
async function pairPlans(db: Db, clientUserId: string, coachUserId: string) {
  const rows = await db.clientPurchase.findMany({
    where: { client_user_id: clientUserId, coach_user_id: coachUserId, status: { notIn: NEVER_A_PLAN } },
    orderBy: { created_at: 'desc' },
    select: PLAN_END_SELECT,
  });
  return rows.filter((p) => !declinedAtCheckout(p));
}

/**
 * The latest end over every plan between the client and the coach (LS B1: only that one opens a sequence).
 * A revoked grant's unused expiry is not an end (round 2 B1); a client whose latest grant was revoked is
 * stopped by planRenewalBlock ('revoked').
 */
export async function latestPlanEnd(db: Db, clientUserId: string, coachUserId: string): Promise<Date | null> {
  let latest: Date | null = null;
  for (const p of await pairPlans(db, clientUserId, coachUserId)) {
    const end = p.status === REVOKED ? null : planEndedAt(p);
    if (end && (!latest || end > latest)) latest = end;
  }
  return latest;
}

/**
 * TGP's house coach (HOUSE_COACH_USER_ID), never offered to that coach's own client or when unset or not a coach.
 * Only this coach gets full_name (his name is on the house pages); the client's own coach stays first-name only.
 */
export async function planRenewalHouseCoach(db: Db, coachUserId: string): Promise<PlanRenewalHouseCoach | null> {
  const id = houseCoachUserId();
  if (!id || id === coachUserId) return null;
  const house = await db.user.findFirst({
    where: { id, role: { in: ['coach', 'owner'] }, deleted_at: null },
    select: { name: true },
  });
  if (!house) return null;
  const full = house.name.trim().replace(/\s+/g, ' ').slice(0, 120);
  return { id, first_name: firstNameOf(house.name), full_name: full || null };
}

/** The renewal block for the signed-in user and their CURRENT coach, the row behind "ended" and its local day. */
export async function loadPlanRenewal(
  db: Db,
  userId: string,
  coachUserId?: string,
  now = new Date(),
): Promise<{ view: PlanRenewalView; row: PlanRenewal | null; day: number }> {
  const none = { view: NO_RENEWAL, row: null, day: -1 };
  const me = await db.user.findUnique({ where: { id: userId }, select: { role: true, coach_id: true } });
  const coachId = me?.role === 'student' ? me.coach_id : null;
  if (!coachId || (coachUserId && coachUserId !== coachId)) return none;
  const block = await planRenewalBlock(db, userId, coachId, now);
  if (block && block !== 'revoked') return none;
  const coachRow = await db.user.findUnique({ where: { id: coachId }, select: { name: true } });
  const coach = { id: coachId, first_name: firstNameOf(coachRow?.name) };
  if (block === 'revoked') return { ...none, view: { ...NO_RENEWAL, state: 'revoked', coach } };
  const row = await db.planRenewal.findFirst({
    where: { client_user_id: userId, coach_user_id: coachId, status: { in: ['active', 'done'] } },
    orderBy: { ended_at: 'desc' },
  });
  if (!row) return none;
  const day = planRenewalDay(row.ended_at, now, await resolveRecipientTimeZone(db, userId));
  const popup = PLAN_RENEWAL_STEP_DAYS.includes(day) && row.popup_acked_step < day ? day : null;
  const view: PlanRenewalView = {
    state: 'ended',
    ended_at: row.ended_at.toISOString(),
    popup_due: popup !== null,
    popup_step: popup,
    banner_due: day >= 0 && day < PLAN_RENEWAL_BANNER_DAYS,
    coach,
    house_coach: await planRenewalHouseCoach(db, coachId),
  };
  return { view, row, day };
}

export const readPlanRenewal = async (db: Db, userId: string, coachUserId?: string, now?: Date): Promise<PlanRenewalView> =>
  (await loadPlanRenewal(db, userId, coachUserId, now)).view;

/** Push worker send-time check: a renewal push goes out only while the sequence still runs. */
export async function planRenewalPushStillDue(db: Db, userId: string): Promise<boolean> {
  return isPlanRenewalEnabled() && (await readPlanRenewal(db, userId)).state === 'ended';
}
