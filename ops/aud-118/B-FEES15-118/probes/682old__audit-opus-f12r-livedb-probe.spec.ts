// AUD-OPUS-F12R-116 lens probe (Claude Opus 5.5) on #682 @ a5d6a434 (contains #681 @ 9de3135c).
// Never merge. REAL Postgres 15 (docker on the CI runner), the repo's own
// migration chain via `prisma migrate deploy`, two PrismaClients (two
// connection pools = two app instances). FK triggers are disabled for the
// probe database only (session_replication_role = replica) so rows need no
// User/ClientPurchase fixtures; unique indexes are still enforced.
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient, type ClientPurchase } from '@prisma/client';
import type { SplitPlan } from '../src/connect/fees/fee-policy.service';
import { ReversalUncertainError } from '../src/connect/fees/money-errors';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import type { PrismaService } from '../src/prisma.service';

jest.setTimeout(600_000);
const NAME = 'f12r-pg';
const URL = 'postgresql://postgres:postgres@127.0.0.1:55432/postgres';
const sh = (cmd: string, input?: string) =>
  execSync(cmd, { input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL } }).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let a: PrismaClient;
let b: PrismaClient;
const asSvc = (c: PrismaClient) => c as unknown as PrismaService;

beforeAll(async () => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    sh(`docker rm -f ${NAME}`);
  } catch {
    /* none */
  }
  sh(`docker run -d --name ${NAME} -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:15`);
  let ready = false;
  for (let i = 0; i < 90 && !ready; i += 1) {
    try {
      sh(`docker exec ${NAME} pg_isready -h 127.0.0.1 -U postgres`);
      ready = true;
    } catch {
      await sleep(1_000);
    }
  }
  if (!ready) throw new Error('postgres did not start');
  await sleep(2_000);
  sh(
    `docker exec -i ${NAME} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q`,
    readFileSync('prisma/migrations/_supabase_bootstrap.sql', 'utf8'),
  );
  const out = sh('npx prisma migrate deploy');
  // eslint-disable-next-line no-console
  console.log(`migrate deploy: ${out.split('\n').filter((l) => /applied|migrations found|All migrations/i.test(l)).join(' | ')}`);
  sh(`docker exec ${NAME} psql -U postgres -d postgres -c "ALTER DATABASE postgres SET session_replication_role = 'replica'"`);
  a = new PrismaClient({ datasources: { db: { url: `${URL}?connection_limit=6` } } });
  b = new PrismaClient({ datasources: { db: { url: `${URL}?connection_limit=6` } } });
  await a.$connect();
  await b.$connect();
});

afterAll(async () => {
  await a?.$disconnect();
  await b?.$disconnect();
  try {
    sh(`docker rm -f ${NAME}`);
  } catch {
    /* ignore */
  }
});

const plan = (dest: number, head: number) =>
  ({
    application_fee_cents: 200,
    destination_cents: dest,
    head_coach_split_cents: head,
    head_coach_id: head > 0 ? 'head-live' : null,
  }) as SplitPlan;

describe('LIVE-DB F1 legacy ledger identity (B-681-2)', () => {
  it('DB-L0 harness control: the OLD find-then-create (no key) duplicates rows on real Postgres', async () => {
    let dupes = 0;
    for (let i = 0; i < 30; i += 1) {
      const pid = randomUUID();
      const oldUpsert = async (c: PrismaClient) => {
        const hit = await c.splitLedgerEntry.findFirst({
          where: { purchase_id: pid, kind: 'destination', payee_user_id: 'coach-live' },
        });
        if (hit) return hit;
        return c.splitLedgerEntry.create({
          data: {
            purchase_id: pid,
            kind: 'destination',
            payee_user_id: 'coach-live',
            payee_stripe_account_id: 'acct_live',
            amount_cents: 9_800,
            currency: 'usd',
            status: 'pending',
          },
        });
      };
      await Promise.all([oldUpsert(a), oldUpsert(b), oldUpsert(a), oldUpsert(b)]);
      const n = await a.splitLedgerEntry.count({ where: { purchase_id: pid } });
      if (n > 1) dupes += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`DB-L0 purchases with duplicate legacy rows under the old algorithm: ${dupes}/30`);
    expect(dupes).toBeGreaterThan(0);
  });

  it('DB-L1: round-11 ensurePendingEntries, 4 concurrent planners on 2 pools x 30 purchases: one row per slice', async () => {
    const sa = new SplitLedgerService(asSvc(a));
    const sb = new SplitLedgerService(asSvc(b));
    let bad = 0;
    for (let i = 0; i < 30; i += 1) {
      const purchase = { id: randomUUID(), coach_user_id: 'coach-live', currency: 'usd' } as ClientPurchase;
      const inputs = {
        purchase,
        plan: plan(9_300, 500),
        platform_account_id: null,
        seller_stripe_account_id: 'acct_live',
        head_coach_stripe_account_id: 'acct_head_live',
      };
      const res = await Promise.all([sa, sb, sa, sb].map((s) => s.ensurePendingEntries(inputs)));
      const rows = await a.splitLedgerEntry.findMany({ where: { purchase_id: purchase.id } });
      const perKind = ['application_fee', 'destination', 'head_coach_split'].map(
        (k) => rows.filter((r) => r.kind === k).length,
      );
      const sets = new Set(res.map((r) => r.map((e) => e.id).sort().join(',')));
      if (perKind.some((n) => n !== 1) || sets.size !== 1) bad += 1;
    }
    expect(bad).toBe(0);
  });

  it('DB-L2: the 4-column unique never stops a NULL-charge duplicate; the legacy key does (P2002)', async () => {
    const pid = randomUUID();
    const row = {
      purchase_id: pid,
      kind: 'destination',
      payee_user_id: 'coach-live',
      payee_stripe_account_id: 'acct_live',
      amount_cents: 1,
      currency: 'usd',
    };
    await a.splitLedgerEntry.create({ data: row });
    await a.splitLedgerEntry.create({ data: row });
    expect(await a.splitLedgerEntry.count({ where: { purchase_id: pid } })).toBe(2);
    const key = `sfee-legacy-ledger:${pid}:destination:acct_live`;
    await a.splitLedgerEntry.create({ data: { ...row, idempotency_key: key } });
    const err = await b.splitLedgerEntry
      .create({ data: { ...row, idempotency_key: key } })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });
});

// Stripe fake shared by both app instances: idempotent by key, slow responses.
function sharedStripe() {
  const sends: string[] = [];
  const byKey = new Map<string, { id: string; transfer: string; amount: number; metadata: Record<string, string> }>();
  const reversals: Array<{ id: string; transfer: string; amount: number; metadata: Record<string, string> }> = [];
  const stripe = {
    reverseTransfer: async (args: {
      transfer_id: string;
      amount?: number;
      metadata?: Record<string, string>;
      idempotencyKey: string;
      beforeSend?: () => void;
    }) => {
      args.beforeSend?.();
      sends.push(args.idempotencyKey);
      await sleep(40);
      const hit = byKey.get(args.idempotencyKey);
      if (hit) return hit;
      const r = { id: `trr_${reversals.length + 1}`, transfer: args.transfer_id, amount: args.amount ?? 0, metadata: args.metadata ?? {} };
      reversals.push(r);
      byKey.set(args.idempotencyKey, r);
      return r;
    },
    listTransferReversals: async (transferId: string) => ({
      data: reversals.filter((r) => r.transfer === transferId).reverse(),
      has_more: false,
    }),
  };
  return { sends, reversals, stripe: stripe as unknown as StripeConnectApiService };
}

async function seedTransferWithOp(c: PrismaClient, op: { attempts: number; last_attempt_at: Date | null }) {
  const id = randomUUID();
  await c.connectTransfer.create({
    data: {
      id,
      purchase_id: randomUUID(),
      kind: 'coach_net',
      destination_stripe_account_id: 'acct_live',
      amount_cents: 1_000,
      stripe_transfer_id: `tr_${id.slice(0, 8)}`,
      status: 'succeeded',
      idempotency_key: `op-${id}`,
      reversal_seq: 1,
    },
  });
  const key = `tgp-tr-rev-${id}-op1`;
  await c.transferReversalOp.create({
    data: {
      transfer_id: id,
      seq: 1,
      idempotency_key: key,
      amount_cents: 400,
      base_reversed_cents: 0,
      status: 'pending',
      attempts: op.attempts,
      last_attempt_at: op.last_attempt_at,
    },
  });
  return { id, key };
}

describe('LIVE-DB F2 reversal claim (B-682-1)', () => {
  it('DB-R1: two app instances race 20 undriven ops: exactly one Stripe send per op, 400 recorded once', async () => {
    const { sends, stripe } = sharedStripe();
    const svcA = new TransferOrchestratorService(asSvc(a), stripe, new SplitLedgerService(asSvc(a)));
    const svcB = new TransferOrchestratorService(asSvc(b), stripe, new SplitLedgerService(asSvc(b)));
    let losers = 0;
    let wrongLoser = 0;
    const seeded = [];
    for (let i = 0; i < 20; i += 1) seeded.push(await seedTransferWithOp(a, { attempts: 0, last_attempt_at: null }));
    for (const s of seeded) {
      const res = await Promise.allSettled([svcA.resolvePendingReversals(s.id), svcB.resolvePendingReversals(s.id)]);
      for (const r of res) {
        if (r.status === 'rejected') {
          losers += 1;
          if (!(r.reason instanceof ReversalUncertainError)) wrongLoser += 1;
        }
      }
    }
    let bad = 0;
    for (const s of seeded) {
      const op = await a.transferReversalOp.findUnique({ where: { idempotency_key: s.key } });
      const t = await a.connectTransfer.findUnique({ where: { id: s.id } });
      const n = sends.filter((k) => k === s.key).length;
      if (n !== 1 || op?.status !== 'succeeded' || op.attempts !== 1 || t?.reversed_amount_cents !== 400) bad += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`DB-R1 sends=${sends.length} losers=${losers} wrongLoser=${wrongLoser} bad=${bad}`);
    expect(bad).toBe(0);
    expect(wrongLoser).toBe(0);
    expect(losers).toBeGreaterThan(0); // the race was real: the CAS rejected a claimant
  });

  it('DB-R2: an op claimed before (attempts 1, last_attempt_at with ms) is re-claimable: TIMESTAMP(3) CAS round trip', async () => {
    const { sends, stripe } = sharedStripe();
    const svc = new TransferOrchestratorService(asSvc(b), stripe, new SplitLedgerService(asSvc(b)));
    const s = await seedTransferWithOp(a, { attempts: 1, last_attempt_at: new Date('2026-10-04T00:00:00.123Z') });
    await svc.resolvePendingReversals(s.id);
    const op = await a.transferReversalOp.findUnique({ where: { idempotency_key: s.key } });
    expect(sends.filter((k) => k === s.key)).toHaveLength(1);
    expect(op).toMatchObject({ status: 'succeeded', attempts: 2 });
  });
});
