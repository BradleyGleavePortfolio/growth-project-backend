import type { PrismaService } from '../prisma.service';
import type { CoachPurchaseView } from './coach-payments.select';
import { isBillingPauseReason } from './dunning-v2/dunning-v2.service';

// CONTRACT-1 Option 1 (owner): "The old coach keeps their own money records
// for that client (name, date, amount) and nothing else, for taxes, refunds
// and disputes."
//
// One rule for every coach money read: a record about a client who has moved
// away keeps the owner's list (record id, date, amount, status, currency, and
// the client's name where the route shows one) and loses the client's id (the
// link to their profile), contact details, access and renewal state, and
// payment-failure details. Money charges and the tax export drop the package
// and its cadence too; a charge keeps only whether it was one-time or
// recurring, which the app needs to read the list (an owner decision is
// waiting). Lists about the client's current state (a package's subscribers,
// Needs attention) leave them out. The seller still
// refunds (POST /v1/coach/purchases/:id/refund) and restarts a dispute pause
// (POST /v1/coach/purchases/:id/dispute-restart) by the record id alone.

type MovedPrisma = Pick<PrismaService, 'user' | 'subCoachAssignment'>;

/**
 * The given clients who have moved away from `coachId`: off the coach's
 * roster, by the roster's own rule (SubCoachScopeService): a client stays
 * while their coach is `coachId`, or while `coachId` is a sub-coach on that
 * coach's team with the client delegated to them. A coachless client has
 * moved away from everyone.
 */
export async function movedAwayClientIds(
  prisma: MovedPrisma,
  coachId: string,
  clientIds: Iterable<string | null | undefined>,
): Promise<Set<string>> {
  const ids = [...new Set(clientIds)].filter((id): id is string => !!id);
  if (ids.length === 0) return new Set();
  const away = await prisma.user.findMany({
    where: { id: { in: ids }, OR: [{ coach_id: null }, { coach_id: { not: coachId } }] },
    select: { id: true, coach_id: true },
  });
  if (away.length === 0) return new Set();
  const delegated = await prisma.subCoachAssignment.findMany({
    where: { sub_coach_id: coachId, client_id: { in: away.map((c) => c.id) }, unassigned_at: null },
    select: { client_id: true, head_coach_id: true, sub_coach: { select: { coach_id: true } } },
  });
  // A delegation counts while the client and the sub-coach both still belong to its head coach.
  const live = delegated.filter((d) => d.sub_coach.coach_id === d.head_coach_id);
  const onTeam = (c: { id: string; coach_id: string | null }) =>
    live.some((d) => d.client_id === c.id && d.head_coach_id === c.coach_id);
  return new Set(away.filter((c) => !onTeam(c)).map((c) => c.id));
}

/** What a purchase row about a moved-away client keeps (CONTRACT-1): the sale, never the client. */
const moneyRecord = (r: CoachPurchaseView) => ({
  id: r.id,
  amount_cents: r.amount_cents,
  currency: r.currency,
  status: r.status,
  created_at: r.created_at,
});

export type MoneyRecord = ReturnType<typeof moneyRecord>;

/** The coach's purchase rows, each row about a moved-away client cut to its money record. */
export async function keepMoneyRecordsOnly<T extends CoachPurchaseView>(
  prisma: MovedPrisma,
  coachId: string,
  rows: T[],
): Promise<Array<T | MoneyRecord>> {
  const moved = await movedAwayClientIds(prisma, coachId, rows.map((r) => r.client_user_id));
  return rows.map((r) => (moved.has(r.client_user_id) ? moneyRecord(r) : r));
}

type DunningPause = { status: string; last_failure_reason: string | null; entered_at: Date | null };

/** A moved-away client's dunning row keeps only a refund or dispute pause (for the restart). */
export function salePause(d: DunningPause | null): DunningPause | null {
  if (!d || d.status !== 'active' || !isBillingPauseReason(d.last_failure_reason)) return null;
  return { status: d.status, last_failure_reason: d.last_failure_reason, entered_at: d.entered_at };
}
