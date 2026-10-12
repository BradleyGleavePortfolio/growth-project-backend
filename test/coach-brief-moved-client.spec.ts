// test/coach-brief-moved-client.spec.ts
//
// F-DP4-3 (agent 138): owner decision 4 — when a client moves, the old coach
// loses everything at once. A move does not close the SubCoachAssignment row,
// so the coach brief must apply the current-coach rule itself: the old team's
// sub-coach and head coach get no item, snippet or count for a moved client.
// B-939-1: that includes a brief stored before the move, today and in history.

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
  // Kai's unread note to a previous coach Y: that history stays with Kai, not with H's team.
  { client_id: 'kept', coach_id: 'Y', sender_id: 'kept', body: 'Note for my previous coach', created_at: new Date() },
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

  it("an unread message on another coach's thread never reaches the brief, even for a current client", async () => {
    const { svc } = wire();
    const agg = await svc['aggregateSoloContext']('H', ['kept'], 'America/Los_Angeles', '2026-10-11', 'solo_coach');
    expect(agg.unreadThreads).toEqual([
      { client_id: 'kept', client_name: 'Kai Kept', message_preview: 'Can we move my session' },
    ]);
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

// B-939-1: a brief stored before the move named the moved client. Today's brief is written again
// without them; history keeps that day's date and status, not its content.
describe('B-939-1 stored briefs after a client moves (owner decision 4)', () => {
  const item = (client_id: string, client_name: string, detail: string) => ({
    type: 'message_unread', client_id, client_name, detail, priority: 1, deep_link: `tgp://coach/clients/${client_id}`,
  });
  const STORED = {
    id: 'b-moved', coach_id: 'S', brief_date: '2026-10-11', status: 'generated', brief_mode: 'sub_coach',
    generated_by: 'fallback', narrative: 'Two clients wrote to you.', brief_context: { roster_size: 2 },
    action_items: [
      item('moved', 'Mia Moved', 'Private note for my new coach about my dose'),
      item('kept', 'Kai Kept', 'Can we move my session'),
    ],
    generated_at: new Date('2026-10-11T15:00:00Z'), created_at: new Date('2026-10-11T15:00:00Z'),
  };
  const KEPT_ONLY = {
    ...STORED, id: 'b-kept', brief_date: '2026-10-10', narrative: 'One client wrote to you.',
    action_items: [item('kept', 'Kai Kept', 'Can we move my session')],
  };

  function stored(row: typeof STORED) {
    const ctx = wire();
    ctx.prisma.teamSubCoachAssignment.findFirst.mockResolvedValue({ id: 'team-S' });
    ctx.prisma.coachBrief.findUnique.mockResolvedValue(row);
    ctx.prisma.coachBrief.updateMany.mockResolvedValue({ count: 1 });
    ctx.prisma.coachBrief.update.mockImplementation(async ({ data }: { data: object }) => ({ ...row, ...data }));
    return ctx;
  }

  it("today: a sub-coach brief stored before the move is written again without the moved client", async () => {
    const { prisma, svc } = stored(STORED);
    const out = await svc.generateBrief('S', 'America/Los_Angeles', '2026-10-11');
    expect(prisma.coachBrief.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'generating' }) }),
    );
    const items = (out.summary?.action_items ?? []) as Array<{ client_id?: string }>;
    expect(items.map((i) => i.client_id)).toEqual(['kept']);
    expect(JSON.stringify(out)).not.toContain('Mia');
    expect(JSON.stringify(out)).not.toContain('Private note');
  });

  it("today: a stored brief whose clients are all still the coach's is served as stored", async () => {
    const { prisma, svc } = stored(KEPT_ONLY);
    const out = await svc.generateBrief('S', 'America/Los_Angeles', '2026-10-10');
    expect(prisma.coachBrief.updateMany).not.toHaveBeenCalled();
    expect(out.summary?.narrative).toBe(KEPT_ONLY.narrative);
  });

  it('history: a brief naming the moved client keeps its day and status, not its content', async () => {
    const { prisma, svc } = stored(STORED);
    prisma.coachBrief.count.mockResolvedValue(2);
    prisma.coachBrief.findMany.mockResolvedValue([STORED, KEPT_ONLY]);
    const { items } = await svc.getBriefHistory('S', 1, 20);
    expect(items.map((i) => [i.id, i.status, i.summary?.narrative ?? null])).toEqual([
      ['b-moved', 'generated', null],
      ['b-kept', 'generated', 'One client wrote to you.'],
    ]);
    expect(JSON.stringify(items)).not.toContain('Mia');
    expect(JSON.stringify(items)).not.toContain('Private note');
  });

  it("history: a solo coach's brief naming a client who has since moved to another coach shows no content", async () => {
    const { prisma, svc } = stored(STORED);
    const solo = { ...KEPT_ONLY, id: 'b-solo', coach_id: 'Y', brief_mode: 'solo_coach' };
    prisma.coachBrief.count.mockResolvedValue(1);
    prisma.coachBrief.findMany.mockResolvedValue([solo]);
    const { items } = await svc.getBriefHistory('Y', 1, 20);
    expect(items.map((i) => [i.id, i.status, i.summary])).toEqual([['b-solo', 'generated', null]]);
  });
});
