// Independent #680 round-5 storage boundary proof. Launches a dedicated
// throwaway PostgreSQL cluster on the Actions runner, never an app database.
// Actual candidate handler + DunningService; real SQL row locks / FK checks.
// Purchase read/write contents are doubles; the exact added raw lock and
// DunningState purchase foreign key are real. This is not full-schema e2e.
import { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { DunningService } from '../src/checkout/dunning.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const PORT = 55471;
let root: string;
let bin: string;
let started = false;
let first: PrismaClient;
let second: PrismaClient;

beforeAll(async () => {
  if (process.env.CI !== 'true') throw new Error('CI runner only; no local/live database allowed');
  const versions = readdirSync('/usr/lib/postgresql').sort().reverse();
  bin = join('/usr/lib/postgresql', versions.find((v) => existsSync(join('/usr/lib/postgresql', v, 'bin/initdb')))!, 'bin');
  root = mkdtempSync(join(tmpdir(), 'sol-r34r5-pg-'));
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync'], { stdio: 'pipe' });
  execFileSync(join(bin, 'pg_ctl'), [
    '-D', join(root, 'data'), '-l', join(root, 'postgres.log'),
    '-o', `-p ${PORT} -k ${root} -h 127.0.0.1 -F`, '-w', 'start',
  ], { stdio: 'pipe' });
  started = true;
  const url = `postgresql://postgres@127.0.0.1:${PORT}/postgres?connection_limit=1`;
  first = new PrismaClient({ datasources: { db: { url } } });
  second = new PrismaClient({ datasources: { db: { url } } });
  await first.$executeRawUnsafe('CREATE TABLE "CoachPackage" (id text PRIMARY KEY)');
  await first.$executeRawUnsafe('CREATE TABLE "ClientPurchase" (id text PRIMARY KEY)');
  await first.$executeRawUnsafe('CREATE TABLE "DunningState" (id text PRIMARY KEY, purchase_id text UNIQUE REFERENCES "ClientPurchase"(id) ON DELETE CASCADE)');
  await first.$executeRawUnsafe(`INSERT INTO "CoachPackage" VALUES ('pkg_lock')`);
  await first.$executeRawUnsafe(`INSERT INTO "ClientPurchase" VALUES ('cp_lock')`);
  // Bound the second connection's wait rather than leave a hanging proof.
  await second.$executeRawUnsafe(`SET lock_timeout = '1200ms'`);
}, 30_000);

afterAll(async () => {
  await first?.$disconnect();
  await second?.$disconnect();
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
});

it('control: NO KEY UPDATE still serializes lifecycle writers and allows the dunning FK insert', async () => {
  await first.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ClientPurchase" WHERE id = 'cp_lock' FOR NO KEY UPDATE`;
    await second.$executeRawUnsafe(`INSERT INTO "DunningState" VALUES ('d_control', 'cp_lock')`);
  });
  await second.$executeRawUnsafe(`DELETE FROM "DunningState" WHERE id = 'd_control'`);
});

it('B-680-6: the first renewal decline must commit a dunning window, not swallow a self-blocked FK insert', async () => {
  const db = makeFakePrisma();
  const time = new Date(Date.now() - 60_000);
  db._packages.push({ id: 'pkg_lock', billing_type: 'recurring' });
  db._purchases.push({
    id: 'cp_lock', package_id: 'pkg_lock', client_user_id: 'client_lock', coach_user_id: 'coach_lock',
    billing_type: 'recurring', stripe_subscription_id: 'sub_lock', stripe_checkout_session_id: 'sub_lock',
    status: 'active', entitlement_active: true, trial_days: null, trial_started_at: null,
    updated_at: time, created_at: time, amount_cents: 4900, currency: 'usd',
  });
  let insertError: unknown;
  db.dunningState = {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }: any) => {
      try {
        await second.$executeRawUnsafe(`INSERT INTO "DunningState" VALUES ('d_first_failure', 'cp_lock')`);
      } catch (error) {
        insertError = error;
        throw error;
      }
      return { id: 'd_first_failure', ...data };
    }),
    update: jest.fn(async ({ data }: any) => ({ id: 'd_first_failure', ...data })),
  };
  db.dunningAttempt = { createMany: jest.fn(async () => ({ count: 4 })) };
  db.paymentReminder = { upsert: jest.fn(async () => ({})) };
  const stripe: any = {
    retrieveInvoice: jest.fn(async () => ({ id: 'in_lock', status: 'open' })),
    retrieveSubscription: jest.fn(async () => ({ id: 'sub_lock', status: 'past_due', latest_invoice: 'in_lock' })),
  };
  const dunning = new DunningService(db, stripe);
  const handler = new CheckoutWebhookHandlerService(db, stripe, undefined, dunning);
  const event = {
    id: 'evt_lock_r5', type: 'invoice.payment_failed',
    data: { object: { id: 'in_lock', subscription: 'sub_lock', billing_reason: 'subscription_cycle', amount_due: 4900 } },
  };
  const pre = await handler.prefetchForOuterTx(event);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  try {
    const result = await first.$transaction(async (tx) => {
      const adapter = { ...db, $queryRaw: tx.$queryRaw.bind(tx) };
      return handler.handle(event, adapter, pre);
    }, { timeout: 10_000 });
    const recorded = await second.$queryRaw<Array<{ id: string }>>`SELECT id FROM "DunningState" WHERE purchase_id = 'cp_lock'`;
    // Emit diagnostic observations before the expected-red assertion.
    console.log('SOL_LOCK_PROOF', {
      claimed: result.claimed, purchaseStatus: db._purchases[0].status,
      windows: recorded.length, failureWasCaught: !!insertError,
      errorCode: (insertError as { code?: string } | undefined)?.code,
      dbCode: (insertError as { meta?: { code?: string } } | undefined)?.meta?.code,
      warningCount: warn.mock.calls.length,
    });
    expect(result.claimed).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(dunning.metrics.get('dunning_entered_total')).toBe(1);
  } finally {
    warn.mockRestore();
  }
}, 20_000);
