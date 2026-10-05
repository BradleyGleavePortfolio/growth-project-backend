// AUD-OPUS-R12D-119 (Claude Opus 5.5 lens) probes at #679 23d2c04c (includes R1 #678 09e159d8).
// Audit branch only; never merged. Real PostgreSQL lock boundary (CI-only cluster) around the actual
// candidate sendFenced; purchase contents and Stripe are stateful doubles. Every case should PASS.
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendFenced } from '../src/checkout/subscription-attempt';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const X = '11111111-1111-4111-8111-111111111111';
const Y = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let bin: string;
let root: string;
let started = false;
let s1: PrismaClient;
let s2: PrismaClient;
let fin: PrismaClient;
let fin2: PrismaClient;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (process.env.CI !== 'true') throw new Error('CI-only isolated PostgreSQL proof');
  const version = readdirSync('/usr/lib/postgresql')
    .sort()
    .reverse()
    .find((v) => existsSync(join('/usr/lib/postgresql', v, 'bin/initdb')));
  if (!version) throw new Error('Runner has no PostgreSQL binaries');
  bin = join('/usr/lib/postgresql', version, 'bin');
  root = mkdtempSync(join(tmpdir(), 'opus-r12d-119-pg-'));
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync'], {
    stdio: 'pipe',
  });
  execFileSync(
    join(bin, 'pg_ctl'),
    ['-D', join(root, 'data'), '-l', join(root, 'pg.log'), '-o', `-p 55481 -k ${root} -h 127.0.0.1 -F`, '-w', 'start'],
    { stdio: 'pipe' },
  );
  started = true;
  const url = 'postgresql://postgres@127.0.0.1:55481/postgres?connection_limit=1';
  s1 = new PrismaClient({ datasources: { db: { url } } });
  s2 = new PrismaClient({ datasources: { db: { url } } });
  fin = new PrismaClient({ datasources: { db: { url } } });
  fin2 = new PrismaClient({ datasources: { db: { url } } });
  await s1.$executeRawUnsafe('CREATE TABLE "User" (id text PRIMARY KEY, deleted_at timestamp)');
  await s1.$executeRawUnsafe('CREATE TABLE "ClientPurchase" (id text PRIMARY KEY)');
  await s1.$executeRawUnsafe(`INSERT INTO "ClientPurchase" VALUES ('pur_a'), ('pur_b')`);
}, 30_000);

beforeEach(async () => {
  await s1.$executeRawUnsafe('DELETE FROM "User"');
  await s1.$executeRaw`INSERT INTO "User" (id) VALUES (${X}), (${Y})`;
});

afterAll(async () => {
  for (const c of [s1, s2, fin, fin2]) await c?.$disconnect();
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
});

// Contents in the stateful double; User locks/reads and the purchase row lock in real PostgreSQL.
function party(pg: PrismaClient, id: string, client: string, coach: string) {
  const db = makeFakePrisma();
  const stripe = makeFakeStripe();
  const old = new Date(Date.now() - 10 * 60_000);
  db._users.push({ id: X, deleted_at: null }, { id: Y, deleted_at: null });
  const row = {
    id,
    client_user_id: client,
    coach_user_id: coach,
    billing_type: 'recurring',
    status: 'pending',
    entitlement_active: false,
    trial_started_at: null,
    stripe_subscription_id: null,
    stripe_client_secret: null,
    stripe_customer_id: 'cus_client',
    stripe_destination_account: 'acct_coach',
    idempotency_key: `sub-${client}-key`,
    stripe_checkout_session_id: `sub-retry-sub-${client}-key`,
    created_at: old,
    updated_at: old,
  };
  db._purchases.push(row);
  const write = db.clientPurchase.updateMany.getMockImplementation();
  const sqlDb = {
    $transaction: (cb: (tx: any) => Promise<unknown>, options: any) =>
      pg.$transaction(
        async (tx) =>
          cb({
            ...db,
            $queryRaw: tx.$queryRaw.bind(tx),
            user: {
              findUnique: async ({ where }: any) => {
                const rows = await tx.$queryRaw<Array<{ deleted_at: Date | null }>>`SELECT deleted_at FROM "User" WHERE id = ${where.id}`;
                return rows[0] ?? null;
              },
            },
            clientPurchase: {
              ...db.clientPurchase,
              updateMany: async (args: any) => {
                await tx.$queryRaw`SELECT id FROM "ClientPurchase" WHERE id = ${args.where.id} FOR UPDATE`;
                return write(args);
              },
            },
          }),
        options,
      ),
  };
  const create = jest.fn(async () =>
    stripe.createSubscription({
      customer: 'cus_client',
      recurringPriceId: 'price_4900',
      metadata: { tgp_purchase_id: id },
      idempotencyKey: `k-${id}`,
    }),
  );
  return { db, stripe, row, sqlDb, create };
}

describe('B-678-4 closure under real PostgreSQL locks', () => {
  it('coach finalization FIRST: the send blocks on the coach row, then sends nothing', async () => {
    const p = party(s1, 'pur_a', X, Y);
    const locked = deferred();
    const release = deferred();
    let committedAt = 0;
    const deletion = fin.$transaction(
      async (tx) => {
        const got = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE id = ${Y} FOR UPDATE SKIP LOCKED`;
        expect(got).toHaveLength(1);
        await tx.$executeRaw`UPDATE "User" SET deleted_at = now() WHERE id = ${Y}`;
        locked.resolve();
        await release.promise;
        committedAt = Date.now();
      },
      { timeout: 10_000 },
    );
    await locked.promise;
    const send = sendFenced(p.sqlDb as any, p.row as any, null, p.create).then((out) => ({ out, at: Date.now() }));
    await sleep(800);
    release.resolve();
    await deletion;
    const { out, at } = await send;
    console.log('OPUS_COACH_FIRST', { out, creates: p.create.mock.calls.length, blockedUntilCommit: at >= committedAt });
    expect(out).toBe('closed');
    expect(p.create).not.toHaveBeenCalled();
    expect(at).toBeGreaterThanOrEqual(committedAt);
    expect(p.row.stripe_checkout_session_id).toBe(`sub-retry-sub-${X}-key`);
  }, 20_000);

  it('client finalization FIRST: the send answers gone, nothing sent', async () => {
    const p = party(s1, 'pur_a', X, Y);
    await s1.$executeRaw`UPDATE "User" SET deleted_at = now() WHERE id = ${X}`;
    expect(await sendFenced(p.sqlDb as any, p.row as any, null, p.create)).toBe('gone');
    expect(p.create).not.toHaveBeenCalled();
  }, 20_000);

  it('a finalization that rolls back (no tombstone) lets the waiting send proceed and bind', async () => {
    const p = party(s1, 'pur_a', X, Y);
    const locked = deferred();
    const release = deferred();
    const deletion = fin
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${Y} FOR UPDATE`;
          locked.resolve();
          await release.promise;
          throw new Error('synthetic rollback');
        },
        { timeout: 10_000 },
      )
      .catch((e: Error) => e.message);
    await locked.promise;
    const send = sendFenced(p.sqlDb as any, p.row as any, null, p.create);
    await sleep(500);
    release.resolve();
    expect(await deletion).toBe('synthetic rollback');
    const out: any = await send;
    expect(out.sub.id).toBe('sub_1');
    expect(out.bound?.stripe_subscription_id).toBe('sub_1');
  }, 20_000);

  it('reciprocal identities: two sends in flight hold both rows; finalization of either skips; both bind, no deadlock', async () => {
    const a = party(s1, 'pur_a', X, Y);
    const b = party(s2, 'pur_b', Y, X);
    const inA = deferred();
    const inB = deferred();
    const go = deferred();
    a.create.mockImplementationOnce(async () => {
      inA.resolve();
      await go.promise;
      return a.stripe.createSubscription({ customer: 'cus_client', recurringPriceId: 'p', metadata: { tgp_purchase_id: 'pur_a' }, idempotencyKey: 'a' });
    });
    b.create.mockImplementationOnce(async () => {
      inB.resolve();
      await go.promise;
      return b.stripe.createSubscription({ customer: 'cus_client', recurringPriceId: 'p', metadata: { tgp_purchase_id: 'pur_b' }, idempotencyKey: 'b' });
    });
    const sa = sendFenced(a.sqlDb as any, a.row as any, null, a.create);
    const sb = sendFenced(b.sqlDb as any, b.row as any, null, b.create);
    await Promise.all([inA.promise, inB.promise]);
    const skipped = await fin.$transaction(async (tx) => {
      const rx = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE id = ${X} FOR UPDATE SKIP LOCKED`;
      const ry = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE id = ${Y} FOR UPDATE SKIP LOCKED`;
      return rx.length === 0 && ry.length === 0;
    });
    // A waiting-mode lock (requestDeletion 'wait') on Y queues behind both sends and then completes.
    const waiter = fin2.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${Y} FOR UPDATE`;
      return 'waited';
    }, { timeout: 10_000, maxWait: 10_000 });
    await sleep(300);
    go.resolve();
    const [oa, ob, w]: any[] = await Promise.all([sa, sb, waiter]);
    console.log('OPUS_RECIPROCAL', { skipped, a: oa.bound?.stripe_subscription_id, b: ob.bound?.stripe_subscription_id, w });
    expect(skipped).toBe(true);
    expect(oa.bound?.stripe_subscription_id).toBe('sub_1');
    expect(ob.bound?.stripe_subscription_id).toBe('sub_1');
    expect(w).toBe('waited');
  }, 25_000);
});

describe('builder decision 1 evidence: coach deleted before the send (doubles)', () => {
  it('createSubscriptionIntent sends nothing and answers a coded error', async () => {
    const prisma = makeFakePrisma();
    const stripe = makeFakeStripe();
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
    prisma._users.push(
      { id: X, email: 'client@example.test', name: 'Client', coach_id: Y, deleted_at: null },
      { id: Y, email: 'coach@example.test', name: 'Coach', coach_id: null, deleted_at: new Date() },
    );
    prisma._packages.push({
      ...{ id: PKG, coach_id: Y, name: 'Plan', amount_cents: 4900, currency: 'usd' },
      ...{ billing_type: 'recurring', interval: 'month', interval_count: 1 },
      ...{ stripe_price_id: 'price_plan', recurring_amount_cents: null, recurring_interval: null },
      ...{ recurring_interval_count: null, recurring_stripe_price_id: null, is_active: true },
      ...{ published_at: new Date('2026-09-01'), archived_at: null, trial_days: 0 },
    });
    prisma._accounts.push({ coach_user_id: Y, stripe_account_id: 'acct_coach', charges_enabled: true, deauthorized_at: null });
    const packages: any = { getById: async (id: string) => prisma._packages.find((p: any) => p.id === id) };
    const svc = new SubscriptionCheckoutService(
      prisma,
      stripe,
      packages,
      { ready: true } as any,
      { planFor: async () => ({ head_coach_id: null }) } as any,
      makeCheckoutHelpers(prisma) as any,
    );
    let body: any = null;
    try {
      await svc.createSubscriptionIntent(X, { package_id: PKG, idempotency_key: KEY1 });
    } catch (err) {
      if (!(err instanceof HttpException)) throw err;
      body = err.getResponse();
    }
    console.log('OPUS_COACH_GONE', { body, creates: stripe.createSubscription.mock.calls.length, rows: prisma._purchases.map((r: any) => r.status) });
    expect(stripe.createSubscription).not.toHaveBeenCalled();
    expect(typeof body?.code).toBe('string');
  });
});
