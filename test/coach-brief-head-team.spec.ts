// BRIEFTEAM (agent 143): the head coach brief's team data (SUBM-BRIEF).
//
// Part 1 runs aggregateHeadBriefTeam against an in-memory world whose
// queries filter for real, so the tenant fence is proven on data: another
// head coach, a sub-coach's brief and a client never get this head coach's
// numbers or clients. Part 2 wires it through CoachBriefService: Team Mode
// off hides team-only items, the AI writer never sees the activity counts,
// and the message items match the phone's BRIEF-AGG contract (m#701).
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { CoachGuard } from '../src/auth/coach.guard';
import {
  BriefNotFoundError,
  CoachBriefService,
  headCoachAiContext,
  headCoachTeamView,
} from '../src/coach/brief/coach-brief.service';
import { aggregateHeadBriefTeam, previousDate } from '../src/coach/brief/head-brief-team';
import type { BriefContextHeadCoach } from '../src/coach/brief/coach-brief.types';
import type { PrismaService } from '../src/prisma.service';
import type { ConsentService } from '../src/consent/consent.service';
import {
  asConfig,
  asPrismaService,
  makeHeadCoachContext,
  makeMockConfig,
  makeMockPrisma,
  type MockPrisma,
} from './_fixtures/coach-brief-mocks';
import { fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';

type Row = Record<string, unknown>;

// Prisma-style where: equality, null, { in }, { gte, lte }.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      const c = cond as { in?: unknown[]; gte?: Date; lte?: Date };
      if (c.in) return c.in.includes(v);
      const t = (v as Date | null)?.getTime?.();
      if (t === undefined) return false;
      return (!c.gte || t >= c.gte.getTime()) && (!c.lte || t <= c.lte.getTime());
    }
    return v === cond;
  });
}

const DAY = '2026-05-24';
const IN_DAY = new Date('2026-05-24T18:00:00.000Z');
const BEFORE = new Date('2026-05-20T18:00:00.000Z');
const YESTERDAY = {
  date: DAY,
  start: new Date('2026-05-24T07:00:00.000Z'),
  end: new Date('2026-05-25T06:59:59.999Z'),
};

function student(id: string, coach: string, extra: Row = {}): Row {
  return { id, coach_id: coach, role: 'student', name: `${id} Client`, created_at: BEFORE, archived_at: null, ...extra };
}

// Head A: own a1 (joined yesterday by code), a2, delegated a3 (sub-coach S),
// a4 archived yesterday, a5 created yesterday by guest checkout, blocked a6,
// a7 since moved to coach X. Head B: b1, who wrote and checked in yesterday.
function world() {
  const users: Row[] = [
    student('a1', 'headA'),
    student('a2', 'headA'),
    student('a3', 'headA'),
    student('a4', 'headA', { archived_at: IN_DAY }),
    student('a5', 'headA', { created_at: IN_DAY }),
    student('a6', 'headA'),
    student('a7', 'headX'),
    student('b1', 'headB', { created_at: IN_DAY }),
    { id: 'subS', coach_id: 'headA', role: 'coach', name: 'Sub', created_at: IN_DAY, archived_at: null },
  ];
  const redemptions: Row[] = [
    { coach_id: 'headA', client_user_id: 'a1', redeemed_at: IN_DAY },
    { coach_id: 'headA', client_user_id: 'a5', redeemed_at: IN_DAY },
    { coach_id: 'headB', client_user_id: 'b1', redeemed_at: IN_DAY },
  ];
  const checkIns: Row[] = [
    { user_id: 'a1', date: new Date(`${DAY}T00:00:00.000Z`) },
    { user_id: 'a3', date: new Date(`${DAY}T00:00:00.000Z`) },
    { user_id: 'a2', date: new Date('2026-05-23T00:00:00.000Z') },
    { user_id: 'b1', date: new Date(`${DAY}T00:00:00.000Z`) },
  ];
  const at = (h: number) => new Date(Date.UTC(2026, 4, 25, h));
  const messages: Row[] = [
    { coach_id: 'headA', client_id: 'a1', sender_id: 'a1', read_at: null, deleted_at: null, body: 'old', created_at: at(1) },
    { coach_id: 'headA', client_id: 'a1', sender_id: 'a1', read_at: null, deleted_at: null, body: 'newest from a1', created_at: at(2) },
    // Coach-side sends never count: the head's reply and the sub-coach's.
    { coach_id: 'headA', client_id: 'a2', sender_id: 'headA', read_at: null, deleted_at: null, body: 'reply', created_at: at(3) },
    { coach_id: 'headA', client_id: 'a3', sender_id: 'subS', read_at: null, deleted_at: null, body: 'sub', created_at: at(3) },
    { coach_id: 'headA', client_id: 'a3', sender_id: 'a3', read_at: null, deleted_at: null, body: 'to my sub-coach', created_at: at(4) },
    { coach_id: 'headA', client_id: 'a2', sender_id: 'a2', read_at: at(5), deleted_at: null, body: 'read', created_at: at(4) },
    { coach_id: 'headA', client_id: 'a6', sender_id: 'a6', read_at: null, deleted_at: null, body: 'blocked', created_at: at(4) },
    { coach_id: 'headA', client_id: 'a5', sender_id: 'a5', read_at: null, deleted_at: at(6), body: 'deleted', created_at: at(4) },
    { coach_id: 'headA', client_id: 'a7', sender_id: 'a7', read_at: null, deleted_at: null, body: 'moved away', created_at: at(4) },
    { coach_id: 'headB', client_id: 'b1', sender_id: 'b1', read_at: null, deleted_at: null, body: 'from b1', created_at: at(4) },
  ];
  const blocks: Row[] = [{ blocker_id: 'headA', blocked_id: 'a6' }];
  const byId = new Map(users.map((u) => [u.id as string, u]));
  const pick = (rows: Row[], args: { where: Row }) => rows.filter((r) => matches(r, args.where));
  const prisma = {
    user: {
      findUnique: async () => ({ role: 'coach' }),
      findMany: async (a: { where: Row }) => pick(users, a).map((u) => ({ id: u.id })),
      count: async (a: { where: Row }) => pick(users, a).length,
    },
    inviteRedemption: { findMany: async (a: { where: Row }) => pick(redemptions, a) },
    checkIn: { count: async (a: { where: Row }) => pick(checkIns, a).length },
    userBlock: { findMany: async (a: { where: Row }) => pick(blocks, a) },
    coachMessage: {
      // `client` filters on the client's User row, as Prisma's relation filter does.
      findMany: async ({ where: { client, ...where }, take }: { where: Row & { client: Row }; take: number }) =>
        pick(messages, { where })
          .filter((m) => matches(byId.get(m.client_id as string) ?? {}, client))
          .sort((x, y) => (y.created_at as Date).getTime() - (x.created_at as Date).getTime())
          .slice(0, take)
          .map((m) => ({ client_id: m.client_id, body: m.body, client: { name: byId.get(m.client_id as string)?.name } })),
    },
  };
  return fakeOf<PrismaService>(prisma);
}

// Coach sharing: every client shares check-ins except a2.
const consent = fakeOf<ConsentService>({
  coachCanAccess: async (_coach: string, clientId: string) => clientId !== 'a2',
});

const ROSTER_A = ['a1', 'a2', 'a3', 'a5', 'a6'];

// a7 is passed as a stale own client: the message query's own roster fence drops it.
async function forHeadA() {
  return aggregateHeadBriefTeam(world(), consent, {
    headCoachId: 'headA',
    rosterClientIds: ROSTER_A,
    ownClientIds: ['a1', 'a2', 'a5', 'a6', 'a7'],
    yesterday: YESTERDAY,
  });
}

describe('aggregateHeadBriefTeam: one head coach, real filters', () => {
  beforeEach(() => {
    process.env.FEATURE_MESSAGING_CORE_V2 = 'true';
  });
  afterEach(() => {
    delete process.env.FEATURE_MESSAGING_CORE_V2;
  });

  it('counts yesterday: joins by code or by account, leaves, net', async () => {
    const r = await forHeadA();
    // a1 (code) + a5 (code and account, once); a4 archived; b1 is head B's.
    expect(r.clients_yesterday).toEqual({ date: DAY, added: 2, left: 1, net: 1 });
  });

  it('counts check-ins of the roster on that day, only where shared', async () => {
    const r = await forHeadA();
    // a1 + a3 on the day; a2 does not share (and checked in the day before).
    expect(r.activity).toMatchObject({ check_ins_date: DAY, check_ins_completed: 2, check_ins_not_shared: 1 });
  });

  it('only own clients who wrote and are unread, one row each with the newest preview', async () => {
    const r = await forHeadA();
    // a3 is delegated; a2 only has a coach send and a read message; a6 is
    // blocked; a5's message was deleted for everyone; a7 left for coach X.
    expect(r.unreadThreads).toEqual([{ client_id: 'a1', client_name: 'a1 Client', message_preview: 'newest from a1' }]);
    expect(r.activity.clients_messaged).toBe(1);
  });

  it('another head coach gets only their own clients and numbers', async () => {
    const r = await aggregateHeadBriefTeam(world(), consent, {
      headCoachId: 'headB',
      rosterClientIds: ['b1'],
      ownClientIds: ['b1'],
      yesterday: YESTERDAY,
    });
    expect(r.clients_yesterday).toEqual({ date: DAY, added: 1, left: 0, net: 1 });
    expect(r.activity).toMatchObject({ check_ins_completed: 1, clients_messaged: 1 });
    expect(r.unreadThreads.map((t) => t.client_id)).toEqual(['b1']);
  });

  it('an empty roster runs no client query', async () => {
    const r = await aggregateHeadBriefTeam(world(), consent, {
      headCoachId: 'headC',
      rosterClientIds: [],
      ownClientIds: [],
      yesterday: YESTERDAY,
    });
    expect(r.unreadThreads).toEqual([]);
    expect(r.activity).toMatchObject({ check_ins_completed: 0, check_ins_not_shared: 0, clients_messaged: 0 });
  });

  it('previousDate crosses months and years', () => {
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
    expect(previousDate('2027-01-01')).toBe('2026-12-31');
  });
});

// ─── Through CoachBriefService ──────────────────────────────────────────

const BRIEF_DATE = '2026-05-25';

function generatingRow(id: string, coachId: string, now: Date) {
  const empty = { generated_at: null, narrative: null, brief_context: null, action_items: null, generated_by: null, brief_mode: null };
  return { id, coach_id: coachId, brief_date: BRIEF_DATE, status: 'generating', generation_started_at: now, created_at: now, ...empty };
}

// A stored head brief written under Team Mode (team keys, a team item, a
// sub-coach named in the narrative), as main and Team Mode on write it.
function teamRow(date: string): Row {
  return {
    ...generatingRow(`t-${date}`, 'head1', new Date()),
    brief_date: date,
    status: 'generated',
    generated_at: new Date(),
    generation_started_at: null,
    narrative: 'Good morning, Marcus. Coach Priya supports 1 active client.',
    brief_context: makeHeadCoachContext({ team_size: 1, sub_coach_highlights: [{ coach_name: 'Coach Priya', active_clients: 1, new_clients_24h: 0 }] }),
    action_items: [{ type: 'team_performance', detail: 'Team-wide 2 active clients', priority: 3, deep_link: 'tgp://command-center/team' }],
    generated_by: 'ai',
    brief_mode: 'head_coach',
  };
}

// Everything a head brief may only carry while Team Mode is on.
const TEAM_TRACES = ['team_size', 'sub_coach_highlights', 'sub_coach_operations', 'team_performance', 'tgp://team', 'command-center/team', 'Coach Priya'];
const traces = (payload: unknown) => TEAM_TRACES.filter((t) => JSON.stringify(payload).includes(t));

// cown is the head's own client; cdel is delegated to sub-coach Priya.
const MESSAGES = [
  { client_id: 'cown', body: 'Can we move my session?', client: { name: 'Sarah Lee' } },
  { client_id: 'cdel', body: 'Only for my sub-coach', client: { name: 'Dana Cole' } },
];

// CoachBrief rows, the head's clients and open delegations in memory; a test
// may move or delegate a client between calls.
function wireHead(prisma: MockPrisma, rows: Row[] = []) {
  const now = new Date();
  const clients = [student('cown', 'head1', { created_at: now }), student('cdel', 'head1', { created_at: now })];
  const delegations: Row[] = [{ head_coach_id: 'head1', sub_coach_id: 'sub1', client_id: 'cdel', unassigned_at: null }];
  prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
  prisma.teamSubCoachAssignment.count.mockResolvedValue(1);
  prisma.user.findUnique.mockResolvedValue({ name: 'Marcus Reed' });
  prisma.teamSubCoachAssignment.findMany.mockResolvedValue([
    { sub_coach_id: 'sub1', sub_coach: { id: 'sub1', name: 'Coach Priya' } },
  ]);
  prisma.subCoachAssignment.findMany.mockImplementation(async (a: { where: Row }) => delegations.filter((d) => matches(d, a.where)));
  prisma.user.findMany.mockImplementation(async (a: { where: Row }) => clients.filter((c) => matches(c, a.where)));
  prisma.user.count.mockResolvedValue(0);
  prisma.checkIn.count.mockResolvedValue(7);
  prisma.coachMessage.findMany.mockImplementation(async (a: { where: { client_id: { in: string[] } } }) =>
    MESSAGES.filter((m) => a.where.client_id.in.includes(m.client_id)),
  );
  prisma.chargeSettlement.aggregate.mockResolvedValue({ _sum: { gross_cents: 124000 }, _count: { _all: 4 } });
  prisma.$queryRaw.mockResolvedValue([{ mrr_cents: 0n, count: 1n, total: 4900n }]);
  const keys = ['id', 'coach_id', 'brief_date'];
  const at = (where: Row) => rows.find((r) => keys.every((k) => where[k] === undefined || r[k] === where[k]));
  prisma.coachBrief.findUnique.mockImplementation(async (a: { where: { CoachBrief_coach_date_key: Row } }) => at(a.where.CoachBrief_coach_date_key) ?? null);
  prisma.coachBrief.create.mockImplementation(async () => rows[rows.push(generatingRow('b1', 'head1', now)) - 1]);
  prisma.coachBrief.updateMany.mockImplementation(async (a: { where: Row; data: Row }) => {
    const r = at(a.where);
    if (r) Object.assign(r, a.data);
    return { count: r ? 1 : 0 };
  });
  prisma.coachBrief.update.mockImplementation(async (a: { where: { CoachBrief_coach_date_key: Row }; data: Row }) =>
    Object.assign(at(a.where.CoachBrief_coach_date_key) ?? {}, a.data),
  );
  prisma.coachBrief.findFirst.mockImplementation(async (a: { where: Row }) => at(a.where) ?? null);
  const own = (a: { where: Row }) => rows.filter((r) => r.coach_id === a.where.coach_id);
  prisma.coachBrief.count.mockImplementation(async (a: { where: Row }) => own(a).length);
  prisma.coachBrief.findMany.mockImplementation(async (a: { where: Row }) => own(a));
  return { rows, clients, delegations };
}

async function withTeamMode<T>(on: boolean, run: () => Promise<T>): Promise<T> {
  if (on) process.env.FEATURE_TEAM_MODE = 'true';
  try {
    return await run();
  } finally {
    delete process.env.FEATURE_TEAM_MODE;
  }
}

async function generateHead(teamMode: boolean, rows: Row[] = []) {
  const prisma = makeMockPrisma();
  wireHead(prisma, rows);
  const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  const callClaude = jest.spyOn(svc, 'callClaude');
  const res = await withTeamMode(teamMode, () => svc.generateBrief('head1', 'America/Los_Angeles', BRIEF_DATE));
  const row = rows.find((r) => r.brief_date === BRIEF_DATE);
  const saved = { context: row?.brief_context as Row | undefined, items: row?.action_items as Row[] | undefined };
  const aiCtx = callClaude.mock.calls[0]?.[1]?.ctx as BriefContextHeadCoach | undefined;
  return { prisma, saved, aiCtx, res, svc };
}

describe('CoachBriefService head brief with team data (BRIEFTEAM)', () => {
  it.each([false, true])('Team Mode %s: a delegated client\u2019s message and name never reach the head; an own client\u2019s do', async (on) => {
    const { prisma, res } = await generateHead(on);
    const body = JSON.stringify(res);
    expect(body).toContain('Sarah Lee');
    expect(body).toContain('Can we move my session?');
    for (const hidden of ['Dana Cole', 'Only for my sub-coach', 'tgp://messages/cdel']) expect(body).not.toContain(hidden);
    expect(prisma.coachMessage.findMany.mock.calls[0][0]).toMatchObject({
      where: { coach_id: 'head1', client_id: { in: ['cown'] }, sender_id: { in: ['cown'] }, client: { coach_id: 'head1', archived_at: null } },
      take: 100,
    });
  });

  it('Team Mode off: no team key, team item, Team link or sub-coach name, fresh or cached', async () => {
    const { res, saved, svc, prisma } = await generateHead(false);
    expect(traces(res)).toEqual([]);
    expect(traces(saved)).toEqual([]);
    const cached = await svc.generateBrief('head1', 'America/Los_Angeles', BRIEF_DATE);
    expect(prisma.coachBrief.update).toHaveBeenCalledTimes(1);
    expect(cached.summary).toEqual(res.summary);
    expect(res.summary?.narrative).not.toMatch(/sub-coach/i);
    expect((res.summary?.action_items ?? []).map((i) => i.type)).toEqual(
      expect.arrayContaining(['dunning_queue', 'team_revenue_review', 'message_unread']),
    );
  });

  it('Team Mode on: the team keys and items are sent', async () => {
    const { res } = await generateHead(true);
    expect(traces(res)).toEqual(TEAM_TRACES);
  });

  it.each([
    [false, () => teamRow(BRIEF_DATE)],
    [true, () => ({ ...teamRow(BRIEF_DATE), narrative: 'Good morning, Marcus.', brief_context: headCoachTeamView(makeHeadCoachContext(), false), action_items: [] })],
  ])('Team Mode %s: today\u2019s head brief stored under the other state is written again, not sent', async (on, stored) => {
    const { prisma, res } = await generateHead(on, [stored()]);
    expect(prisma.coachBrief.update).toHaveBeenCalledTimes(1);
    expect(res.summary?.narrative).not.toContain('Coach Priya');
    expect(traces(res).includes('team_size')).toBe(on);
  });

  it('history withholds a head brief stored under the other Team Mode state', async () => {
    const prisma = makeMockPrisma();
    const { rows } = wireHead(prisma, [teamRow('2026-05-24')]);
    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
    await svc.generateBrief('head1', 'America/Los_Angeles', BRIEF_DATE);
    const history = await svc.getBriefHistory('head1', 1, 10);
    expect(rows).toHaveLength(2);
    expect(history.items.map((i) => [i.brief_date, i.summary !== null])).toEqual([
      ['2026-05-24', false],
      [BRIEF_DATE, true],
    ]);
    expect(traces(history)).toEqual([]);
    const on = await withTeamMode(true, () => svc.getBriefHistory('head1', 1, 10));
    expect(on.items.map((i) => i.summary !== null)).toEqual([true, false]);
  });

  // BRIEFTEAM2 (Sol B3): a stored brief names a client only while they are
  // still the head coach's own; every return re-checks it.
  const NAMED = ['Sarah Lee', 'Can we move my session?', 'tgp://messages/cown'];
  it.each<[string, (w: ReturnType<typeof wireHead>) => unknown]>([
    ['moves to another coach', (w) => Object.assign(w.clients[0], { coach_id: 'coachX' })],
    ['is delegated to a sub-coach', (w) => w.delegations.push({ head_coach_id: 'head1', sub_coach_id: 'sub1', client_id: 'cown', unassigned_at: null })],
    ['is archived', (w) => Object.assign(w.clients[0], { archived_at: new Date() })],
  ])('generate, then the client %s: today is written again without them and history withholds the day', async (_, change) => {
    const prisma = makeMockPrisma();
    const w = wireHead(prisma);
    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
    const first = await svc.generateBrief('head1', 'America/Los_Angeles', BRIEF_DATE);
    w.rows.push({ ...w.rows[0], id: 'b0', brief_date: '2026-05-24' });
    for (const n of NAMED) expect(JSON.stringify(first)).toContain(n);
    expect((await svc.getBriefHistory('head1', 1, 10)).items.every((i) => i.summary !== null)).toBe(true);
    change(w);
    const today = await svc.generateBrief('head1', 'America/Los_Angeles', BRIEF_DATE);
    const history = await svc.getBriefHistory('head1', 1, 10);
    expect(prisma.coachBrief.update).toHaveBeenCalledTimes(2);
    for (const n of NAMED) expect(JSON.stringify([today, history])).not.toContain(n);
    expect(history.items.map((i) => [i.brief_date, i.summary !== null])).toEqual([[BRIEF_DATE, true], ['2026-05-24', false]]);
  });

  it('another head coach and the sub-coach cannot read or mark the stored head brief', async () => {
    const prisma = makeMockPrisma();
    const { rows } = wireHead(prisma);
    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
    await svc.generateBrief('head1', 'America/Los_Angeles', BRIEF_DATE);
    for (const other of ['head2', 'sub1']) {
      expect((await svc.getBriefHistory(other, 1, 10)).items).toEqual([]);
      await expect(svc.markBriefRead(other, String(rows[0].id))).rejects.toBeInstanceOf(BriefNotFoundError);
    }
    expect(rows[0].read_at).toBeUndefined();
  });

  it('stores the day numbers and gives the phone a message row it can open (BRIEF-AGG)', async () => {
    const { saved } = await generateHead(false);
    expect(saved.context).toMatchObject({
      clients_yesterday: { date: '2026-05-24', added: 0, left: 0, net: 0 },
      activity: { check_ins_date: '2026-05-24', check_ins_completed: 7, check_ins_not_shared: 0, clients_messaged: 1 },
    });
    const messages = (saved.items ?? []).filter((i) => i.type === 'message_unread');
    expect(messages).toEqual([
      { type: 'message_unread', client_id: 'cown', client_name: 'Sarah Lee', detail: 'Can we move my session?', priority: 1, deep_link: 'tgp://messages/cown' },
    ]);
    // Business items still carry no client identifier.
    for (const i of (saved.items ?? []).filter((x) => x.type !== 'message_unread')) {
      expect(i.client_id).toBeUndefined();
      expect(i.client_name).toBeUndefined();
    }
  });

  it('the AI writer sees business metrics only, never the activity counts', async () => {
    const { aiCtx } = await generateHead(false);
    expect(aiCtx?.brief_mode).toBe('head_coach');
    expect(aiCtx?.activity).toBeUndefined();
    expect(aiCtx?.clients_yesterday).toEqual({ date: '2026-05-24', added: 0, left: 0, net: 0 });
    const full: BriefContextHeadCoach = makeHeadCoachContext({
      clients_yesterday: { date: DAY, added: 1, left: 0, net: 1 },
      activity: { check_ins_date: DAY, check_ins_completed: 3, check_ins_not_shared: 0, clients_messaged: 2 },
    });
    expect(Object.keys(headCoachAiContext(full)).sort()).toEqual([
      'brief_mode', 'clients_yesterday', 'coach_first_name', 'coach_name', 'date', 'dunning_amount_cents',
      'dunning_in_progress', 'mrr_projected_cents', 'new_clients_last_24h', 'paid_today_count', 'sub_coach_highlights',
      'team_clients_total', 'team_revenue_30d_cents', 'team_size', 'total_revenue_today_cents',
    ]);
  });

  it('a sub-coach brief never runs the head coach team queries', async () => {
    const prisma = makeMockPrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue({ id: 'seat' });
    prisma.subCoachAssignment.findMany.mockResolvedValue([{ client_id: 'cdel' }]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'cdel' }]).mockResolvedValueOnce([]);
    prisma.user.findUnique.mockResolvedValue({ name: 'Coach Priya' });
    prisma.checkIn.findMany.mockResolvedValue([]);
    prisma.clientWorkoutAssignment.count.mockResolvedValue(0);
    prisma.chargeSettlement.aggregate.mockResolvedValue({ _sum: { gross_cents: null }, _count: { _all: 0 } });
    prisma.clientPurchase.count.mockResolvedValue(0);
    prisma.coachMessage.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.coachBrief.findUnique.mockResolvedValue(null);
    prisma.coachBrief.create.mockResolvedValue(generatingRow('b2', 'sub1', new Date()));
    let context: Row | undefined;
    prisma.coachBrief.update.mockImplementation((args: { data: { brief_context: Row } }) => {
      context = args.data.brief_context;
      return Promise.resolve({
        ...generatingRow('b2', 'sub1', new Date()),
        status: 'generated',
        generated_at: new Date(),
        narrative: 'n',
        brief_context: context,
        action_items: [],
        generated_by: 'fallback',
        brief_mode: 'sub_coach',
      });
    });
    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
    await svc.generateBrief('sub1', 'America/Los_Angeles', '2026-05-25');
    expect(context?.brief_mode).toBe('sub_coach');
    expect(context?.activity).toBeUndefined();
    expect(context?.clients_yesterday).toBeUndefined();
    expect(prisma.inviteRedemption.findMany).not.toHaveBeenCalled();
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });

  it('a client cannot reach the brief routes (CoachGuard)', () => {
    const ctx = fakeOf<ExecutionContext>({
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'cown', role: 'student' } }) }),
    });
    expect(() => new CoachGuard().canActivate(ctx)).toThrow(ForbiddenException);
  });
});
