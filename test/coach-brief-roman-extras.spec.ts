/**
 * ROMAN-EXTRAS (spec 2b R1, R2; owner #161-3): the brief's checkin_review and
 * client_joined rows, on the fallback brief (AI off). Rows are answered by the
 * filter the service sends, like the database. The row layer under these reads
 * runs live in rls-live-tests: CheckIn in test/rls/health-history-rls.spec.ts,
 * User in test/rls/user-identity-rls.spec.ts.
 */
import { bucketDateLocal, CoachBriefService } from '../src/coach/brief/coach-brief.service';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import { asConfig, asPrismaService, makeMockConfig, makeMockPrisma, wireSoloDefaults } from './_fixtures/coach-brief-mocks';

const TZ = 'America/Los_Angeles';
const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
type Client = { id: string; coach_id: string; done: Date | null; joins?: Array<{ coach_id: string; at: Date }> };
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
    const joins = (c: Client) => (c.joins ?? []).filter((j) => j.coach_id === where.coach_id);
    return mine
      .filter((c) => c.done && (c.done >= since || joins(c).some((j) => j.at >= since)))
      .map((c) => ({
        id: c.id,
        name: `Name ${c.id}`,
        onboarding_intake: { completed_at: c.done },
        invite_redemptions_as_client: joins(c).sort((a, b) => +b.at - +a.at).slice(0, 1).map((j) => ({ redeemed_at: j.at })),
      }));
  });
  prisma.checkIn.findMany.mockImplementation(async ({ where }: { where: Where }) =>
    where.reviewed_by_coach !== false
      ? [] // today's count
      : checkIns
          .filter((r) => where.user_id.in.includes(r.user_id) && r.coach_id === where.coach_id)
          .filter((r) => !r.reviewed && r.logged_at >= where.logged_at.gte)
          .map((r) => ({ id: r.id, user_id: r.user_id, user: { name: `Name ${r.user_id}` } })),
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
  return { prisma, of: (type: string) => items.filter((i) => i.type === type) };
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
    const joinedByCode: Client = { ...linked('a3', 'A'), joins: [{ coach_id: 'A', at: ago(2) }] };
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
    const moved: Client = { id: 'm1', coach_id: 'B', done: ago(3), joins: [{ coach_id: 'B', at: ago(1) }] };
    const rows = [checkIn('m1', 'A', false)];
    const former = await brief('A', [moved, linked('a1', 'A')], rows);
    expect([...former.of('client_joined'), ...former.of('checkin_review')]).toEqual([]);
    const current = await brief('B', [moved], rows);
    expect(current.of('client_joined').map((r) => r.client_id)).toEqual(['m1']);
    expect(current.of('checkin_review')).toEqual([]);
  });
});
