// S-FEE round 11 (agent 116) — Sol's F1 findings at 5a19178d:
//   B-681-1  a failed charge-lock release logged the DB error's free text.
//   B-682-1  (F1 half) reverseTransfer had no send-start hook at the HTTP
//            boundary; F2's reversal driver now passes one.
//   B-681-2  the legacy ledger lost its atomic per-purchase identity: two
//            concurrent planners both saw no row and both created one (the
//            new 4-column unique holds a NULL charge id, and Postgres treats
//            NULLs as distinct).
// The first test of each group fails on 5a19178d. No live Stripe or DB: the fake below enforces
// the two unique indexes on SplitLedgerEntry the way Postgres does (a NULL in
// any indexed column never conflicts).
import { Logger } from '@nestjs/common';
import { Prisma, type ClientPurchase } from '@prisma/client';
import { ChargeLock } from '../src/connect/fees/charge-lock';
import type { SplitPlan } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import type { PrismaService } from '../src/prisma.service';

type Row = Record<string, unknown>;
const CANARY = 'AUDIT_CANARY client@example.invalid body="Your refund"';

function canaryError(): Error {
  return Object.assign(new Error(CANARY), { name: CANARY, code: CANARY });
}

/** SplitLedgerEntry with Postgres unique semantics (NULLs never conflict). */
function makeLedgerDb() {
  const rows: Row[] = [];
  let n = 0;
  const composite = ['purchase_id', 'kind', 'payee_user_id', 'stripe_charge_id'];
  const conflicts = (candidate: Row, other: Row) =>
    (candidate.idempotency_key != null && candidate.idempotency_key === other.idempotency_key) ||
    composite.every((k) => candidate[k] != null && candidate[k] === other[k]);
  const assertUnique = (candidate: Row, self?: Row) => {
    if (rows.some((r) => r !== self && conflicts(candidate, r))) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
  };
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
  const splitLedgerEntry = {
    // The result is computed when the call starts, like a SELECT that ran
    // before the other planner's INSERT committed.
    findFirst: jest.fn(async ({ where }: { where: Row }) => {
      const hit = rows.find((r) => match(r, where));
      return hit ? { ...hit } : null;
    }),
    findUnique: jest.fn(async ({ where }: { where: Row }) => {
      const hit = rows.find((r) => match(r, where));
      return hit ? { ...hit } : null;
    }),
    create: jest.fn(async ({ data }: { data: Row }) => {
      await Promise.resolve();
      const row: Row = {
        id: `le-${++n}`,
        stripe_charge_id: null,
        idempotency_key: null,
        status: 'pending',
        reversed_cents: 0,
        created_at: new Date(Date.now() + n),
        ...data,
      };
      assertUnique(row);
      rows.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error('update target missing');
      const next = {
        ...row,
        ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      };
      assertUnique(next, row);
      Object.assign(row, next);
      return { ...row };
    }),
  };
  return { rows, prisma: { splitLedgerEntry } as object as PrismaService, splitLedgerEntry };
}

const purchase = { id: 'cp-legacy', coach_user_id: 'coach-1', currency: 'usd' } as ClientPurchase;
const plan = (destination: number, headCoach = 0) =>
  ({
    application_fee_cents: 200,
    destination_cents: destination,
    head_coach_split_cents: headCoach,
    head_coach_id: headCoach > 0 ? 'head-1' : null,
  }) as SplitPlan;
const inputs = (destination = 9_800, headCoach = 0) => ({
  purchase,
  plan: plan(destination, headCoach),
  platform_account_id: null,
  seller_stripe_account_id: 'acct_coach',
  head_coach_stripe_account_id: headCoach > 0 ? 'acct_head' : null,
});

describe('B-681-2 legacy ledger identity survives concurrent planners', () => {
  it('two concurrent planners for one legacy purchase write one row per slice and return the same rows', async () => {
    const { rows, prisma } = makeLedgerDb();
    const ledger = new SplitLedgerService(prisma);
    const [a, b] = await Promise.all([
      ledger.ensurePendingEntries(inputs(9_300, 500)),
      ledger.ensurePendingEntries(inputs(9_300, 500)),
    ]);
    for (const kind of ['application_fee', 'destination', 'head_coach_split']) {
      expect(rows.filter((r) => r.kind === kind)).toHaveLength(1);
    }
    expect(rows.find((r) => r.kind === 'destination')).toMatchObject({
      amount_cents: 9_300,
      stripe_charge_id: null,
      // The durable legacy identity: purchase, slice and payee user, the
      // same identity the lookup uses (round 13, Sol B-681-2).
      idempotency_key: 'sfee-legacy-ledger:cp-legacy:destination:coach-1',
    });
    expect(a.map((r) => r.id).sort()).toEqual(b.map((r) => r.id).sort());
  });

  it('charge attachment, a replay, and a renewal with a new charge and amount keep one legacy set', async () => {
    const { rows, prisma } = makeLedgerDb();
    const ledger = new SplitLedgerService(prisma);
    const first = await ledger.ensurePendingEntries(inputs());
    for (const e of first) await ledger.markPosted({ entry_id: e.id, stripe_charge_id: 'ch_1' });
    // Replayed webhook, then a concurrent pair for the renewal (new amount).
    await ledger.ensurePendingEntries(inputs());
    await Promise.all([
      ledger.ensurePendingEntries(inputs(9_700)),
      ledger.ensurePendingEntries(inputs(9_700)),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'destination')).toMatchObject({
      amount_cents: 9_700,
      stripe_charge_id: 'ch_1',
      status: 'posted',
    });
    expect(rows.find((r) => r.kind === 'application_fee')).toMatchObject({ amount_cents: 200 });
  });

  it('per-charge S-FEE slices of different renewals stay distinct and never take a legacy key', async () => {
    const { rows, prisma } = makeLedgerDb();
    const ledger = new SplitLedgerService(prisma);
    for (const charge of ['ch_r1', 'ch_r2']) {
      await ledger.createChargeEntry({
        purchase_id: 'cp-sfee',
        stripe_charge_id: charge,
        kind: 'destination',
        payee_user_id: 'coach-1',
        payee_stripe_account_id: 'acct_coach',
        amount_cents: 4_630,
        currency: 'usd',
        status: 'pending',
      });
    }
    expect(rows.map((r) => [r.stripe_charge_id, r.idempotency_key])).toEqual([
      ['ch_r1', null],
      ['ch_r2', null],
    ]);
  });

  // Round 13 (Sol B-681-2 = Opus C-681-7): the key and the lookup name the
  // same identity, the payee user. A reconnected payee account changes the
  // routing, never the identity, so two planners holding account snapshots
  // from before and after a reconnection still race on one INSERT.
  it('pre- and post-reconnection account snapshots of one payee keep one legacy row per slice', async () => {
    const { rows, prisma } = makeLedgerDb();
    const ledger = new SplitLedgerService(prisma);
    const snapshot = (account: string, head: string) => ({
      ...inputs(9_300, 500),
      seller_stripe_account_id: account,
      head_coach_stripe_account_id: head,
    });
    const [a, b] = await Promise.all([
      ledger.ensurePendingEntries(snapshot('acct_original', 'acct_head_original')),
      ledger.ensurePendingEntries(snapshot('acct_reconnected', 'acct_head_reconnected')),
    ]);
    const destinations = rows.filter((r) => r.kind === 'destination');
    const heads = rows.filter((r) => r.kind === 'head_coach_split');
    expect(destinations).toHaveLength(1);
    expect(heads).toHaveLength(1);
    expect(rows).toHaveLength(3);
    expect(destinations[0]).toMatchObject({
      payee_user_id: 'coach-1',
      amount_cents: 9_300,
      stripe_charge_id: null,
      idempotency_key: 'sfee-legacy-ledger:cp-legacy:destination:coach-1',
    });
    expect(heads[0]).toMatchObject({
      payee_user_id: 'head-1',
      amount_cents: 500,
      idempotency_key: 'sfee-legacy-ledger:cp-legacy:head_coach_split:head-1',
    });
    // Both planners return the one surviving row of each slice.
    expect(a.map((r) => r.id).sort()).toEqual(b.map((r) => r.id).sort());
    // A later renewal after the reconnection refreshes that row in place.
    await ledger.ensurePendingEntries(snapshot('acct_reconnected', 'acct_head_reconnected'));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.kind === 'destination')).toMatchObject({
      payee_stripe_account_id: 'acct_reconnected',
    });
  });

  it('a new head coach on a renewal still gets its own legacy row (identity is the payee)', async () => {
    const { rows, prisma } = makeLedgerDb();
    const ledger = new SplitLedgerService(prisma);
    await ledger.ensurePendingEntries(inputs(9_300, 500));
    const nextHead = {
      ...inputs(9_300, 500),
      plan: { ...plan(9_300, 500), head_coach_id: 'head-2' } as SplitPlan,
    };
    await ledger.ensurePendingEntries(nextHead);
    expect(
      rows
        .filter((r) => r.kind === 'head_coach_split')
        .map((r) => [r.payee_user_id, r.idempotency_key]),
    ).toEqual([
      ['head-1', 'sfee-legacy-ledger:cp-legacy:head_coach_split:head-1'],
      ['head-2', 'sfee-legacy-ledger:cp-legacy:head_coach_split:head-2'],
    ]);
  });

  it('an INSERT that fails for any other reason is not swallowed', async () => {
    const { prisma, splitLedgerEntry } = makeLedgerDb();
    splitLedgerEntry.create.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(new SplitLedgerService(prisma).ensurePendingEntries(inputs())).rejects.toThrow(
      'connection terminated',
    );
  });
});

describe('B-681-1 lock-release failures log a closed error kind only', () => {
  afterEach(() => jest.restoreAllMocks());

  function lockWith(deleteError: unknown) {
    const cronLease = {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => {
        throw deleteError;
      }),
    };
    return new ChargeLock({ cronLease } as object as PrismaService);
  }

  it.each([
    ['custom message, name and code', canaryError(), 'unknown'],
    [
      'Prisma known request error carrying input',
      new Prisma.PrismaClientKnownRequestError(CANARY, { code: 'P2010', clientVersion: 'x' }),
      'db_request',
    ],
    [
      'Prisma validation error',
      new Prisma.PrismaClientValidationError(CANARY, { clientVersion: 'x' }),
      'db_validation',
    ],
  ])('%s: the work completes, the warning names only the kind', async (_label, err, kind) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(lockWith(err).run('ch_audit', async () => 'completed')).resolves.toBe('completed');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain('AUDIT_CANARY');
    expect(line).not.toContain('example.invalid');
    expect(line).toMatch(
      new RegExp(`^SFEE_CHARGE_LOCK_RELEASE_FAILED lock=sfee-charge:ch_audit error_kind=${kind}: `),
    );
  });
});

describe('B-682-1 (F1 half): reverseTransfer runs beforeSend at the HTTP boundary', () => {
  class BoundaryStripe extends StripeConnectApiService {
    readonly events: string[] = [];
    protected fetchImpl: typeof fetch = async () => {
      this.events.push('fetch');
      return new Response(JSON.stringify({ id: 'trr_1', transfer: 'tr_1', amount: 400 }), {
        status: 200,
      });
    };
  }
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_round11reversal01';
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });
  const base = { transfer_id: 'tr_1', amount: 400, idempotencyKey: 'tgp-tr-rev-t1-op1' };

  it('makes no request when beforeSend throws, and surfaces that error', async () => {
    const stripe = new BoundaryStripe();
    const expired = new Error('send window closed');
    // A variable, not a literal: on 5a19178d the option does not exist yet.
    const args = {
      ...base,
      beforeSend: () => {
        throw expired;
      },
    };
    await expect(stripe.reverseTransfer(args)).rejects.toBe(expired);
    expect(stripe.events).toEqual([]);
  });

  it('runs beforeSend right before the request and sends when it passes', async () => {
    const stripe = new BoundaryStripe();
    const args = { ...base, beforeSend: () => void stripe.events.push('beforeSend') };
    await expect(stripe.reverseTransfer(args)).resolves.toMatchObject({ id: 'trr_1' });
    expect(stripe.events).toEqual(['beforeSend', 'fetch']);
  });
});
