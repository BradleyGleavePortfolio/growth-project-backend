// B-674-1 (= B-641-12) on real Postgres: two DIFFERENT refunds reversing one
// slice or one head-coach transfer at once both count. A third transaction
// holds the row lock until BOTH writers wait on it (pg_stat_activity); at
// 9a512028 the second absolute write overwrote the first. mwb-3-live-tests.
// B-674-12 (B-CM3-117): one database-elected chargeback first close; B-CM4-118:
// one database-elected refund first success (posted_at).
import 'reflect-metadata';
import { PrismaService } from '../src/prisma.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

liveDescribe('B-674-1 live: concurrent reversals of different refunds both count', () => {
  let prisma: PrismaService;
  let svc: RefundDisputeHandlerService;
  const reverseTransfer = jest.fn(async (a: { amount: number; idempotencyKey: string }) => ({
    id: `trr_${a.idempotencyKey.replace(/[^A-Za-z0-9]/g, '')}`,
    amount: a.amount,
  }));

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    await prisma.user.createMany({
      data: ['coach', 'head', 'client'].map((id) => ({
        id,
        supabase_id: id,
        email: `${id}@example.test`,
        name: id,
      })),
    });
    await prisma.coachPackage.create({
      data: { id: 'pkg', coach_id: 'coach', name: 'Coaching', amount_cents: 10_000 },
    });
    const ledger = new SplitLedgerService(prisma);
    const stripe = { reverseTransfer };
    const transfers = Reflect.construct(TransferOrchestratorService, [prisma, stripe, ledger]);
    const notifications = { createNotification: jest.fn(async () => undefined) };
    const payouts = { recordPayoutEvent: jest.fn() };
    svc = Reflect.construct(RefundDisputeHandlerService, [
      prisma,
      stripe,
      ledger,
      transfers,
      payouts,
      notifications,
    ]);
  }, 180_000);
  afterAll(async () => prisma?.$disconnect());

  // 10,000-cent sale: destination 9,000, fee 1,000, head-coach transfer 500.
  async function seedPurchase(id: string) {
    const purchase = await prisma.clientPurchase.create({
      data: {
        id,
        client_user_id: 'client',
        coach_user_id: 'coach',
        package_id: 'pkg',
        amount_cents: 10_000,
        status: 'paid',
        stripe_checkout_session_id: `cs_${id}`,
        idempotency_key: `idem_${id}`,
      },
    });
    const slices = [
      ['destination', 9_000, 'coach'],
      ['application_fee', 1_000, null],
      ['head_coach_split', 500, 'head'],
    ] as const;
    await prisma.splitLedgerEntry.createMany({
      data: slices.map(([kind, amount_cents, payee_user_id]) => ({
        id: `${id}-${kind}`,
        purchase_id: id,
        kind,
        payee_user_id,
        amount_cents,
        status: 'posted',
        stripe_charge_id: `ch_${id}`,
      })),
    });
    await prisma.connectTransfer.create({
      data: {
        id: `${id}-tr`,
        purchase_id: id,
        destination_stripe_account_id: 'acct_head',
        amount_cents: 500,
        status: 'succeeded',
        stripe_transfer_id: `tr_${id}`,
        idempotency_key: `tr-${id}`,
        ledger_entry_id: `${id}-head_coach_split`,
      },
    });
    const refund = (suffix: string, cents: number) =>
      svc.upsertAndApplyRefund({
        purchase,
        stripe_refund_id: `re_${id}_${suffix}`,
        stripe_charge_id: `ch_${id}`,
        amount_cents: cents,
        status: 'succeeded',
        reason: null,
      });
    return { purchase, refund };
  }

  // Resolves once `count` statements on `table` wait on a lock.
  async function lockWaiters(table: string, count: number) {
    for (const deadline = Date.now() + 20_000; ;) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE ${`%"${table}"%`}`;
      if (n >= count) return;
      if (Date.now() > deadline) throw new Error(`writers never blocked on ${table}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // Runs `writers` while a third transaction holds FOR UPDATE on `ids`, and
  // releases it only once both writers wait on that lock.
  async function raceBehindLock(table: string, ids: string[], writers: () => Promise<unknown>[]) {
    let release!: () => void;
    let held!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const isHeld = new Promise<void>((r) => (held = r));
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = ANY($1) FOR UPDATE`, ids);
        held();
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await isHeld;
    const running = writers();
    await lockWaiters(table, 2);
    release();
    await blocker;
    await Promise.all(running);
  }

  it('ledger slices: refunds of 2,000 and 1,000 behind held slice locks reverse 200 + 100 and 1,800 + 900', async () => {
    const { purchase, refund } = await seedPurchase('pl');
    await raceBehindLock('SplitLedgerEntry', ['pl-application_fee', 'pl-destination'], () => [
      refund('a', 2_000),
      refund('b', 1_000),
    ]);
    const slices = await prisma.splitLedgerEntry.findMany({
      where: { purchase_id: purchase.id },
      orderBy: { kind: 'asc' },
    });
    const transfer = await prisma.connectTransfer.findUniqueOrThrow({ where: { id: 'pl-tr' } });
    expect([slices.map((s) => s.reversed_cents), transfer.reversed_amount_cents]).toEqual([
      [300, 2_700, 150],
      150,
    ]);
  }, 90_000);

  it('head-coach transfer: two refunds recording behind a held transfer lock reverse 100 + 50', async () => {
    const { refund } = await seedPurchase('pt');
    reverseTransfer.mockClear();
    await raceBehindLock('ConnectTransfer', ['pt-tr'], () => [
      refund('a', 2_000),
      refund('b', 1_000),
    ]);
    const transfer = await prisma.connectTransfer.findUniqueOrThrow({ where: { id: 'pt-tr' } });
    const slice = await prisma.splitLedgerEntry.findUniqueOrThrow({
      where: { id: 'pt-head_coach_split' },
    });
    const sent = reverseTransfer.mock.calls.map(([a]) => a.amount).sort((x, y) => x - y);
    expect([sent, transfer.reversed_amount_cents, slice.reversed_cents]).toEqual([
      [50, 100],
      150,
      150,
    ]);
  }, 90_000);

  // B-674-12: two charge.dispute.closed deliveries both read closed_at=null,
  // then wait on the row lock (the second starts later, so its clock is
  // later). A trigger logs every closed_at change: exactly one may happen.
  it('chargeback first close: overlapping deliveries elect one closed_at, used by every posting', async () => {
    await seedPurchase('pd');
    await prisma.chargeDispute.create({
      data: {
        id: 'pd-cd',
        purchase_id: 'pd',
        stripe_dispute_id: 'dp_pd',
        stripe_charge_id: 'ch_pd',
        amount_cents: 10_000,
        status: 'needs_response',
      },
    });
    await prisma.$executeRawUnsafe(`CREATE TABLE closed_at_log (closed_at TIMESTAMP(3))`);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION log_closed_at() RETURNS trigger AS $$
      BEGIN INSERT INTO closed_at_log VALUES (NEW.closed_at); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER log_closed_at AFTER UPDATE ON "ChargeDispute"
      FOR EACH ROW WHEN (NEW.closed_at IS DISTINCT FROM OLD.closed_at) EXECUTE FUNCTION log_closed_at()`);
    reverseTransfer.mockClear();
    const closed = (id: string) =>
      svc.handle({
        id,
        type: 'charge.dispute.closed',
        data: { object: { id: 'dp_pd', status: 'lost' } },
      });
    await raceBehindLock('ChargeDispute', ['pd-cd'], () => [
      closed('evt_a'),
      lockWaiters('ChargeDispute', 1).then(() => closed('evt_b')),
    ]);
    const log = await prisma.$queryRawUnsafe<Array<{ closed_at: Date }>>(
      `SELECT closed_at FROM closed_at_log`,
    );
    const row = await prisma.chargeDispute.findUniqueOrThrow({ where: { id: 'pd-cd' } });
    const postings = await prisma.splitLedgerReversal.findMany({ where: { source_id: 'pd-cd' } });
    const transfer = await prisma.connectTransfer.findUniqueOrThrow({ where: { id: 'pd-tr' } });
    expect(log.map((r) => r.closed_at)).toEqual([row.closed_at]);
    expect(row).toMatchObject({ status: 'lost', ledger_reversed: true });
    expect(postings.map((p) => p.cents).sort((x, y) => x - y)).toEqual([500, 1_000, 9_000]);
    expect(new Set(postings.map((p) => p.posted_at.getTime()))).toEqual(
      new Set([row.closed_at?.getTime()]),
    );
    expect(transfer.reversed_amount_cents).toBe(500);
  }, 90_000);

  // B-674-12 (B-CM4-118): the same for a refund stored pending whose success
  // arrives twice at once: one posted_at change, used by every posting.
  it('refund first success: overlapping deliveries elect one posted_at, used by every posting', async () => {
    const { purchase } = await seedPurchase('pr');
    const refund = (status: string) =>
      svc.upsertAndApplyRefund({
        ...{ purchase, stripe_refund_id: 're_pr', stripe_charge_id: 'ch_pr' },
        ...{ amount_cents: 1_000, status, reason: null },
      });
    const { row: pending } = await refund('pending');
    await prisma.$executeRawUnsafe(`CREATE TABLE posted_at_log (posted_at TIMESTAMP(3))`);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION log_posted_at() RETURNS trigger AS $$
      BEGIN INSERT INTO posted_at_log VALUES (NEW.posted_at); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER log_posted_at AFTER UPDATE ON "ChargeRefund"
      FOR EACH ROW WHEN (NEW.posted_at IS DISTINCT FROM OLD.posted_at) EXECUTE FUNCTION log_posted_at()`);
    await raceBehindLock('ChargeRefund', [pending.id], () => [
      refund('succeeded'),
      lockWaiters('ChargeRefund', 1).then(() => refund('succeeded')),
    ]);
    const log = await prisma.$queryRawUnsafe<Array<{ posted_at: Date }>>(
      `SELECT posted_at FROM posted_at_log`,
    );
    const row = await prisma.chargeRefund.findUniqueOrThrow({ where: { id: pending.id } });
    const postings = await prisma.splitLedgerReversal.findMany({ where: { source_id: row.id } });
    expect(log.map((r) => r.posted_at)).toEqual([row.posted_at]);
    expect(row).toMatchObject({ ledger_reversed: true, transfer_reversed: true });
    expect(postings.map((p) => p.cents).sort((x, y) => x - y)).toEqual([50, 100, 900]);
    expect(new Set(postings.map((p) => p.posted_at.getTime()))).toEqual(
      new Set([row.posted_at?.getTime()]),
    );
  }, 90_000);
});
