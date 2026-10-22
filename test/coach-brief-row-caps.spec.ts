/**
 * ROMAN-EXTRAS-BE2: brief rows carry occurred_at, are newest first within one
 * type, and stop at 100 per type, so a 100-client coach sees every row. The
 * mock answers each read like the database does: it honours where, orderBy,
 * distinct, take and the weigh-in SQL's ORDER BY / LIMIT. One generateBrief
 * makes the same number of reads at 1, 10 and 150 clients (no per-client read).
 */
import {
  bucketDateLocal,
  buildActionItems,
  BRIEF_ROWS_PER_KIND,
  CoachBriefService,
} from '../src/coach/brief/coach-brief.service';
import type { ActionItem } from '../src/coach/brief/coach-brief.types';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import { asConfig, asPrismaService, makeMockConfig, makeMockPrisma, wireSoloDefaults } from './_fixtures/coach-brief-mocks';

const TZ = 'America/Los_Angeles';
const COACH = 'coach-1';
type Where = Record<string, any>;
type Sql = { strings: string[]; values: unknown[] };

// Client i's events are i minutes old, so c000 is the newest of each kind.
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);
const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${String(i).padStart(3, '0')}`);
const age = (id: string) => Number(id.slice(1));
// Names run in the opposite order to ids, so name order is not id order.
const nameOf = (id: string) => `Name ${String(999 - age(id)).padStart(3, '0')}`;
const shuffle = <T>(rows: T[]) => [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? 1 : -1));

function distinctBy<T extends Record<string, any>>(rows: T[], keys?: string[]): T[] {
  if (!keys) return rows;
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = keys.map((key) => r[key]).join('\n');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every client has one row of every kind; `busy` also sends `busyLines` unread lines. */
async function brief(n: number, opts: { busy?: string; busyLines?: number } = {}) {
  const clients = ids(n);
  const prisma = makeMockPrisma();
  wireSoloDefaults(prisma, { coachId: COACH, clientIds: [] });
  prisma.user.findMany.mockReset();
  prisma.user.findMany.mockImplementation(async ({ where, orderBy, take }: { where: Where; orderBy?: Where; take?: number }) => {
    const mine = clients.filter((id) => !where.id || where.id.in.includes(id));
    if (where.check_ins) {
      const rows = mine.map((id) => ({ id, name: nameOf(id) }));
      if (orderBy?.name === 'asc') rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows.slice(0, take);
    }
    if (!where.onboarding_intake) return mine.map((id) => ({ id })); // the roster
    // Joined in the last 24 h. With no orderBy the database's order is any
    // order, so the mock shuffles unless the read sorts by coach_joined_at.
    const rows = shuffle(mine.map((id) => ({
      id, name: nameOf(id), coach_joined_at: minsAgo(age(id) + 1), onboarding_intake: { completed_at: minsAgo(60 * 24 * 40) },
    })));
    if (orderBy?.coach_joined_at?.sort === 'desc') rows.sort((a, b) => +b.coach_joined_at - +a.coach_joined_at);
    return rows.slice(0, take);
  });
  prisma.checkIn.findMany.mockImplementation(async ({ where, distinct, take }: { where: Where; distinct?: string[]; take?: number }) => {
    if (where.reviewed_by_coach !== false) return []; // nobody checked in today
    const rows = where.user_id.in.flatMap((id: string) => [
      { id: `ci-${id}-new`, user_id: id, logged_at: minsAgo(age(id) + 2), user: { name: nameOf(id) } },
      { id: `ci-${id}-old`, user_id: id, logged_at: minsAgo(age(id) + 600), user: { name: nameOf(id) } },
    ]);
    rows.sort((a: { logged_at: Date }, b: { logged_at: Date }) => +b.logged_at - +a.logged_at);
    return distinctBy(rows, distinct).slice(0, take);
  });
  prisma.$queryRaw.mockImplementation(async (sql: Sql) => {
    const text = sql.strings.join('?');
    if (!text.includes('"WeightLog"')) return [{ count: 0n, total: 0n }];
    expect(text).toMatch(/ORDER BY r1\."logged_at" DESC\s+LIMIT \?/);
    const limit = Number(sql.values[sql.values.length - 1]);
    const rows = (sql.values[0] as string[]).map((id) => ({
      user_id: id, user_name: nameOf(id), delta_lbs: 5, logged_at: minsAgo(age(id) + 3),
    }));
    return rows.sort((a, b) => +b.logged_at - +a.logged_at).slice(0, limit);
  });
  prisma.coachMessage.findMany.mockImplementation(
    async ({ where, distinct, take }: { where: Where; distinct?: string[]; take?: number }) => {
      const lines = (where.client_id.in as string[]).flatMap((id) =>
        Array.from({ length: id === opts.busy ? (opts.busyLines ?? 1) : 1 }, (_, k) => ({
          client_id: id, coach_id: COACH, body: `line ${k} from ${id}`, card: null,
          created_at: minsAgo(id === opts.busy ? k / 100 : age(id) + 4),
          client: { name: nameOf(id), coach_id: COACH },
        })),
      );
      lines.sort((a, b) => +b.created_at - +a.created_at);
      return distinctBy(lines, distinct).slice(0, take);
    },
  );
  prisma.coachBrief.updateMany.mockResolvedValue({ count: 1 });
  prisma.coachBrief.update.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'b1', coach_id: COACH, brief_date: '2026-10-21', created_at: new Date(), ...data,
  }));
  const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  await svc.generateBrief(COACH, TZ, bucketDateLocal(new Date(), TZ), { force: true });
  const data = prisma.coachBrief.update.mock.calls[0][0].data;
  const items: ActionItem[] = data.action_items;
  // Every call to every mocked delegate method (and $queryRaw).
  const calls = (fn: unknown): number => (jest.isMockFunction(fn) ? fn.mock.calls.length : 0);
  const reads = Object.values(prisma).reduce<number>((sum, model: unknown) => {
    if (jest.isMockFunction(model)) return sum + calls(model);
    if (!model || typeof model !== 'object') return sum;
    return sum + Object.values(model).reduce<number>((s, fn: unknown) => s + calls(fn), 0);
  }, 0);
  return { prisma, items, ctx: data.brief_context, reads, of: (t: string) => items.filter((i) => i.type === t) };
}

const KINDS = ['client_joined', 'message_unread', 'checkin_review', 'weight_flag', 'checkin_missing'] as const;
const TIMED = KINDS.filter((k) => k !== 'checkin_missing');
const newestFirst = (rows: ActionItem[]) =>
  rows.every((r, i) => i === 0 || (rows[i - 1].occurred_at as string) >= (r.occurred_at as string));

describe('brief rows: times, order and caps (ROMAN-EXTRAS-BE2)', () => {
  it('0 clients: no rows', async () => {
    const { items } = await brief(0);
    expect(items).toEqual([]);
  });

  it('10 clients: 10 rows of each type, each timed row has an ISO occurred_at, newest first', async () => {
    const { items, of } = await brief(10);
    for (const k of KINDS) expect(of(k)).toHaveLength(10);
    for (const k of TIMED) {
      for (const r of of(k)) expect(r.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(newestFirst(of(k))).toBe(true);
      expect(of(k)[0].client_id).toBe('c000');
    }
    // checkin_missing has no event time; its rows are in name order.
    expect(of('checkin_missing').every((r) => r.occurred_at === undefined)).toBe(true);
    expect(of('checkin_missing').map((r) => r.client_name)).toEqual(ids(10).map(nameOf).sort());
    // The type order old phones read is unchanged: priority, then type.
    const runs = items.map((i) => i.type).filter((t, i, all) => t !== all[i - 1]);
    expect(runs).toEqual(KINDS);
    expect(items.map((i) => i.priority)).toEqual([...items.map((i) => i.priority)].sort());
  });

  it('existing fields stay as they were', async () => {
    const { of } = await brief(10);
    expect(of('checkin_review')[0]).toEqual({
      type: 'checkin_review', client_id: 'c000', client_name: nameOf('c000'), check_in_id: 'ci-c000-new',
      detail: 'Check-in needs review', priority: 2, deep_link: 'tgp://client/c000', occurred_at: expect.any(String),
    });
    const joined = of('client_joined')[0];
    expect(joined).toMatchObject({ type: 'client_joined', priority: 1, deep_link: 'tgp://messages/c000' });
    expect(joined.occurred_at).toBe(joined.joined_at);
    expect(of('message_unread')[0]).toMatchObject({ detail: 'line 0 from c000', deep_link: 'tgp://messages/c000' });
    expect(of('weight_flag')[0]).toMatchObject({ detail: 'Weight change of 5.0 lbs needs review', priority: 2 });
    expect(of('checkin_missing')[0]).toMatchObject({ detail: 'Has not checked in today', priority: 3 });
  });

  it('150 clients: at most 100 rows of each type, the newest 100 for timed types', async () => {
    const { of, prisma } = await brief(150);
    for (const k of KINDS) expect(of(k)).toHaveLength(BRIEF_ROWS_PER_KIND);
    for (const k of TIMED) {
      expect(newestFirst(of(k))).toBe(true);
      expect(new Set(of(k).map((r) => r.client_id))).toEqual(new Set(ids(100)));
    }
    expect(of('checkin_missing').map((r) => r.client_name)).toEqual(ids(150).map(nameOf).sort().slice(0, 100));
    // Every read is capped at 100 in the query itself.
    const takes = [
      ...prisma.user.findMany.mock.calls.map(([a]: [{ take?: number }]) => a.take),
      ...prisma.checkIn.findMany.mock.calls.map(([a]: [{ take?: number }]) => a.take),
      ...prisma.coachMessage.findMany.mock.calls.map(([a]: [{ take?: number }]) => a.take),
    ].filter((t) => t !== undefined);
    expect(takes.length).toBeGreaterThanOrEqual(4);
    expect(takes.every((t) => t === BRIEF_ROWS_PER_KIND)).toBe(true);
  });

  it("one busy client's 200 unread lines do not hide anyone else's thread", async () => {
    const { of, ctx, prisma } = await brief(40, { busy: 'c039', busyLines: 200 });
    expect(of('message_unread')).toHaveLength(40);
    expect(ctx.unread_messages).toBe(40);
    expect(of('message_unread')[0]).toMatchObject({ client_id: 'c039', detail: 'line 0 from c039' });
    const args = prisma.coachMessage.findMany.mock.calls[0][0];
    expect(args).toMatchObject({ orderBy: { created_at: 'desc' }, distinct: ['client_id', 'coach_id'] });
  });

  it('the read count does not grow with the roster (no read per client)', async () => {
    const one = (await brief(1)).reads;
    expect((await brief(10)).reads).toBe(one);
    expect((await brief(150)).reads).toBe(one);
  });
});

describe('buildActionItems caps and order (ROMAN-EXTRAS-BE2)', () => {
  const t = (m: number) => minsAgo(m);
  it('keeps 100 of 150 rows of every type and sorts each type newest first', () => {
    const list = ids(150);
    const items = buildActionItems({
      unreadThreads: list.map((id) => ({ client_id: id, client_name: id, message_preview: 'hi', occurred_at: t(age(id)) })),
      flaggedWeightLogs: list.map((id) => ({ client_id: id, client_name: id, delta_lbs: 5, occurred_at: t(age(id)) })),
      missingCheckinClients: list.map((id) => ({ id, name: id })),
      reviewCheckIns: list.map((id) => ({ id: `ci-${id}`, client_id: id, client_name: id, occurred_at: t(age(id)) })),
      joinedClients: list.map((id) => ({ client_id: id, client_name: id, joined_at: t(age(id)), joined_today: true })),
    });
    for (const k of KINDS) expect(items.filter((i) => i.type === k)).toHaveLength(100);
    expect(items).toHaveLength(500);
  });

  it('a type given oldest first comes out newest first; rows with no time keep their order', () => {
    const items = buildActionItems({
      unreadThreads: [
        { client_id: 'old', client_name: 'Old', message_preview: 'a', occurred_at: t(90) },
        { client_id: 'new', client_name: 'New', message_preview: 'b', occurred_at: t(1) },
      ],
      flaggedWeightLogs: [],
      missingCheckinClients: [{ id: 'm2', name: 'Bo' }, { id: 'm1', name: 'Al' }],
    });
    expect(items.map((i) => i.client_id)).toEqual(['new', 'old', 'm2', 'm1']);
  });

  it('0 rows in, 0 rows out', () => {
    expect(buildActionItems({ unreadThreads: [], flaggedWeightLogs: [], missingCheckinClients: [] })).toEqual([]);
  });
});
