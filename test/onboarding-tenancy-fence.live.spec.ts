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
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped with a
 * logged reason elsewhere.
 */
import { PrismaService } from '../src/prisma.service';
import { lockUserRow } from '../src/onboarding/onboarding.service';
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
});
