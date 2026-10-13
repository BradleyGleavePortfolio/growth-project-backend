import type { PrismaService } from '../prisma.service';
import type { CoachPurchaseView } from './coach-payments.select';

// CONTRACT-1 Option 1 (owner): "The old coach keeps their own money records
// for that client (name, date, amount) and nothing else, for taxes, refunds
// and disputes."
//
// One rule for every coach money read: a row about a client who has moved
// away keeps the sale record (record id, the client's name, date, amount,
// status, currency and the coach's own package) and loses the client's id
// (the link to their profile), contact details, access dates and
// payment-failure details. Refund and dispute actions still work: they check
// the seller, not the roster.

type MovedPrisma = Pick<PrismaService, 'user' | 'teamSubCoachAssignment' | 'subCoachAssignment'>;

/**
 * The given clients who have moved away from `coachId`: no longer on the
 * coach's chain (owner: "head coach, then the sub-coach who coaches them").
 * A client stays when their coach is `coachId`, or one of `coachId`'s active
 * sub-coaches, or `coachId`'s head coach with the client delegated to
 * `coachId`. A coachless client has moved away from everyone.
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
  const awayIds = away.map((c) => c.id);
  const [team, delegated] = await Promise.all([
    prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: coachId, archived_at: null },
      select: { sub_coach_id: true },
    }),
    prisma.subCoachAssignment.findMany({
      where: { sub_coach_id: coachId, client_id: { in: awayIds }, unassigned_at: null },
      select: { client_id: true, head_coach_id: true },
    }),
  ]);
  const subCoaches = new Set(team.map((t) => t.sub_coach_id));
  const onChain = (c: { id: string; coach_id: string | null }) =>
    c.coach_id !== null &&
    (subCoaches.has(c.coach_id) ||
      delegated.some((d) => d.client_id === c.id && d.head_coach_id === c.coach_id));
  return new Set(away.filter((c) => !onChain(c)).map((c) => c.id));
}

/** What a purchase row about a moved-away client keeps (CONTRACT-1). */
export const MONEY_RECORD_FIELDS = [
  'id',
  'package_id',
  'billing_type',
  'amount_cents',
  'currency',
  'status',
  'entitlement_active',
  'cancel_at_period_end',
  'created_at',
] as const;

export type MoneyRecord = Pick<CoachPurchaseView, (typeof MONEY_RECORD_FIELDS)[number]> & {
  client?: { name: string };
};

/** The coach's purchase rows, each row about a moved-away client cut to its money record. */
export async function keepMoneyRecordsOnly<
  T extends CoachPurchaseView & { client?: { name: string } | null },
>(prisma: MovedPrisma, coachId: string, rows: T[]): Promise<Array<T | MoneyRecord>> {
  const moved = await movedAwayClientIds(prisma, coachId, rows.map((r) => r.client_user_id));
  return rows.map((r) => {
    if (!moved.has(r.client_user_id)) return r;
    const record = Object.fromEntries(MONEY_RECORD_FIELDS.map((k) => [k, r[k]])) as MoneyRecord;
    return r.client ? { ...record, client: { name: r.client.name } } : record;
  });
}
