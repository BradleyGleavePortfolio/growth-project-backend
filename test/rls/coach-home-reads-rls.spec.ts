/**
 * READTESTS (decision 141-5): the row layer under the coach Home and client
 * lookup reads, on the replayed migration chain. A direct table read as the
 * API role `authenticated`, with app.current_user_id naming one coach, returns
 * none of another coach's rows, none of the head coach's rows to their
 * sub-coach, and, after a client moves, none of that client's coach-side rows
 * to the former coach. The row's own coach reads it first (the control), so a
 * zero means a policy refused the row, not that it is missing. coach_ltv_peak
 * is server-only (20261224000000 revokes the API roles), so every API caller,
 * its own coach too, is refused.
 * The service paths of the same routes: test/coach-home-cross-coach-reads.spec.ts.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-home-reads-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('READTESTS row layer: another coach, a sub-coach or a former coach reads nothing', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run: coaches A and B, A's sub-coach, A's client and B's client.
  const [a, b, sub, clientA, clientB] = Array.from({ length: 5 }, () => randomUUID());
  const mine: Record<string, { a: string; b: string }> = {};

  /** Rows with this id that `authenticated`, acting as `who`, sees; 'refused' when the role may not read the table. */
  async function seen(table: string, rowId: string, who: string): Promise<number | 'refused'> {
    try {
      return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'coach', true)`);
        const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`,
          rowId,
        );
        return n;
      });
    } catch (err) {
      if (/42501|permission denied/.test(String(err))) return 'refused';
      throw err;
    }
  }

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [a, 'coach', null], [b, 'coach', null], [sub, 'coach', a], [clientA, 'student', a], [clientB, 'student', b],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: a, sub_coach_id: sub } });
    const pair = async (table: string, make: (coach: string, client: string) => PromiseLike<{ id: string }>) => {
      mine[table] = { a: (await make(a, clientA)).id, b: (await make(b, clientB)).id };
    };
    await pair('ConnectAccount', (coach) =>
      prisma.connectAccount.create({ data: { coach_user_id: coach, stripe_account_id: `acct_${randomUUID()}` } }));
    await pair('PayoutSnapshot', (coach) =>
      prisma.payoutSnapshot.create({ data: { coach_user_id: coach, stripe_account_id: `acct_${randomUUID()}` } }));
    await pair('CoachPackage', (coach) =>
      prisma.coachPackage.create({ data: { coach_id: coach, name: 'RLS plan', amount_cents: 10000 } }));
    await pair('ClientPurchase', (coach, client) =>
      prisma.clientPurchase.create({
        data: {
          client_user_id: client, coach_user_id: coach, amount_cents: 10000,
          package_id: coach === a ? mine.CoachPackage.a : mine.CoachPackage.b,
          stripe_checkout_session_id: `cs_${randomUUID()}`, idempotency_key: randomUUID(),
        },
      }));
    await pair('CoachAIBudget', (coach) =>
      prisma.coachAIBudget.create({ data: { coach_user_id: coach, period_start: new Date(), period_end: new Date(Date.now() + 864e5) } }));
    await pair('coach_ltv_peak', (coach) => prisma.coachLtvPeak.create({ data: { coach_id: coach } }));
    await pair('ClientSignal', (_coach, client) =>
      prisma.clientSignal.create({ data: { user_id: client, signal_type: 'checkin_streak', value: 5 } }));
    await pair('MacroTarget', (coach, client) =>
      prisma.macroTarget.create({
        data: { client_id: client, coach_id: coach, calories_kcal: 2200, protein_g: 150, carbs_g: 220, fats_g: 70 },
      }));
  });
  afterAll(() => prisma.$disconnect());

  it.each(['ConnectAccount', 'PayoutSnapshot', 'CoachPackage', 'ClientPurchase', 'CoachAIBudget'])(
    '%s: coach A reads their own row; coach B and A\'s sub-coach read none of it, and A reads none of B\'s',
    async (table) => {
      expect(await seen(table, mine[table].a, a)).toBe(1);
      expect(await seen(table, mine[table].a, b)).toBe(0);
      expect(await seen(table, mine[table].a, sub)).toBe(0);
      expect(await seen(table, mine[table].b, a)).toBe(0);
    },
  );

  it('coach_ltv_peak: every API caller is refused, the row\'s own coach too', async () => {
    for (const who of [a, b, sub]) expect(await seen('coach_ltv_peak', mine.coach_ltv_peak.a, who)).toBe('refused');
  });

  it.each(['ClientSignal', 'MacroTarget'])(
    '%s: the client\'s coach reads the row; another coach and the sub-coach read none of it',
    async (table) => {
      expect(await seen(table, mine[table].a, a)).toBe(1);
      expect(await seen(table, mine[table].a, b)).toBe(0);
      expect(await seen(table, mine[table].a, sub)).toBe(0);
    },
  );

  describe('after coach A\'s client moves to coach B', () => {
    beforeAll(() => prisma.user.update({ where: { id: clientA }, data: { coach_id: b } }));

    it.each(['ClientSignal', 'MacroTarget'])('%s: the former coach reads none of the client\'s rows', async (table) => {
      expect(await seen(table, mine[table].a, a)).toBe(0);
    });

    it('ClientSignal: the new coach reads the client\'s signals', async () => {
      expect(await seen('ClientSignal', mine.ClientSignal.a, b)).toBe(1);
    });
  });
});
