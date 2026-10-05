// AUD-OPUS-661E-120 lens probe (never merge). Branch from #702 @ b96611de. Real PostgreSQL (lane-only global setup
// points MWB3_TEST_DATABASE_URL at a throwaway database). Probes scripts/clear-spent-payment-credentials.ts (C-661-2)
// beyond the builder's matrix:
//   B1 the write re-checks the predicate: a row that turned payable between the batch read and the write keeps its
//      credentials (the comment's claim "a row that changed since the read is left to the webhook").
//   B2 batches: an exact multiple of the batch size terminates; batchSize 0 clamps to 1; >5,000 clamps.
//   B3 predicate edges: key-only payable attempt kept; granted-then-unpaid plan cleared; unbound recurring row with a
//      secret is treated as payable (kept, conservative); a non-credential column is never written except updated_at.
//   B4 the documented operator command (`npx ts-node scripts/clear-spent-payment-credentials.ts [--apply]`) starts,
//      connects, prints counts only (no credential), and --apply erases.
import { execFileSync } from 'child_process';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { clearSpentPaymentCredentials } from '../scripts/clear-spent-payment-credentials';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const [CL, CO, PKG] = ['ao661e-client', 'ao661e-coach', 'ao661e-pkg'];
const EK = 'ek_test_ao661e_canary';
type Over = Partial<Prisma.ClientPurchaseUncheckedCreateInput>;

it('AUD-OPUS-661E-120 B0 the live gate is ON in this lane (no silent skip)', () => {
  expect(DB_URL).toMatch(/^postgresql:\/\//);
});

describe('AUD-OPUS-661E-120 backfill on real PostgreSQL', () => {
  let prisma: PrismaService;
  const seed = (id: string, o: Over = {}) =>
    prisma.clientPurchase.create({
      data: {
        id, client_user_id: CL, coach_user_id: CO, package_id: PKG, amount_cents: 4900, billing_type: 'recurring',
        idempotency_key: id, stripe_checkout_session_id: `sub_${id}`, stripe_subscription_id: `sub_${id}`,
        stripe_customer_id: 'cus_ao', stripe_client_secret: `pi_${id}_secret_canary`, stripe_ephemeral_key: EK,
        status: 'active', entitlement_active: true, ...o,
      },
    });
  const oneTime = (status: string, entitled = false): Over => ({
    billing_type: 'one_time', stripe_subscription_id: null, status, entitlement_active: entitled,
  });
  const creds = async (id: string) => {
    const r = await prisma.clientPurchase.findUniqueOrThrow({ where: { id } });
    return [r.stripe_client_secret, r.stripe_ephemeral_key];
  };

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    for (const id of [CL, CO]) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: id } });
    }
    await prisma.coachPackage.create({ data: { id: PKG, coach_id: CO, name: 'AO plan', amount_cents: 4900, billing_type: 'recurring' } });
  }, 180_000);
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE "ClientPurchase" CASCADE`;
  });
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('B1 a row that turned payable between the batch read and the write keeps its credentials', async () => {
    for (const id of ['b1-a', 'b1-b', 'b1-c']) await seed(id);
    await seed('b1-flip', oneTime('paid', true));
    let flipped = false;
    const racing = {
      clientPurchase: {
        count: (a: Prisma.ClientPurchaseCountArgs) => prisma.clientPurchase.count(a),
        findMany: async (a: Prisma.ClientPurchaseFindManyArgs) => {
          const rows = await prisma.clientPurchase.findMany(a);
          if (!flipped && rows.some((r) => r.id === 'b1-flip')) {
            flipped = true;
            // A webhook moves it to a payable attempt (one-time payment_failed) after the read.
            await prisma.clientPurchase.update({ where: { id: 'b1-flip' }, data: { status: 'payment_failed', entitlement_active: false } });
          }
          return rows;
        },
        updateMany: (a: Prisma.ClientPurchaseUpdateManyArgs) => prisma.clientPurchase.updateMany(a),
      },
    } as unknown as Parameters<typeof clearSpentPaymentCredentials>[0];
    const res = await clearSpentPaymentCredentials(racing, { apply: true });
    expect(flipped).toBe(true);
    expect(res).toEqual({ matched: 4, cleared: 3, applied: true });
    expect(await creds('b1-flip')).toEqual(['pi_b1-flip_secret_canary', EK]);
    for (const id of ['b1-a', 'b1-b', 'b1-c']) expect(await creds(id)).toEqual([null, null]);
  });

  it('B2 batches: an exact multiple terminates; batchSize 0 clamps to 1; 10,000 clamps to 5,000', async () => {
    for (let i = 0; i < 8; i += 1) await seed(`b2-${i}`);
    const takes: Array<number | undefined> = [];
    const counting = {
      clientPurchase: {
        count: (a: Prisma.ClientPurchaseCountArgs) => prisma.clientPurchase.count(a),
        findMany: (a: Prisma.ClientPurchaseFindManyArgs) => {
          takes.push(a.take);
          return prisma.clientPurchase.findMany(a);
        },
        updateMany: (a: Prisma.ClientPurchaseUpdateManyArgs) => prisma.clientPurchase.updateMany(a),
      },
    } as unknown as Parameters<typeof clearSpentPaymentCredentials>[0];
    expect(await clearSpentPaymentCredentials(counting, { apply: true, batchSize: 4 })).toEqual({ matched: 8, cleared: 8, applied: true });
    expect(takes).toEqual([4, 4, 4]); // 4, 4, then an empty read
    takes.length = 0;
    for (let i = 0; i < 3; i += 1) await prisma.clientPurchase.update({ where: { id: `b2-${i}` }, data: { stripe_client_secret: `pi_b2_${i}_secret_x` } });
    expect(await clearSpentPaymentCredentials(counting, { apply: true, batchSize: 0 })).toEqual({ matched: 3, cleared: 3, applied: true });
    expect(takes).toEqual([1, 1, 1, 1]);
    takes.length = 0;
    await prisma.clientPurchase.update({ where: { id: 'b2-7' }, data: { stripe_ephemeral_key: 'ek_again' } });
    expect(await clearSpentPaymentCredentials(counting, { apply: true, batchSize: 10_000 })).toEqual({ matched: 1, cleared: 1, applied: true });
    expect(takes).toEqual([5_000]);
    for (let i = 0; i < 8; i += 1) expect(await creds(`b2-${i}`)).toEqual([null, null]);
  });

  it('B3 predicate edges', async () => {
    const started = new Date(Date.now() - 86_400_000);
    // kept: a payable native attempt holding only the ephemeral key
    await seed('b3-open-key-only', { status: 'incomplete', entitlement_active: false, stripe_client_secret: null });
    // kept: an unbound recurring row with a secret (no subscription id) is treated like a one-time attempt
    await seed('b3-unbound', { stripe_subscription_id: null, status: 'pending', entitlement_active: false });
    // cleared: a granted plan that is now unpaid (not entitled, not open)
    await seed('b3-unpaid', { status: 'unpaid', entitlement_active: false });
    // cleared: a started trial that a dispute revoked
    await seed('b3-trial-disputed', { status: 'disputed', entitlement_active: false, trial_days: 7, trial_started_at: started });
    // cleared: an expired unpaid attempt
    await seed('b3-expired', { status: 'expired', entitlement_active: false });
    const before = new Map((await prisma.clientPurchase.findMany()).map((r) => [r.id, r]));
    expect(await clearSpentPaymentCredentials(prisma, { apply: false })).toEqual({ matched: 3, cleared: 0, applied: false });
    expect(await clearSpentPaymentCredentials(prisma, { apply: true })).toEqual({ matched: 3, cleared: 3, applied: true });
    expect(await creds('b3-open-key-only')).toEqual([null, EK]);
    expect(await creds('b3-unbound')).toEqual(['pi_b3-unbound_secret_canary', EK]);
    for (const id of ['b3-unpaid', 'b3-trial-disputed', 'b3-expired']) expect(await creds(id)).toEqual([null, null]);
    for (const r of await prisma.clientPurchase.findMany()) {
      const old = before.get(r.id)!;
      const strip = (x: Record<string, unknown>) => {
        const { stripe_client_secret: _s, stripe_ephemeral_key: _k, updated_at: _u, ...rest } = x;
        return rest;
      };
      expect(strip(r)).toEqual(strip(old));
    }
  });

  it('B4 the operator command: dry run prints counts only, --apply erases', async () => {
    await seed('b4-paid');
    await seed('b4-open', { status: 'incomplete', entitlement_active: false });
    const env = { ...process.env, DATABASE_URL: DB_URL, DIRECT_URL: DB_URL };
    const run = (args: string[]) =>
      execFileSync('npx', ['ts-node', 'scripts/clear-spent-payment-credentials.ts', ...args], {
        cwd: process.cwd(), env, encoding: 'utf8', timeout: 240_000,
      });
    const dry = run([]);
    expect(dry).toContain('[clear-spent-payment-credentials] {"matched":1,"cleared":0,"applied":false}');
    expect(dry).not.toMatch(/_secret_|ek_test/);
    expect(await creds('b4-paid')).toEqual(['pi_b4-paid_secret_canary', EK]);
    const applied = run(['--apply']);
    expect(applied).toContain('[clear-spent-payment-credentials] {"matched":1,"cleared":1,"applied":true}');
    expect(applied).not.toMatch(/_secret_|ek_test/);
    expect(await creds('b4-paid')).toEqual([null, null]);
    expect(await creds('b4-open')).toEqual(['pi_b4-open_secret_canary', EK]);
  }, 600_000);
});
