/**
 * MOVEBILL (owner MOVE-BILLING / MOVE-LTV option 1) on the replayed migration
 * chain: trg_user_coach_move_marks_plans (20270424000000) stamps
 * ClientPurchase.moved_away_at, in the move's own transaction, on the moving
 * client's plans sold by a coach in their old chain who is not in the new one
 * (owner TM-M1 note: the coach, the head coach of a seated sub-coach, a
 * delegated sub-coach). Head coach H has seated sub-coach S; A, B and Z are
 * independent coaches; Z only ever sold c1 a storefront plan.
 *
 *   c1: A -> B        A's plan stamped, Z's storefront plan never
 *   c2: H -> S        H's plan kept (H still owns the client)
 *   c3: S -> H        S's plan stamped, H's kept
 *   c4: S -> B        leaves the team: S's and H's plans stamped
 *   c1: B -> A        B's plan stamped, A's keeps its first move date
 *   other, buyer      no move / a coach buyer: nothing stamped
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-plan-billing-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('MOVEBILL: a move stamps the plans of the coaches the client left', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const [H, S, A, B, Z, buyer, c1, c2, c3, c4, other] = Array.from({ length: 11 }, () => randomUUID());
  const coaches = [H, A, B, Z, S, buyer];
  const clients = [c1, c2, c3, c4, other];
  const coachOf: Record<string, string> = {
    [S]: H, [buyer]: A, [c1]: A, [c2]: H, [c3]: S, [c4]: S, [other]: A,
  };
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  // plans: [seller, client]
  const plans: Record<string, [string, string]> = {
    pA1: [A, c1], pZ1: [Z, c1], pB1: [B, c1], pH2: [H, c2], pS3: [S, c3], pH3: [H, c3],
    pS4: [S, c4], pH4: [H, c4], pAo: [A, other], pAb: [A, buyer],
  };

  const stamps = async (): Promise<Record<string, Date | null>> => {
    const rows = await prisma.$queryRaw<{ id: string; moved_away_at: Date | null }[]>`
      SELECT "id", "moved_away_at" FROM "ClientPurchase" WHERE "id" LIKE ${`%-${run}`}`;
    return Object.fromEntries(rows.map((r) => [r.id.slice(0, -run.length - 1), r.moved_away_at]));
  };
  const stamped = async () =>
    Object.entries(await stamps()).filter(([, at]) => at != null).map(([t]) => t).sort();
  /** One move in its own transaction; returns its now() at the column's precision. */
  const moveTo = (client: string, coach: string | null) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "User" SET "coach_id" = ${coach} WHERE "id" = ${client}`;
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now()::timestamp(3) AS now`;
      return now;
    });

  beforeAll(async () => {
    for (const user of [...coaches, ...clients]) {
      const role = clients.includes(user) ? 'student' : 'coach';
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${user}, ${user}, ${`mvb-${user}`}, 'MOVEBILL user', ${role}::"Role", ${coachOf[user] ?? null})`;
    }
    await prisma.$executeRaw`INSERT INTO "TeamSubCoachAssignment" ("id", "head_coach_id", "sub_coach_id")
      VALUES (${randomUUID()}, ${H}, ${S})`;
    for (const coach of coaches) {
      await prisma.$executeRaw`INSERT INTO "CoachPackage" ("id", "coach_id", "name", "amount_cents", "updated_at")
        VALUES (${id(`pkg-${coach}`)}, ${coach}, 'Monthly coaching', 15000, now())`;
    }
    for (const [t, [seller, client]] of Object.entries(plans)) {
      await prisma.$executeRaw`INSERT INTO "ClientPurchase"
          ("id", "client_user_id", "coach_user_id", "package_id", "amount_cents", "billing_type", "status",
           "entitlement_active", "stripe_checkout_session_id", "idempotency_key", "updated_at")
        VALUES (${id(t)}, ${client}, ${seller}, ${id(`pkg-${seller}`)}, 15000, 'recurring', 'active',
           true, ${id(`cs-${t}`)}, ${id(`idem-${t}`)}, now())`;
    }
  });
  afterAll(() => prisma.$disconnect());

  it('stamps only the plans of the coaches each client left, at the move transaction time', async () => {
    expect(await stamped()).toEqual([]);
    const at1 = await moveTo(c1, B);
    await moveTo(c2, S);
    await moveTo(c3, H);
    const at4 = await moveTo(c4, B);
    await moveTo(other, A); // same coach: not a move
    await moveTo(buyer, B); // a coach buyer: not a client move
    await prisma.$executeRaw`UPDATE "User" SET "name" = 'Renamed' WHERE "id" = ${c2}`;

    expect(await stamped()).toEqual(['pA1', 'pH4', 'pS3', 'pS4']);
    const s = await stamps();
    expect(s.pA1).toEqual(at1);
    expect(s.pS4).toEqual(at4);
    expect(s.pH4).toEqual(at4);
  });

  it('a later move keeps the first move date and stamps the coach left this time', async () => {
    const before = (await stamps()).pA1;
    const back = await moveTo(c1, A);
    const s = await stamps();
    expect(s.pA1).toEqual(before);
    expect(s.pB1).toEqual(back);
    expect(s.pZ1).toBeNull();
  });

  it('a move that rolls back stamps nothing', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "User" SET "coach_id" = ${B} WHERE "id" = ${other}`;
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await stamps()).pAo).toBeNull();
  });

  it('runs as the caller with a pinned search_path, and an API role cannot clear a stamp', async () => {
    const [fn] = await prisma.$queryRaw<{ prosecdef: boolean; proconfig: string[] | null }[]>`
      SELECT p."prosecdef", p."proconfig" FROM pg_proc p
       WHERE p."proname" = 'user_coach_move_marks_plans'`;
    expect(fn.prosecdef).toBe(false);
    expect((fn.proconfig ?? []).some((c) => c.startsWith('search_path='))).toBe(true);

    const cleared = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, c1);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'student', true)`);
        await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: c1 }));
        return tx.$executeRaw`UPDATE "ClientPurchase" SET "moved_away_at" = NULL WHERE "id" = ${id('pA1')}`;
      })
      .catch(() => 0);
    expect(cleared).toBe(0);
    expect((await stamps()).pA1).not.toBeNull();
  });
});
