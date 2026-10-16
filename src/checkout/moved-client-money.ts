import type { PrismaService } from '../prisma.service';
import type { CoachPurchaseView } from './coach-payments.select';
import { isBillingPauseReason } from './dunning-v2/dunning-v2.service';

// CONTRACT-1 Option 1 (owner): "The old coach keeps their own money records
// for that client (name, date, amount) and nothing else, for taxes, refunds
// and disputes." Every coach money read keeps that, plus the record's id,
// status and currency, for a client who moved away, and leaves out rows that
// are only their current state. The seller still refunds and restarts by id.

/**
 * The given clients who are off `coachId`'s roster, by the roster's own rule
 * (SubCoachScopeService; keep the two in step): a client stays while their
 * coach is `coachId`, or while `coachId` is a sub-coach on that coach's team
 * with the client delegated to them. An archived seat (the head coach removed
 * the sub-coach) ends that even while the delegation is open; a delegation
 * alone counts for a pair never seated. A coachless client has moved away.
 */
export async function movedAwayClientIds(
  prisma: PrismaService,
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
    select: {
      client_id: true,
      head_coach_id: true,
      sub_coach: {
        select: {
          coach_id: true,
          sub_coach_assignments_as_sub: {
            where: { archived_at: { not: null } },
            select: { head_coach_id: true },
          },
        },
      },
    },
  });
  const live = delegated.filter(({ head_coach_id: head, sub_coach: sub }) => {
    const removed = sub.sub_coach_assignments_as_sub.some((seat) => seat.head_coach_id === head);
    return sub.coach_id === head && !removed;
  });
  const onTeam = (c: { id: string; coach_id: string | null }) =>
    live.some((d) => d.client_id === c.id && d.head_coach_id === c.coach_id);
  return new Set(away.filter((c) => !onTeam(c)).map((c) => c.id));
}

/** What a purchase row about a moved-away client keeps: the sale, never the client. */
const moneyRecord = (r: CoachPurchaseView) => {
  const { id, amount_cents, currency, status, created_at } = r;
  return { id, amount_cents, currency, status, created_at };
};

export type MoneyRecord = ReturnType<typeof moneyRecord>;

/** The coach's purchase rows, each row about a moved-away client cut to its money record. */
export async function keepMoneyRecordsOnly<T extends CoachPurchaseView>(
  prisma: PrismaService,
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
