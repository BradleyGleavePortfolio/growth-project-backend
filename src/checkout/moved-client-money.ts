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

type MovedPrisma = Pick<PrismaService, 'user' | 'teamSubCoachAssignment'>;

/**
 * The given clients who have moved away from `coachId`: their coach is
 * neither `coachId` nor one of `coachId`'s active sub-coaches (the team
 * chain), or they have no coach.
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
  const coaches = [...new Set(away.flatMap((c) => (c.coach_id ? [c.coach_id] : [])))];
  const team =
    coaches.length === 0
      ? []
      : await prisma.teamSubCoachAssignment.findMany({
          where: { head_coach_id: coachId, sub_coach_id: { in: coaches }, archived_at: null },
          select: { sub_coach_id: true },
        });
  const subs = new Set(team.map((t) => t.sub_coach_id));
  return new Set(away.filter((c) => !c.coach_id || !subs.has(c.coach_id)).map((c) => c.id));
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
