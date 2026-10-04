import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type ClientPurchase } from '@prisma/client';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import type { SplitPlan } from '../src/connect/fees/fee-policy.service';
import type { PrismaService } from '../src/prisma.service';

// Independent exact-source proof. Disposable Postgres in the CI runner only,
// never DATABASE_URL or any production/provider connection. Both real unique
// indexes are present; separate Prisma clients model separate webhook workers.
jest.setTimeout(120_000);
const container = `aud-sol-f12-117-${randomUUID()}`;
let a: PrismaClient;
let b: PrismaClient;

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0) throw new Error(`disposable postgres command failed: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(async () => {
  docker([
    'run', '-d', '--rm', '--name', container,
    '-e', 'POSTGRES_PASSWORD=isolated-audit',
    '-p', '127.0.0.1::5432', 'postgres:16-alpine',
  ]);
  const port = docker(['port', container, '5432/tcp']).split(':')[1];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres']);
    if (ready.status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const url = `postgresql://postgres:isolated-audit@127.0.0.1:${port}/postgres`;
  a = new PrismaClient({ datasources: { db: { url } } });
  b = new PrismaClient({ datasources: { db: { url } } });
  // Exact columns used by Prisma's SplitLedgerEntry reader; foreign keys are
  // irrelevant to this identity proof. The charge unique matches F1 SQL.
  await a.$executeRawUnsafe(`CREATE TABLE "SplitLedgerEntry" (
    id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, kind TEXT NOT NULL,
    payee_user_id TEXT, payee_stripe_account_id TEXT,
    amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending', stripe_charge_id TEXT,
    stripe_application_fee_id TEXT, stripe_transfer_id TEXT,
    reversed_cents INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE,
    last_error TEXT, posted_at TIMESTAMP(3), reversed_at TIMESTAMP(3),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SplitLedgerEntry_purchase_kind_payee_charge_key"
      UNIQUE (purchase_id, kind, payee_user_id, stripe_charge_id)
  )`);
});
afterAll(async () => {
  await a?.$disconnect();
  await b?.$disconnect();
  docker(['stop', container]);
});
beforeEach(async () => {
  await a.splitLedgerEntry.deleteMany();
});

const input = (account: string) => ({
  purchase: { id: 'legacy_purchase', coach_user_id: 'same_coach', currency: 'usd' } as ClientPurchase,
  plan: {
    application_fee_cents: 200, destination_cents: 9_800,
    head_coach_split_cents: 0, head_coach_id: null,
  } as SplitPlan,
  platform_account_id: null,
  seller_stripe_account_id: account,
  head_coach_stripe_account_id: null,
});

function independentPlanners() {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = (client: PrismaClient) => new SplitLedgerService(client.$extends({
    query: {
      splitLedgerEntry: {
        async findFirst({ args, query }) {
          const snapshot = await query(args);
          if (args.where?.kind === 'destination') {
            reads += 1;
            if (reads === 2) release();
            await gate;
          }
          return snapshot;
        },
      },
    },
  }) as unknown as PrismaService);
  return [worker(a), worker(b)];
}

describe('AUD-SOL-F12-117 F1 real-Postgres legacy identity', () => {
  it('control: nullable charge unique admits duplicates without the durable key', async () => {
    await Promise.all([a, b].map((client) => client.splitLedgerEntry.create({
      data: {
        purchase_id: 'legacy_purchase', kind: 'destination', payee_user_id: 'same_coach',
        payee_stripe_account_id: 'acct_original', amount_cents: 9_800,
      },
    })));
    expect(await a.splitLedgerEntry.count()).toBe(2);
  });

  it('control: same-account competing snapshots adopt one real database row', async () => {
    const [first, second] = independentPlanners();
    const results = await Promise.all([
      first.ensurePendingEntries(input('acct_original')),
      second.ensurePendingEntries(input('acct_original')),
    ]);
    expect(await a.splitLedgerEntry.count({ where: { kind: 'destination' } })).toBe(1);
    expect(results.map((rows) => rows.find((row) => row.kind === 'destination')!.id))
      .toEqual([results[0].find((row) => row.kind === 'destination')!.id,
        results[0].find((row) => row.kind === 'destination')!.id]);
  });

  it('same logical payee remains one legacy row across competing pre/post-reconnect account snapshots', async () => {
    const [first, second] = independentPlanners();
    await Promise.all([
      first.ensurePendingEntries(input('acct_original')),
      second.ensurePendingEntries(input('acct_reconnected')),
    ]);
    const destinations = await a.splitLedgerEntry.findMany({ where: { kind: 'destination' } });
    console.log('AUD117_REAL_POSTGRES_DESTINATIONS', destinations.map((row) => ({
      amount: row.amount_cents, payee: row.payee_user_id,
      charge: row.stripe_charge_id, key: row.idempotency_key,
    })));
    expect(destinations).toHaveLength(1);
  });

  it('control: an existing historical null-key row is reused and can refresh its account', async () => {
    const original = await a.splitLedgerEntry.create({
      data: {
        purchase_id: 'legacy_purchase', kind: 'destination', payee_user_id: 'same_coach',
        payee_stripe_account_id: 'acct_original', amount_cents: 9_800,
      },
    });
    const service = new SplitLedgerService(b as unknown as PrismaService);
    await service.ensurePendingEntries(input('acct_reconnected'));
    expect(await a.splitLedgerEntry.count({ where: { kind: 'destination' } })).toBe(1);
    expect(await a.splitLedgerEntry.findUniqueOrThrow({ where: { id: original.id } }))
      .toMatchObject({ idempotency_key: null, payee_stripe_account_id: 'acct_reconnected' });
  });
});
