/**
 * MOVEBILL (owner MOVE-BILLING / MOVE-LTV option 1) on the replayed migration
 * chain (20270424000000): a move stamps ClientPurchase.moved_away_at, in the
 * move's own transaction, on the moving client's plans sold by a coach in
 * their old chain who is not in the new one (app.client_coach_chain; owner
 * TM-M1 note: the coach, the head coach of a seated sub-coach, a delegated
 * sub-coach). Head coach H has seated sub-coach S; A, B and Z are independent
 * coaches; Z only ever sold c1 a storefront plan.
 *
 *   c1: A -> B        A's plan stamped, Z's storefront plan never
 *   c2: H -> S        H's plan kept (H still owns the client; MOVE-TEAM)
 *   c3: S -> H        S's plan stamped, H's kept
 *   c4: S -> B        leaves the team: S's and H's plans stamped
 *   c1: B -> A        B's plan stamped, A's keeps its first move date
 *   other, buyer      no move / a coach buyer: nothing stamped
 *   delegations       start keeps every plan; change, end or delete stamps
 *                     the sub-coach left; the chain left at commit decides
 *   callers           every service that moves a client, run for real
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { SubCoachReassignService } from '../../src/sub-coach/sub-coach-reassign.service';
import { SubCoachInviteService } from '../../src/sub-coaches/sub-coach-invite.service';
import { SubCoachesService } from '../../src/sub-coaches/sub-coaches.service';
import { TeamModeService } from '../../src/team-mode/team-mode.service';

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

  const addUser = (user: string, role: 'coach' | 'student', coach: string | null) =>
    prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
      VALUES (${user}, ${user}, ${`mvb-${user}`}, 'MOVEBILL user', ${role}::"Role", ${coach})`;
  const seat = (head: string, sub: string) =>
    prisma.$executeRaw`INSERT INTO "TeamSubCoachAssignment" ("id", "head_coach_id", "sub_coach_id")
      VALUES (${randomUUID()}, ${head}, ${sub})`;
  const addPlan = async (t: string, seller: string, client: string) => {
    await prisma.$executeRaw`INSERT INTO "CoachPackage" ("id", "coach_id", "name", "amount_cents", "updated_at")
      VALUES (${id(`pkg-${t}`)}, ${seller}, 'Monthly coaching', 15000, now())`;
    await prisma.$executeRaw`INSERT INTO "ClientPurchase"
        ("id", "client_user_id", "coach_user_id", "package_id", "amount_cents", "billing_type", "status",
         "entitlement_active", "stripe_checkout_session_id", "idempotency_key", "updated_at")
      VALUES (${id(t)}, ${client}, ${seller}, ${id(`pkg-${t}`)}, 15000, 'recurring', 'active',
         true, ${id(`cs-${t}`)}, ${id(`idem-${t}`)}, now())`;
  };
  /** Sellers whose plan for this client is stamped. */
  const left = async (client: string) =>
    (
      await prisma.$queryRaw<{ coach_user_id: string }[]>`SELECT "coach_user_id" FROM "ClientPurchase"
        WHERE "client_user_id" = ${client} AND "moved_away_at" IS NOT NULL`
    ).map((r) => r.coach_user_id).sort();
  /** Head h with seated sub-coaches s1, s2 (coach_id h); client k of `owner`, with a plan from each. */
  const team = async (owner: 'h' | 's1') => {
    const [h, s1, s2, k] = Array.from({ length: 4 }, () => randomUUID());
    await addUser(h, 'coach', null);
    for (const s of [s1, s2]) {
      await addUser(s, 'coach', h);
      await seat(h, s);
    }
    await addUser(k, 'student', owner === 'h' ? h : s1);
    for (const c of [h, s1, s2]) await addPlan(`p-${c}`, c, k);
    return { h, s1, s2, k };
  };
  const delegate = (h: string, s: string, k: string) =>
    prisma.$executeRaw`INSERT INTO "SubCoachAssignment" ("id", "head_coach_id", "sub_coach_id", "client_id")
      VALUES (${randomUUID()}, ${h}, ${s}, ${k})`;
  const undelegate = (s: string, k: string) =>
    prisma.$executeRaw`UPDATE "SubCoachAssignment" SET "unassigned_at" = now()
      WHERE "client_id" = ${k} AND "sub_coach_id" = ${s} AND "unassigned_at" IS NULL`;
  /** A typed stand-in for a constructor dependency (T comes from the parameter). */
  const fake = <T extends object>(impl: object): T => impl as T;
  const noTeam = { refreshCounters: async () => undefined };

  beforeAll(async () => {
    for (const user of [...coaches, ...clients]) {
      await addUser(user, clients.includes(user) ? 'student' : 'coach', coachOf[user] ?? null);
    }
    await seat(H, S);
    for (const [t, [seller, client]] of Object.entries(plans)) await addPlan(t, seller, client);
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

  it('a client left coachless stamps every plan of the chain they left', async () => {
    await moveTo(other, null);
    expect((await stamps()).pAo).not.toBeNull();
  });

  it('runs as the caller with a pinned search_path; an API party reads only its own rows and cannot clear a stamp', async () => {
    const fns = await prisma.$queryRaw<{ prosecdef: boolean; proconfig: string[] | null }[]>`
      SELECT p."prosecdef", p."proconfig" FROM pg_proc p
       WHERE p."proname" IN ('user_coach_move_marks_plans', 'delegation_end_marks_plans', 'client_coach_chain')`;
    expect(fns).toHaveLength(3);
    for (const fn of fns) {
      expect(fn.prosecdef).toBe(false);
      expect((fn.proconfig ?? []).some((c) => c.startsWith('search_path='))).toBe(true);
    }
    const [grants] = await prisma.$queryRaw<{ sel: boolean; upd: boolean }[]>`
      SELECT has_table_privilege('authenticated', '"ClientPurchase"', 'SELECT') AS sel,
             has_table_privilege('authenticated', '"ClientPurchase"', 'UPDATE') AS upd`;
    // No grant: refused (42501). A grant: the pre-existing client_purchase_select lets each party
    // read only its own purchases (moved_away_at included), and no row rule lets it clear a stamp.
    const denied = 'SQLSTATE 42501';
    const asApi = (who: string, role: string, run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      prisma
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
          await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
          return run(tx);
        })
        .catch((e: { meta?: { code?: string } }) => 'SQLSTATE ' + (e.meta?.code ?? /Code: .(\w{5})/.exec(String(e))?.[1]));
    // The moved client (its 3 plans), the coach they left (its 1 sale), a coach who sold them nothing.
    for (const [who, role, own] of [[c1, 'student', 3], [A, 'coach', 1], [H, 'coach', 0]] as const) {
      const read = await asApi(who, role, async (tx) =>
        (await tx.$queryRaw<unknown[]>`SELECT "moved_away_at" FROM "ClientPurchase" WHERE "client_user_id" = ${c1}`).length);
      expect(read).toBe(grants.sel ? own : denied);
      const cleared = await asApi(who, role, (tx) =>
        tx.$executeRaw`UPDATE "ClientPurchase" SET "moved_away_at" = NULL WHERE "id" = ${id('pA1')}`);
      expect(cleared).toBe(grants.upd ? 0 : denied);
    }
    expect((await stamps()).pA1).not.toBeNull();
  });

  it('delegations: a start keeps every plan; a change, an end or a delete stamps the sub-coach left; the head keeps billing', async () => {
    const { h, s1, s2, k } = await team('h');
    await delegate(h, s1, k); // start: H hands the client to S1 (MOVE-TEAM: H keeps billing)
    expect(await left(k)).toEqual([]);
    await prisma.$transaction([undelegate(s1, k), delegate(h, s2, k)]); // change: S1 -> S2
    expect(await left(k)).toEqual([s1]);
    await undelegate(s2, k); // end: back to H
    expect(await left(k)).toEqual([s1, s2].sort());

    const w = await team('h');
    await delegate(w.h, w.s1, w.k);
    await prisma.$executeRaw`UPDATE "SubCoachAssignment" SET "sub_coach_id" = ${w.s2} WHERE "client_id" = ${w.k}`;
    expect(await left(w.k)).toEqual([w.s1]);
    await prisma.$executeRaw`DELETE FROM "SubCoachAssignment" WHERE "client_id" = ${w.k}`;
    expect(await left(w.k)).toEqual([w.s1, w.s2].sort());
  });

  it('delegations: the chain left at commit decides (closing S1 and making S1 the coach stamps nothing)', async () => {
    const { h, s1, k } = await team('h');
    await delegate(h, s1, k);
    await prisma.$transaction([
      undelegate(s1, k),
      prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${s1} WHERE "id" = ${k}`,
    ]);
    expect(await left(k)).toEqual([]);
  });

  it('callers: a head coach reassigning a seat client H -> S1 keeps every plan; S1 -> H stamps S1', async () => {
    const { h, s1, k } = await team('h');
    const svc = new SubCoachesService(fake(prisma), fake(noTeam));
    await svc.reassignClient(h, s1, { clientId: k });
    expect(await left(k)).toEqual([]);
    await svc.reassignClient(h, h, { clientId: k });
    expect(await left(k)).toEqual([s1]);
  });

  it('callers: a sub-coach revoke and a seat removal send S1 clients to H and stamp S1 only', async () => {
    const removals = [
      (h: string, s: string) => new SubCoachInviteService(fake(prisma), fake(noTeam)).revoke(h, s, {}),
      (h: string, s: string) =>
        new TeamModeService(fake(prisma), fake({}), fake({})).removeSubCoach({ headCoachId: h, subCoachId: s }),
    ];
    for (const remove of removals) {
      const { h, s1, k } = await team('s1');
      await remove(h, s1);
      expect(await left(k)).toEqual([s1]);
    }
  });

  it('callers: delegation assign, reassign and unassign (coach_id stays H) stamp each sub-coach left', async () => {
    const { h, s1, s2, k } = await team('h');
    const svc = new SubCoachReassignService(
      fake(prisma),
      fake({ assertHasCapacityTx: async () => undefined }),
      fake({
        runWithIdempotency: async ({ runMutation }: { runMutation: () => Promise<unknown> }) => ({
          response: await runMutation(),
          replay: false,
        }),
      }),
    );
    const to = (target: string) =>
      svc.reassignClient(h, h, 'coach', { clientId: k, targetSubCoachId: target, idempotency_key: randomUUID() });
    await to(s1);
    expect(await left(k)).toEqual([]);
    await to(s2);
    expect(await left(k)).toEqual([s1]);
    await to(h);
    expect(await left(k)).toEqual([s1, s2].sort());
    expect((await prisma.user.findUnique({ where: { id: k }, select: { coach_id: true } }))?.coach_id).toBe(h);
  });
});
