/**
 * A607-3 live proof on real Postgres: the onboarding completion tenancy fence
 * (`lockUserRow`, `SELECT ... FROM "User" ... FOR SHARE`) really serialises
 * against a coach transfer.
 *
 *   1. While a completion transaction holds the fence on the client row, the
 *      attach-code transfer's `UPDATE "User" SET coach_id` waits
 *      (pg_stat_activity wait_event_type = 'Lock') until that transaction
 *      ends, so effects written under the verified coach can never be
 *      interleaved with a transfer.
 *   2. A transfer that committed first is seen by the fence read, which is
 *      what makes OnboardingService.complete roll back and re-run against the
 *      current coach (unit-level: test/onboarding.service.spec.ts "A607-3").
 *   3. The statement is valid against the real Prisma schema (table, column
 *      names, enum cast).
 *   4. A-607-4: the in-transaction membership decision
 *      (`lockMembershipHeadCoachIdInTx`) holds the seat / delegation row FOR
 *      SHARE, so main's seat archival and last-delegation close (which never
 *      touch User) wait until the completion ends; one that committed first
 *      is seen as "no head".
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped with a
 * logged reason elsewhere.
 */
import { PrismaService } from '../src/prisma.service';
import { lockUserRow } from '../src/onboarding/onboarding.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[onboarding-tenancy-fence.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.',
  );
}

const COACH_A = 'a607-3-coach-a';
const COACH_B = 'a607-3-coach-b';
const CLIENT = 'a607-3-client';

function withPool(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url.includes('connection_limit=') ? url : `${url}${sep}connection_limit=6`;
}

liveDescribe('A607-3 live: completion tenancy fence vs coach transfer (Postgres)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    for (const id of [COACH_A, COACH_B]) {
      await prisma.user.create({
        data: { id, supabase_id: `sb-${id}`, email: `${id}@example.test`, name: id, role: 'coach' },
      });
    }
    await prisma.user.create({
      data: {
        id: CLIENT,
        supabase_id: `sb-${CLIENT}`,
        email: `${CLIENT}@example.test`,
        name: 'Client',
        role: 'student',
        coach_id: COACH_A,
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function lockWaiters(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return Number(rows[0]?.n ?? 0);
  }

  it('the fence reads the live row (role as text, coach, deleted_at)', async () => {
    const row = await prisma.$transaction((tx) => lockUserRow(tx, CLIENT));
    expect(row).toEqual({ id: CLIENT, coach_id: COACH_A, role: 'student', deleted_at: null });
    expect(await prisma.$transaction((tx) => lockUserRow(tx, 'nobody'))).toBeNull();
  });

  it('a transfer UPDATE waits while a completion holds the fence, and lands only after it ends', async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fenced: (coachId: string | null) => void = () => undefined;
    const seen = new Promise<string | null>((resolve) => {
      fenced = resolve;
    });
    const completion = prisma.$transaction(
      async (tx) => {
        const coachRow = await lockUserRow(tx, COACH_A);
        const clientRow = await lockUserRow(tx, CLIENT);
        expect(coachRow?.role).toBe('coach');
        fenced(clientRow?.coach_id ?? null);
        await released;
        // Still attached to A inside the fence, whatever the transfer does.
        const again = await lockUserRow(tx, CLIENT);
        return again?.coach_id ?? null;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    expect(await seen).toBe(COACH_A);

    let transferDone = false;
    const transfer = prisma.user
      .update({ where: { id: CLIENT }, data: { coach_id: COACH_B } })
      .then(() => {
        transferDone = true;
      });

    const deadline = Date.now() + 20_000;
    while ((await lockWaiters()) < 1) {
      if (Date.now() > deadline) throw new Error('transfer never blocked on the fence');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(transferDone).toBe(false);
    release();
    expect(await completion).toBe(COACH_A);
    await transfer;
    expect(transferDone).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: CLIENT } });
    expect(after.coach_id).toBe(COACH_B);
  }, 60_000);

  it('a transfer that committed first is seen by the fence (completion then rolls back and re-runs)', async () => {
    await prisma.user.update({ where: { id: CLIENT }, data: { coach_id: COACH_A } });
    await prisma.user.update({ where: { id: CLIENT }, data: { coach_id: COACH_B } });
    const row = await prisma.$transaction((tx) => lockUserRow(tx, CLIENT));
    expect(row?.coach_id).toBe(COACH_B);
  });

  // ── A-607-4 ──────────────────────────────────────────────────────────────
  const HEAD = 'a607-4-head';
  const SUB = 'a607-4-sub';
  async function membershipWorld(): Promise<{ seatId: string; delegationId: string }> {
    await prisma.subCoachAssignment.deleteMany({ where: { sub_coach_id: SUB } });
    await prisma.teamSubCoachAssignment.deleteMany({ where: { sub_coach_id: SUB } });
    for (const id of [HEAD, SUB]) {
      await prisma.user.upsert({
        where: { id },
        create: {
          id,
          supabase_id: `sb-${id}`,
          email: `${id}@example.test`,
          name: id,
          role: 'coach',
        },
        update: {},
      });
    }
    await prisma.user.update({ where: { id: SUB }, data: { coach_id: HEAD } });
    const seat = await prisma.teamSubCoachAssignment.create({
      data: { head_coach_id: HEAD, sub_coach_id: SUB },
    });
    const delegation = await prisma.subCoachAssignment.create({
      data: { head_coach_id: HEAD, sub_coach_id: SUB, client_id: CLIENT },
    });
    return { seatId: seat.id, delegationId: delegation.id };
  }

  /** Returns the head decided inside the completion; asserts the retirement waited for it. */
  async function decisionHeldAgainst(retire: () => Promise<unknown>): Promise<string | null> {
    const scope = new SubCoachScopeService(prisma);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let decided: () => void = () => undefined;
    const decidedP = new Promise<void>((resolve) => {
      decided = resolve;
    });
    let retired = false;
    const completion = prisma.$transaction(
      async (tx) => {
        const row = await lockUserRow(tx, SUB);
        const head = await scope.lockMembershipHeadCoachIdInTx(tx, SUB, row);
        decided();
        await released;
        return head;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await decidedP;
    const retirement = retire().then(() => {
      retired = true;
    });
    const deadline = Date.now() + 20_000;
    while ((await lockWaiters()) < 1) {
      if (Date.now() > deadline)
        throw new Error('membership retirement never blocked on the completion');
      await new Promise((r) => setTimeout(r, 50));
    }
    // Blocked on the row the completion holds: not retired while it decides.
    expect(retired).toBe(false);
    release();
    const inside = await completion;
    await retirement;
    expect(retired).toBe(true);
    return inside;
  }

  it('A-607-4: a seat archival (User untouched) waits while the completion holds its decision', async () => {
    const { seatId, delegationId } = await membershipWorld();
    await prisma.subCoachAssignment.update({
      where: { id: delegationId },
      data: { unassigned_at: new Date() },
    });
    const r = await decisionHeldAgainst(() =>
      prisma.teamSubCoachAssignment.update({
        where: { id: seatId },
        data: { archived_at: new Date() },
      }),
    );
    expect(r).toBe(HEAD);
  }, 60_000);

  it('A-607-4: the last delegation close (User untouched) waits while the completion holds its decision', async () => {
    const { seatId, delegationId } = await membershipWorld();
    await prisma.teamSubCoachAssignment.update({
      where: { id: seatId },
      data: { archived_at: new Date() },
    });
    const r = await decisionHeldAgainst(() =>
      prisma.subCoachAssignment.update({
        where: { id: delegationId },
        data: { unassigned_at: new Date() },
      }),
    );
    expect(r).toBe(HEAD);
  }, 60_000);

  it('A-607-4: retirement that committed first is seen in the transaction as no head', async () => {
    const { seatId, delegationId } = await membershipWorld();
    const scope = new SubCoachScopeService(prisma);
    const before = await prisma.$transaction(async (tx) =>
      scope.lockMembershipHeadCoachIdInTx(tx, SUB, await lockUserRow(tx, SUB)),
    );
    expect(before).toBe(HEAD);
    await prisma.teamSubCoachAssignment.update({
      where: { id: seatId },
      data: { archived_at: new Date() },
    });
    await prisma.subCoachAssignment.update({
      where: { id: delegationId },
      data: { unassigned_at: new Date() },
    });
    const after = await prisma.$transaction(async (tx) =>
      scope.lockMembershipHeadCoachIdInTx(tx, SUB, await lockUserRow(tx, SUB)),
    );
    expect(after).toBeNull();
    // The pointer alone is not membership.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: SUB } })).coach_id).toBe(HEAD);
  });
});
