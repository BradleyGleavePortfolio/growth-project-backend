// Actual candidate send fence and collector, real PostgreSQL lock ordering,
// synthetic purchase projection and provider. Dedicated CI-only cluster.
// This is boundary integration evidence, not full-schema/provider e2e.
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import { sendFenced } from '../src/checkout/subscription-attempt';
import { makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
let bin: string;
let root: string;
let started = false;
let sender: PrismaClient;
let finalizer: PrismaClient;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeAll(async () => {
  if (process.env.CI !== 'true') throw new Error('CI-only isolated PostgreSQL proof');
  const version = readdirSync('/usr/lib/postgresql').sort().reverse()
    .find((v) => existsSync(join('/usr/lib/postgresql', v, 'bin/initdb')));
  if (!version) throw new Error('Runner has no PostgreSQL binaries');
  bin = join('/usr/lib/postgresql', version, 'bin');
  root = mkdtempSync(join(tmpdir(), 'sol-r12-119-pg-'));
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync'], { stdio: 'pipe' });
  execFileSync(join(bin, 'pg_ctl'), [
    '-D', join(root, 'data'), '-l', join(root, 'postgres.log'),
    '-o', `-p 55479 -k ${root} -h 127.0.0.1 -F`, '-w', 'start',
  ], { stdio: 'pipe' });
  started = true;
  const url = 'postgresql://postgres@127.0.0.1:55479/postgres?connection_limit=1';
  sender = new PrismaClient({ datasources: { db: { url } } });
  finalizer = new PrismaClient({ datasources: { db: { url } } });
  await sender.$executeRawUnsafe('CREATE TABLE "User" (id text PRIMARY KEY, deleted_at timestamp)');
  await sender.$executeRawUnsafe('CREATE TABLE "ClientPurchase" (id text PRIMARY KEY)');
  await sender.$executeRaw`INSERT INTO "User" (id) VALUES (${CLIENT}), (${COACH})`;
  await sender.$executeRawUnsafe(`INSERT INTO "ClientPurchase" VALUES ('pur_fence')`);
}, 30_000);

afterAll(async () => {
  await sender?.$disconnect();
  await finalizer?.$disconnect();
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
});

function setup() {
  const db = makeFakePrisma();
  const stripe = makeFakeStripe();
  const old = new Date(Date.now() - 10 * 60_000);
  db._users.push({ id: CLIENT, deleted_at: null }, { id: COACH, deleted_at: null });
  const row = {
    id: 'pur_fence', client_user_id: CLIENT, coach_user_id: COACH,
    billing_type: 'recurring', status: 'pending', entitlement_active: false,
    trial_started_at: null, stripe_subscription_id: null, stripe_client_secret: null,
    stripe_customer_id: 'cus_client', stripe_destination_account: 'acct_coach',
    idempotency_key: `sub-${CLIENT}-key`, stripe_checkout_session_id: `sub-retry-sub-${CLIENT}-key`,
    created_at: old, updated_at: old,
  };
  db._purchases.push(row);
  const write = db.clientPurchase.updateMany.getMockImplementation();
  const sqlDb = {
    $transaction: (cb: (tx: any) => Promise<unknown>, options: any) =>
      sender.$transaction(async (tx) => cb({
        ...db,
        $queryRaw: tx.$queryRaw.bind(tx),
        user: { findUnique: async ({ where }: any) => {
          const rows = await tx.$queryRaw<Array<{ deleted_at: Date | null }>>
            `SELECT deleted_at FROM "User" WHERE id = ${where.id}`;
          return rows[0] ?? null;
        }},
        clientPurchase: {
          ...db.clientPurchase,
          updateMany: async (args: any) => {
            // Real UPDATE row-lock boundary; contents use the candidate's
            // where predicate in the stateful double.
            await tx.$queryRaw`SELECT id FROM "ClientPurchase" WHERE id = ${args.where.id} FOR UPDATE`;
            return write(args);
          },
        },
      }), options),
  };
  const billing = new AccountDeletionBillingService({} as any, stripe);
  return { db, stripe, row, sqlDb, billing };
}

it('control: client finalization SKIP LOCKED skips an in-flight send, then sees its bound subscription', async () => {
  const f = setup();
  const entered = deferred();
  const release = deferred();
  const running = sendFenced(f.sqlDb as any, f.row as any, null, async () => {
    entered.resolve();
    await release.promise;
    return f.stripe.createSubscription({
      customer: 'cus_client', recurringPriceId: 'price_4900',
      metadata: { tgp_purchase_id: f.row.id }, idempotencyKey: 'client-control',
    });
  });
  await entered.promise;
  try {
    const rows = await finalizer.$queryRaw<Array<{ id: string }>>
      `SELECT id FROM "User" WHERE id = ${CLIENT} FOR UPDATE SKIP LOCKED`;
    expect(rows).toEqual([]);
  } finally {
    release.resolve();
  }
  await running;
  const ids = await f.billing.collectSubscriptionIds({
    clientPurchase: f.db.clientPurchase,
    coachSubscription: { findMany: async () => [] },
    guestCheckout: { findMany: async () => [] },
  } as any, CLIENT);
  expect(ids).toEqual(['sub_1']);
}, 15_000);

it('B-678-4: coach finalization must not collect zero then tombstone after an in-flight send binds', async () => {
  const f = setup();
  const entered = deferred();
  const collected = deferred();
  const running = sendFenced(f.sqlDb as any, f.row as any, null, async () => {
    entered.resolve();
    await collected.promise;
    return f.stripe.createSubscription({
      customer: 'cus_client', recurringPriceId: 'price_4900',
      metadata: { tgp_purchase_id: f.row.id }, idempotencyKey: 'coach-race',
    });
  });
  await entered.promise;
  let ids: string[] = [];
  let skipped = false;
  const deletion = finalizer.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>
      `SELECT id FROM "User" WHERE id = ${COACH} FOR UPDATE SKIP LOCKED`;
    if (!locked.length) { skipped = true; collected.resolve(); return; }
    const adapter = {
      clientPurchase: f.db.clientPurchase,
      coachSubscription: { findMany: async () => [] },
      guestCheckout: { findMany: async () => [] },
    };
    ids = await f.billing.collectSubscriptionIds(adapter as any, COACH);
    ids.push(...await f.billing.collectUnboundAttemptSubscriptionIds(adapter as any, COACH));
    collected.resolve();
    // Actual manifest row update blocks behind the sending purchase lock;
    // its earlier subscription-id snapshot does not become fresh afterward.
    await tx.$queryRaw`SELECT id FROM "ClientPurchase" WHERE id = 'pur_fence' FOR UPDATE`;
    Object.assign(f.row, { coach_user_id: '__deleted_user_sentinel__', status: 'canceled' });
  }, { timeout: 10_000 });
  try {
    await Promise.all([running, deletion]);
  } finally {
    collected.resolve();
  }
  console.log('SOL_COACH_FENCE', { skipped, collected: ids, creates: f.stripe.createSubscription.mock.calls.length, status: f.row.status });
  // Safe outcomes: finalization skipped under shared send authority, or its
  // billing stop collected this subscription before finishing erasure.
  expect(skipped || ids.includes('sub_1')).toBe(true);
}, 15_000);
