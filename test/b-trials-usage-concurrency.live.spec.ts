/**
 * B-T12-116 (trials T1 fix round 6) — the one-trial ledger on real Postgres,
 * with every caller in its own transaction (B-671-1, C-671-2).
 *
 * Deterministic interleaving: transaction A runs its TrialUsageService call
 * and then holds its transaction open; transaction B starts the competing
 * call, and the test waits until B is blocked on A (pg_stat_activity
 * wait_event_type = 'Lock': B's unique insert, or B's compare-and-set
 * update, waits for A's uncommitted row). Then A commits, and B resumes with
 * a fresh READ COMMITTED snapshot, exactly the path a webhook replica takes
 * when two events for one subscription arrive together.
 *   - B-671-1: two starts of the same unreserved purchase both read 'owned'
 *     (the audited head a6a2b589 answered 'conflict' to the second one).
 *   - B-671-1 takeover: two starts of one purchase over a released row both
 *     read 'owned'.
 *   - Controls: a different purchase is still a conflict; two reservations
 *     for one client and coach leave exactly one reserved row and refuse the
 *     second with TRIAL_IN_PROGRESS (C-671-2).
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped with
 * a logged reason elsewhere. Builds a Prisma-faithful schema with the shared
 * bootstrap helper on a throwaway database.
 */
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import {
  type MarkTrialStartedArgs,
  type ReserveTrialArgs,
  TrialUsageService,
} from '../src/packages/trials/trial-usage.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[b-trials-usage-concurrency.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.',
  );
}

const COACH = 'b671-live-coach';
const CLIENTS = ['b671-live-c1', 'b671-live-c2', 'b671-live-c3', 'b671-live-c4'];
const END = new Date('2026-10-12T17:00:00Z');

function withPool(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url.includes('connection_limit=') ? url : `${url}${sep}connection_limit=8`;
}

liveDescribe('B-671-1 live: one trial per client per coach across transactions (Postgres)', () => {
  let prisma: PrismaService;
  let svc: TrialUsageService;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    svc = new TrialUsageService(prisma);
    for (const id of [COACH, ...CLIENTS]) {
      await prisma.user.create({
        data: { id, supabase_id: `sb-${id}`, email: `${id}@example.test`, name: 'Live' },
      });
    }
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

  /**
   * Run `first` in transaction A and hold A open; start `second` in
   * transaction B once A's write is done; wait until B blocks on A; commit A;
   * return both results (B's error, if any, as a value).
   */
  async function interleave<T>(
    first: (tx: Prisma.TransactionClient) => Promise<T>,
    second: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<[T, T | Error]> {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const a = prisma.$transaction(
      async (tx) => {
        const out = await first(tx);
        wrote();
        await released;
        return out;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await written;
    const b = prisma
      .$transaction((tx) => second(tx), { timeout: 60_000, maxWait: 10_000 })
      .catch((err: unknown) => (err instanceof Error ? err : new Error('non-error rejection')));
    const deadline = Date.now() + 20_000;
    while ((await lockWaiters()) < 1) {
      if (Date.now() > deadline) throw new Error('transaction B never blocked on transaction A');
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    const outA = await a;
    const outB = await b;
    return [outA, outB];
  }

  const startArgs = (client: string, purchaseId: string): MarkTrialStartedArgs => ({
    clientUserId: client,
    coachUserId: COACH,
    packageId: 'pkg-live',
    purchaseId,
    trialDays: 7,
    trialEndsAt: END,
  });
  const reserveArgs = (client: string, purchaseId: string): ReserveTrialArgs => ({
    clientUserId: client,
    coachUserId: COACH,
    packageId: 'pkg-live',
    purchaseId,
    trialDays: 7,
  });

  it('B-671-1: two starts of one unreserved purchase in separate transactions both own the trial', async () => {
    const args = startArgs(CLIENTS[0], 'b671-live-pur-1');
    const [a, b] = await interleave(
      (tx) => svc.markStarted(tx, args),
      (tx) => svc.markStarted(tx, args),
    );
    expect([a, b]).toEqual(['owned', 'owned']);
    const rows = await prisma.packageTrialUsage.findMany({
      where: { client_user_id: CLIENTS[0], coach_user_id: COACH },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purchase_id: 'b671-live-pur-1', status: 'started' });
  }, 60_000);

  it('B-671-1 takeover: two starts of one purchase over a released row both own the trial', async () => {
    await prisma.packageTrialUsage.create({
      data: {
        client_user_id: CLIENTS[1],
        coach_user_id: COACH,
        package_id: 'pkg-old',
        purchase_id: 'b671-live-pur-old',
        trial_days: 7,
        status: 'released',
        released_at: new Date(),
        release_reason: 'abandoned',
      },
    });
    const args = startArgs(CLIENTS[1], 'b671-live-pur-2');
    const [a, b] = await interleave(
      (tx) => svc.markStarted(tx, args),
      (tx) => svc.markStarted(tx, args),
    );
    expect([a, b]).toEqual(['owned', 'owned']);
    const rows = await prisma.packageTrialUsage.findMany({
      where: { client_user_id: CLIENTS[1], coach_user_id: COACH },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purchase_id: 'b671-live-pur-2', status: 'started' });
  }, 60_000);

  it('control: a different purchase starting in the same race is a conflict', async () => {
    const [a, b] = await interleave(
      (tx) => svc.markStarted(tx, startArgs(CLIENTS[2], 'b671-live-pur-3a')),
      (tx) => svc.markStarted(tx, startArgs(CLIENTS[2], 'b671-live-pur-3b')),
    );
    expect([a, b]).toEqual(['owned', 'conflict']);
    const rows = await prisma.packageTrialUsage.findMany({
      where: { client_user_id: CLIENTS[2], coach_user_id: COACH },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purchase_id: 'b671-live-pur-3a', status: 'started' });
  }, 60_000);

  it('C-671-2: two reservations for one client and coach leave exactly one reserved row', async () => {
    const [a, b] = await interleave(
      (tx) => svc.reserve(tx, reserveArgs(CLIENTS[3], 'b671-live-pur-4a')),
      (tx) => svc.reserve(tx, reserveArgs(CLIENTS[3], 'b671-live-pur-4b')),
    );
    expect(a).toEqual({ trial_days: 7 });
    expect(b).toBeInstanceOf(ConflictException);
    expect(((b as ConflictException).getResponse() as { code: string }).code).toBe(
      'TRIAL_IN_PROGRESS',
    );
    const rows = await prisma.packageTrialUsage.findMany({
      where: { client_user_id: CLIENTS[3], coach_user_id: COACH },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purchase_id: 'b671-live-pur-4a', status: 'reserved' });
  }, 60_000);
});
