// test/coach-brief-moved-client.spec.ts
//
// F-DP4-3 (agent 138): owner decision 4 — when a client moves, the old coach
// loses everything at once. A move does not close the SubCoachAssignment row,
// so the coach brief must apply the current-coach rule itself: the old team's
// sub-coach and head coach get no item, snippet or count for a moved client.

import { CoachBriefService, buildActionItems } from '../src/coach/brief/coach-brief.service';
import { asConfig, asPrismaService, makeMockConfig, makeMockPrisma } from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

type Row = { id: string; name: string; coach_id: string; role: string; archived_at: null; created_at: Date };
type Where = Record<string, unknown>;

const users: Row[] = [
  // Moved from head H's team to coach X today; S's delegation row is still open.
  { id: 'moved', name: 'Mia Moved', coach_id: 'X', role: 'student', archived_at: null, created_at: new Date() },
  { id: 'kept', name: 'Kai Kept', coach_id: 'H', role: 'student', archived_at: null, created_at: new Date() },
];
const delegations = [
  { sub_coach_id: 'S', head_coach_id: 'H', client_id: 'moved' },
  { sub_coach_id: 'S', head_coach_id: 'H', client_id: 'kept' },
];
const messages = [
  { client_id: 'moved', coach_id: 'X', sender_id: 'moved', body: 'Private note for my new coach about my dose', created_at: new Date() },
  { client_id: 'kept', coach_id: 'H', sender_id: 'kept', body: 'Can we move my session', created_at: new Date() },
];

function matches(u: Row, w: Where): boolean {
  if (w.check_ins) return false; // missing check-in query: not under test
  if (Array.isArray(w.OR) && !(w.OR as Where[]).some((o) => matches(u, o))) return false;
  const idIn = (w.id as { in?: string[] } | string | undefined);
  if (typeof idIn === 'string' && u.id !== idIn) return false;
  if (idIn && typeof idIn === 'object' && idIn.in && !idIn.in.includes(u.id)) return false;
  if (typeof w.coach_id === 'string' && u.coach_id !== w.coach_id) return false;
  if (typeof w.role === 'string' && u.role !== w.role) return false;
  return true;
}

function wire() {
  const prisma = makeMockPrisma();
  prisma.user.findUnique.mockResolvedValue({ name: 'Sam Sub' });
  prisma.user.findMany.mockImplementation(({ where }: { where: Where }) =>
    Promise.resolve(users.filter((u) => matches(u, where))),
  );
  prisma.subCoachAssignment.findMany.mockImplementation(({ where }: { where: Where }) =>
    Promise.resolve(
      delegations.filter(
        (d) =>
          (where.sub_coach_id === undefined || d.sub_coach_id === where.sub_coach_id) &&
          (where.head_coach_id === undefined || d.head_coach_id === where.head_coach_id),
      ),
    ),
  );
  prisma.coachMessage.findMany.mockImplementation(
    ({ where, select }: { where: { client_id: { in: string[] } }; select: Record<string, any> }) =>
      Promise.resolve(
        messages
          .filter((m) => where.client_id.in.includes(m.client_id))
          .map((m) => {
            const client = users.find((u) => u.id === m.client_id)!;
            return {
              client_id: m.client_id,
              body: m.body,
              created_at: m.created_at,
              ...(select.coach_id ? { coach_id: m.coach_id } : {}),
              client: {
                name: client.name,
                ...(select.client?.select?.coach_id ? { coach_id: client.coach_id } : {}),
              },
            };
          }),
      ),
  );
  prisma.teamSubCoachAssignment.findMany.mockResolvedValue([
    { sub_coach_id: 'S', sub_coach: { id: 'S', name: 'Sam Sub' } },
  ]);
  prisma.checkIn.findMany.mockResolvedValue([]);
  prisma.clientWorkoutAssignment.count.mockResolvedValue(0);
  prisma.chargeSettlement.aggregate.mockResolvedValue({ _sum: { gross_cents: 0 }, _count: { _all: 0 } });
  prisma.clientPurchase.count.mockResolvedValue(0);
  prisma.$queryRaw.mockResolvedValue([{ count: 0n, total: 0n, mrr_cents: 0n }]);
  const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  return { prisma, svc };
}

describe('F-DP4-3 coach brief after a client moves (owner decision 4)', () => {
  it("old team's sub-coach brief has no item or snippet for the moved client; current client unchanged", async () => {
    const { svc } = wire();
    const ids = await svc.resolveClientScope('S', 'sub_coach');
    expect(ids).toEqual(['kept']);

    const agg = await svc['aggregateSoloContext']('S', ids, 'America/Los_Angeles', '2026-10-11', 'sub_coach');
    const items = buildActionItems(agg);
    expect(items.some((i) => i.client_id === 'moved')).toBe(false);
    expect(JSON.stringify(items)).not.toContain('Private note');
    expect(JSON.stringify(agg.context)).not.toContain('Mia');
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'message_unread', client_id: 'kept', detail: 'Can we move my session' }),
    );
  });

  it("an unread message on another coach's thread never reaches the brief, even for a client in scope", async () => {
    const { svc } = wire();
    const agg = await svc['aggregateSoloContext']('S', ['moved', 'kept'], 'America/Los_Angeles', '2026-10-11', 'sub_coach');
    expect(agg.unreadThreads.map((t) => t.client_id)).toEqual(['kept']);
  });

  it("old head coach's brief no longer counts the moved client or bills against them", async () => {
    const { prisma, svc } = wire();
    const { context } = await svc['aggregateHeadCoachContext']('H', 'America/Los_Angeles', '2026-10-11');
    expect(context.team_clients_total).toBe(1);
    expect(context.sub_coach_highlights).toEqual([
      expect.objectContaining({ coach_name: 'Sam Sub', active_clients: 1 }),
    ]);
    const where = (prisma.chargeSettlement.aggregate.mock.calls[0][0] as {
      where: { purchase: { client_user_id: { in: string[] } } };
    }).where;
    expect(where.purchase.client_user_id.in).toEqual(['kept']);
  });
});
