/**
 * READTESTS (decision 141-5): the row layer under the coach Home and client
 * lookup reads, on the replayed migration chain. A direct table read as the
 * API role `authenticated`, with app.current_user_id naming one coach, returns
 * none of another coach's rows, none of the head coach's rows to their
 * sub-coach, and, after a client moves, none of that client's coach-side rows
 * to the former coach. The row's own coach reads it first (the control), so a
 * zero means a policy refused the row, not that it is missing. The new coach
 * and the client still read the client's history after a move. A removed
 * sub-coach and their former head read none of each other's consultation rows,
 * the API agreeing. coach_ltv_peak (20261224000000) and ConnectAccount,
 * PayoutSnapshot and ClientPurchase (BILLRAW, 20270502003500) are server-only
 * (the API roles are revoked), so every API caller, its own coach too, is
 * refused, after the server reads the row (the control).
 * The service paths of the same routes: test/coach-home-cross-coach-reads.spec.ts.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { OnboardingService } from '../../src/onboarding/onboarding.service';
import type { PrismaService } from '../../src/prisma.service';
import type { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-home-reads-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('READTESTS row layer: another coach, a sub-coach or a former coach reads nothing', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run: coaches A and B, A's sub-coach, A's client and B's client.
  const [a, b, sub, clientA, clientB] = Array.from({ length: 5 }, () => randomUUID());
  const mine: Record<string, { a: string; b: string }> = {};

  /** Runs `fn` in one transaction as the API role `authenticated`, with app.current_user_id = who. */
  const asUser = <T>(who: string, fn: (tx: Prisma.TransactionClient) => Promise<T>, role = 'coach'): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
      return fn(tx);
    });

  /** Rows with this id that `who` sees; 'refused' when the role may not read the table. */
  async function seen(table: string, rowId: string, who: string, role = 'coach'): Promise<number | 'refused'> {
    try {
      const [{ n }] = await asUser(who, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`, rowId), role);
      return n;
    } catch (err) {
      if (/42501|permission denied/.test(String(err))) return 'refused';
      throw err;
    }
  }
  const touchTarget = (who: string) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(`UPDATE public."MacroTarget" SET "notes" = 'rls' WHERE "id" = $1`, mine.MacroTarget.a));
  const newTarget = (who: string) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO public."MacroTarget" ("id", "client_id", "coach_id", "calories_kcal", "protein_g", "carbs_g", "fats_g")
       VALUES ($1, $2, $3, 2000, 140, 200, 60)`,
      randomUUID(), clientA, who));

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

  it.each(['CoachPackage', 'CoachAIBudget'])(
    '%s: coach A reads their own row; coach B and A\'s sub-coach read none of it, and A reads none of B\'s',
    async (table) => {
      expect(await seen(table, mine[table].a, a)).toBe(1);
      expect(await seen(table, mine[table].a, b)).toBe(0);
      expect(await seen(table, mine[table].a, sub)).toBe(0);
      expect(await seen(table, mine[table].b, a)).toBe(0);
    },
  );

  it.each(['coach_ltv_peak', 'ConnectAccount', 'PayoutSnapshot', 'ClientPurchase'])(
    '%s: every API caller is refused, the row\'s own coach too', async (table) => {
      expect(await prisma.$queryRawUnsafe(`SELECT "id" FROM public."${table}" WHERE "id" = $1`, mine[table].a)).toHaveLength(1);
      for (const who of [a, b, sub]) expect(await seen(table, mine[table].a, who)).toBe('refused');
    },
  );

  it.each(['ClientSignal', 'MacroTarget'])(
    '%s: the client\'s coach reads the row; another coach and the sub-coach read none of it',
    async (table) => {
      expect(await seen(table, mine[table].a, a)).toBe(1);
      expect(await seen(table, mine[table].a, b)).toBe(0);
      expect(await seen(table, mine[table].a, sub)).toBe(0);
    },
  );

  it('MacroTarget: the client\'s coach changes the target and writes a new one (control for the write rule)', async () => {
    expect(await touchTarget(a)).toBe(1);
    expect(await newTarget(a)).toBe(1);
  });

  describe('after coach A\'s client moves to coach B', () => {
    beforeAll(() => prisma.user.update({ where: { id: clientA }, data: { coach_id: b } }));

    it.each(['ClientSignal', 'MacroTarget'])('%s: the former coach reads none of the client\'s rows', async (table) => {
      expect(await seen(table, mine[table].a, a)).toBe(0);
    });

    it.each(['ClientSignal', 'MacroTarget'])('%s: the new coach reads the client\'s row from before the move', async (table) => {
      expect(await seen(table, mine[table].a, b)).toBe(1);
    });

    it('MacroTarget: the client still reads the target the former coach wrote', async () => {
      expect(await seen('MacroTarget', mine.MacroTarget.a, clientA, 'student')).toBe(1);
    });

    it('MacroTarget: the former coach can neither change the target nor write a new one; the new coach can write', async () => {
      expect(await touchTarget(a)).toBe(0);
      await expect(newTarget(a)).rejects.toThrow(/row-level security/);
      expect(await newTarget(b)).toBe(1);
    });
  });

  describe('a removed sub-coach (seat archived, the delegation left open): consultation rows', () => {
    // Head H; team member R with a seat; H's client X, delegated to R; R's own client Y.
    const [h, r, x, y] = Array.from({ length: 4 }, () => randomUUID());
    const rows: Record<string, [string, string]> = {};
    const api = new OnboardingService(prisma as PrismaService, {} as WorkoutBuilderService);
    /** The API answer, then the intake and revision rows `reader` sees for `client`. */
    const audience = async (reader: string, client: string) => [
      await api.canCoachRead(reader, client),
      await seen('ClientOnboardingIntake', rows[client][0], reader),
      await seen('ClientOnboardingIntakeRevision', rows[client][1], reader),
    ];
    const [YES, NO] = [[true, 1, 1], [false, 0, 0]];

    beforeAll(async () => {
      for (const [id, role, coach_id] of [[h, 'coach', null], [r, 'coach', h], [x, 'student', h], [y, 'student', r]] as const) {
        await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
      }
      await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: r } });
      await prisma.subCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: r, client_id: x } });
      for (const c of [x, y]) {
        const intake = await prisma.clientOnboardingIntake.create({ data: { client_id: c, version: 'consult-v1', answers: { P1: 'no' } } });
        const rev = await prisma.clientOnboardingIntakeRevision.create({
          data: { intake_id: intake.id, client_id: c, revision: 1, version: 'consult-v1', answers: { P1: 'no' }, cause: 'save' },
        });
        rows[c] = [intake.id, rev.id];
      }
    });

    it('API and both tables agree: removal ends both cross reads; a pair that never had a seat still counts', async () => {
      expect([await audience(r, x), await audience(h, y)]).toEqual([YES, YES]);
      await prisma.teamSubCoachAssignment.updateMany({ where: { head_coach_id: h }, data: { archived_at: new Date() } });
      expect([await audience(r, x), await audience(h, y), await audience(r, y), await audience(h, x)]).toEqual([NO, NO, YES, YES]);
      await prisma.teamSubCoachAssignment.deleteMany({ where: { head_coach_id: h } });
      expect([await audience(r, x), await audience(h, y)]).toEqual([YES, YES]);
    });
  });
});
