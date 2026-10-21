/**
 * ROMAN-EXTRAS (spec 2b R1, R2; owner #161-3): the brief's checkin_review and
 * client_joined rows, on the fallback brief (AI off). Rows are answered by the
 * filter the service sends, like the database. The row layer under these reads
 * runs live in rls-live-tests: CheckIn in test/rls/health-history-rls.spec.ts,
 * User in test/rls/user-identity-rls.spec.ts, and the User.coach_joined_at
 * trigger in test/rls/user-coach-joined-at.spec.ts.
 */
import {
  bucketDateLocal,
  buildBriefPrompt,
  buildFallbackNarrative,
  CoachBriefService,
} from '../src/coach/brief/coach-brief.service';
import type { BriefContext } from '../src/coach/brief/coach-brief.types';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import { asConfig, asPrismaService, makeMockConfig, makeMockPrisma, wireSoloDefaults } from './_fixtures/coach-brief-mocks';

const TZ = 'America/Los_Angeles';
const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
// joinedAt = User.coach_joined_at (when the client joined their current coach).
type Client = { id: string; coach_id: string; done: Date | null; joinedAt?: Date };
type Row = { id: string; user_id: string; coach_id: string; reviewed: boolean; logged_at: Date };
type Where = Record<string, any>;

async function brief(coachId: string, clients: Client[], checkIns: Row[] = []) {
  const prisma = makeMockPrisma();
  wireSoloDefaults(prisma, { coachId, clientIds: [] });
  prisma.user.findMany.mockReset();
  prisma.user.findMany.mockImplementation(async ({ where }: { where: Where }) => {
    if (where.check_ins) return []; // nobody is missing today's check-in
    const mine = clients.filter((c) => c.coach_id === where.coach_id && (!where.id || where.id.in.includes(c.id)));
    if (!where.onboarding_intake) return mine.map(({ id }) => ({ id })); // the roster
    const since: Date = where.OR[0].onboarding_intake.is.completed_at.gte;
    expect(where.OR[1]).toEqual({ coach_joined_at: { gte: since } });
    return mine
      .filter((c) => c.done && (c.done >= since || (c.joinedAt ?? new Date(0)) >= since))
      .map((c) => ({
        id: c.id,
        name: `Name ${c.id}`,
        coach_joined_at: c.joinedAt ?? null,
        onboarding_intake: { completed_at: c.done },
      }));
  });
  prisma.checkIn.findMany.mockImplementation(async ({ where, distinct }: { where: Where; distinct?: string[] }) => {
    if (where.reviewed_by_coach !== false) return []; // today's count
    const rows = checkIns
      .filter((r) => where.user_id.in.includes(r.user_id) && r.coach_id === where.coach_id)
      .filter((r) => !r.reviewed && r.logged_at >= where.logged_at.gte)
      .sort((a, b) => +b.logged_at - +a.logged_at) // orderBy logged_at desc
      .filter((r, i, all) => !distinct?.includes('user_id') || all.findIndex((x) => x.user_id === r.user_id) === i);
    return rows.map((r) => ({ id: r.id, user_id: r.user_id, user: { name: `Name ${r.user_id}` } }));
  });
  // No flagged weigh-ins (the default answers every raw read with one count row).
  prisma.$queryRaw.mockImplementation(async (sql: { strings: string[] }) =>
    sql.strings.join('').includes('"WeightLog"') ? [] : [{ count: 0n, total: 0n }],
  );
  prisma.coachBrief.updateMany.mockResolvedValue({ count: 1 });
  prisma.coachBrief.update.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'b1', coach_id: coachId, brief_date: '2026-10-20', created_at: new Date(), ...data,
  }));
  const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  await svc.generateBrief(coachId, TZ, bucketDateLocal(new Date(), TZ), { force: true });
  const data = prisma.coachBrief.update.mock.calls[0][0].data;
  expect(data.generated_by).toBe('fallback');
  const items: Array<Record<string, unknown>> = data.action_items;
  return { prisma, narrative: String(data.narrative), of: (type: string) => items.filter((i) => i.type === type) };
}

const linked = (id: string, coach_id: string, done: Date | null = ago(24 * 40)): Client => ({ id, coach_id, done });
const checkIn = (user_id: string, coach_id: string, reviewed: boolean, h = 2): Row =>
  ({ id: `ci-${user_id}-${h}`, user_id, coach_id, reviewed, logged_at: ago(h) });

describe('coach brief: checkin_review (R1)', () => {
  it('an unreviewed check-in from the last 24 h is one row; a reviewed or older one is none', async () => {
    const { of } = await brief('A', [linked('a1', 'A'), linked('a2', 'A'), linked('a3', 'A')], [
      checkIn('a1', 'A', false), checkIn('a2', 'A', true), checkIn('a3', 'A', false, 25),
    ]);
    expect(of('checkin_review')).toEqual([{
      type: 'checkin_review', client_id: 'a1', client_name: 'Name a1', check_in_id: 'ci-a1-2',
      detail: 'Check-in needs review', priority: 2, deep_link: 'tgp://client/a1',
    }]);
  });

  it('one row per client: two unreviewed check-ins in the window give the newest only', async () => {
    const { prisma, of } = await brief('A', [linked('a1', 'A')], [checkIn('a1', 'A', false, 20), checkIn('a1', 'A', false, 2)]);
    expect(of('checkin_review').map((r) => r.check_in_id)).toEqual(['ci-a1-2']);
    const args = prisma.checkIn.findMany.mock.calls.map(([a]: Array<{ where: Where }>) => a)
      .find((a: { where: Where }) => a.where.reviewed_by_coach === false);
    expect(args).toMatchObject({ distinct: ['user_id'], orderBy: { logged_at: 'desc' } });
  });

  it("coach B never sees coach A's client", async () => {
    const clients = [linked('a1', 'A', ago(2)), linked('b1', 'B')];
    const { prisma, of } = await brief('B', clients, [checkIn('a1', 'A', false), checkIn('b1', 'B', true)]);
    expect([...of('checkin_review'), ...of('client_joined')]).toEqual([]);
    const where = prisma.checkIn.findMany.mock.calls.map(([a]: Array<{ where: Where }>) => a.where)
      .find((w: Where) => w.reviewed_by_coach === false);
    expect(where).toMatchObject({ user_id: { in: ['b1'] }, coach_id: 'B' });
  });
});

describe('coach brief: client_joined (R2)', () => {
  it('a client who joined 23 h ago appears; 25 h ago does not; a code join counts from the join', async () => {
    const joinedByCode: Client = { ...linked('a3', 'A'), joinedAt: ago(2) };
    const { of } = await brief('A', [linked('a1', 'A', ago(23)), linked('a2', 'A', ago(25)), joinedByCode, linked('a4', 'A', null)]);
    const rows = of('client_joined');
    expect(rows.map((r) => r.client_id).sort()).toEqual(['a1', 'a3']);
    const a1 = rows.find((r) => r.client_id === 'a1')!;
    expect(Math.abs(Date.parse(String(a1.joined_at)) - ago(23).getTime())).toBeLessThan(60_000);
    expect(a1).toMatchObject({ client_name: 'Name a1', priority: 1, deep_link: 'tgp://messages/a1' });
    expect(a1.detail).toBe(bucketDateLocal(ago(23), TZ) === bucketDateLocal(new Date(), TZ) ? 'Joined today' : 'Joined yesterday');
    expect(Date.parse(String(rows.find((r) => r.client_id === 'a3')!.joined_at))).toBeGreaterThan(ago(3).getTime());
  });

  it("a moved client's former coach never gets the row (nor the check-in logged with them)", async () => {
    const moved: Client = { id: 'm1', coach_id: 'B', done: ago(3), joinedAt: ago(1) };
    const rows = [checkIn('m1', 'A', false)];
    const former = await brief('A', [moved, linked('a1', 'A')], rows);
    expect([...former.of('client_joined'), ...former.of('checkin_review')]).toEqual([]);
    const current = await brief('B', [moved], rows);
    expect(current.of('client_joined').map((r) => r.client_id)).toEqual(['m1']);
    expect(current.of('checkin_review')).toEqual([]);
  });

  // FIX-1118-R2 (Sol B2): a move to this coach stamps a new join time (the
  // trigger), so a moved client with an old consultation is "Joined today".
  it('a client moved to this coach today, consultation 40 days ago, is "Joined today" for the new coach only', async () => {
    const moved: Client = { id: 'm2', coach_id: 'B', done: ago(24 * 40), joinedAt: new Date() };
    const current = await brief('B', [moved]);
    expect(current.of('client_joined')).toMatchObject([{ client_id: 'm2', detail: 'Joined today' }]);
    const former = await brief('A', [moved, linked('a1', 'A')]);
    expect(former.of('client_joined')).toEqual([]);
  });
});

// Sol B2: every way a client attaches to a coach writes User.coach_joined_at
// (database trigger), so a paid or guest-checkout join is seen even when the
// consultation finished days earlier; a renewal changes nothing.
describe('coach brief: client_joined from the stored join time (B2)', () => {
  it('a paid join today after a consultation two days ago is a row; a renewing client is not', async () => {
    const paidToday: Client = { id: 'p1', coach_id: 'A', done: ago(48), joinedAt: ago(1) };
    const renewing: Client = { id: 'r1', coach_id: 'A', done: ago(24 * 60), joinedAt: ago(24 * 60) };
    const legacy: Client = linked('l1', 'A'); // joined before the column: null
    const { of } = await brief('A', [paidToday, renewing, legacy]);
    const rows = of('client_joined');
    expect(rows.map((r) => r.client_id)).toEqual(['p1']);
    expect(Math.abs(Date.parse(String(rows[0].joined_at)) - ago(1).getTime())).toBeLessThan(60_000);
  });
});

// Opus + Sol B1: the brief sentence counts the new rows, so it never says
// "Nothing else needs your attention right now." above them.
describe('coach brief: the narrative counts the new rows (B1)', () => {
  const ALL_CLEAR = 'Nothing else needs your attention right now.';
  const FULL = 'The full details are below.';
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('review-only day: no all-clear, the existing full-details line once', async () => {
    const { narrative, of } = await brief('A', [linked('a1', 'A'), linked('a2', 'A')], [checkIn('a1', 'A', false)]);
    expect(of('checkin_review')).toHaveLength(1);
    expect(narrative).not.toContain(ALL_CLEAR);
    expect(count(narrative, FULL)).toBe(1);
  });

  it('joined-only day: no all-clear, the existing full-details line once', async () => {
    const { narrative, of } = await brief('A', [{ id: 'j1', coach_id: 'A', done: ago(48), joinedAt: ago(2) }]);
    expect(of('client_joined')).toHaveLength(1);
    expect(narrative).not.toContain(ALL_CLEAR);
    expect(count(narrative, FULL)).toBe(1);
  });

  it('a truly quiet day keeps the all-clear', async () => {
    const { narrative, of } = await brief('A', [linked('a1', 'A')], [checkIn('a1', 'A', true)]);
    expect([...of('checkin_review'), ...of('client_joined')]).toEqual([]);
    expect(narrative).toContain(ALL_CLEAR);
  });

  const ctx = (extra: Partial<BriefContext>): BriefContext => ({
    brief_mode: 'solo_coach', date: '2026-10-20', checked_in_today: 0, missed_checkin: 0,
    workouts_completed_today: 0, workouts_approved_today: 0, paid_today_count: 0, revenue_today_cents: 0,
    renewals_upcoming_7d: 0, dunning_in_progress: 0, weight_logs_flagged: 0, unread_messages: 0,
    coach_name: 'Sam Coach', coach_first_name: 'Sam', roster_size: 3, ...extra,
  });

  it('nobody shares check-ins and one client joined: two sentences, never the same line twice', () => {
    const text = buildFallbackNarrative(ctx({ joined_last_24h: 1, not_shared: { check_ins: 3, weigh_ins: 3, workouts: 3 } }));
    expect(text).toBe(`Good morning, Sam. ${FULL}`);
  });

  it('the AI prompt hands off to the new rows instead of "No action items today."', () => {
    expect(buildBriefPrompt(ctx({}))).toContain('No action items today.');
    const prompt = buildBriefPrompt(ctx({ checkins_to_review: 2, joined_last_24h: 1 }));
    expect(prompt).toContain('End with a handoff to 3 action items.');
    expect(prompt).toContain("Check-ins waiting for the coach's review (last 24 h): 2");
    expect(prompt).toContain('Clients who joined in the last 24 h: 1');
  });
});
