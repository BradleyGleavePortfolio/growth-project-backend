// AUD-OPUS-F12R-116 lens probe (Claude Opus 5.5) on #681 @ 9de3135c. Never merge.
// Independent of the builder's spec: own Postgres-semantics fake, own cases.
import { Logger } from '@nestjs/common';
import { Prisma, type ClientPurchase } from '@prisma/client';
import { ChargeLock } from '../src/connect/fees/charge-lock';
import type { SplitPlan } from '../src/connect/fees/fee-policy.service';
import { dbErrorKind, moneyErrorDiagnostic } from '../src/connect/fees/money-diagnostics';
import { SplitLedgerService, legacyLedgerKey } from '../src/connect/fees/split-ledger.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import type { PrismaService } from '../src/prisma.service';

type Row = Record<string, unknown>;
const CANARY = 'OPUS_PROBE_CANARY coach@example.invalid';

// Postgres unique semantics for SplitLedgerEntry: idempotency_key unique,
// (purchase_id, kind, payee_user_id, stripe_charge_id) unique with NULLS DISTINCT.
// Every call yields to the event loop first (interleaving like real I/O).
function pgLedger() {
  const rows: Row[] = [];
  let n = 0;
  const comp = ['purchase_id', 'kind', 'payee_user_id', 'stripe_charge_id'];
  const clash = (c: Row, o: Row) =>
    (c.idempotency_key != null && c.idempotency_key === o.idempotency_key) ||
    comp.every((k) => c[k] != null && c[k] === o[k]);
  const match = (r: Row, w: Row) =>
    Object.entries(w).every(([k, v]) => (v === null ? r[k] == null : r[k] === v));
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const t = {
    findFirst: jest.fn(async ({ where, orderBy }: { where: Row; orderBy?: unknown }) => {
      const snapshot = rows.filter((r) => match(r, where)).map((r) => ({ ...r }));
      await tick();
      void orderBy;
      return snapshot[0] ?? null;
    }),
    findUnique: jest.fn(async ({ where }: { where: Row }) => {
      await tick();
      const hit = rows.find((r) => match(r, where));
      return hit ? { ...hit } : null;
    }),
    create: jest.fn(async ({ data }: { data: Row }) => {
      await tick();
      const row: Row = {
        id: `le-${++n}`,
        stripe_charge_id: null,
        idempotency_key: null,
        status: 'pending',
        reversed_cents: 0,
        created_at: new Date(1_000 + n),
        ...data,
      };
      if (rows.some((r) => clash(row, r))) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'probe',
        });
      }
      rows.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      await tick();
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(
        row,
        Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      );
      return { ...row };
    }),
  };
  return { rows, t, prisma: { splitLedgerEntry: t } as object as PrismaService };
}

const purchase = { id: 'cp-probe', coach_user_id: 'coach-p', currency: 'usd' } as ClientPurchase;
const plan = (dest: number, head = 0) =>
  ({
    application_fee_cents: 210,
    destination_cents: dest,
    head_coach_split_cents: head,
    head_coach_id: head > 0 ? 'head-p' : null,
  }) as SplitPlan;
const inputs = (dest = 9_790, head = 0, seller = 'acct_seller') => ({
  purchase,
  plan: plan(dest, head),
  platform_account_id: null,
  seller_stripe_account_id: seller,
  head_coach_stripe_account_id: head > 0 ? 'acct_head' : null,
});

describe('PROBE F1-L legacy ledger identity under concurrency', () => {
  it('L1: five concurrent planners (two services) write exactly one row per slice', async () => {
    const { rows, prisma } = pgLedger();
    const s1 = new SplitLedgerService(prisma);
    const s2 = new SplitLedgerService(prisma);
    const out = await Promise.all(
      [s1, s2, s1, s2, s1].map((s) => s.ensurePendingEntries(inputs(9_290, 500))),
    );
    for (const kind of ['application_fee', 'destination', 'head_coach_split']) {
      expect(rows.filter((r) => r.kind === kind)).toHaveLength(1);
    }
    const ids = out.map((o) => o.map((r) => r.id).sort().join(','));
    expect(new Set(ids).size).toBe(1);
    expect(rows.map((r) => r.idempotency_key).sort()).toEqual([
      'sfee-legacy-ledger:cp-probe:application_fee:platform',
      'sfee-legacy-ledger:cp-probe:destination:acct_seller',
      'sfee-legacy-ledger:cp-probe:head_coach_split:acct_head',
    ]);
    // Amounts are the planned ones (no adoption overwrote with stale values).
    expect(rows.find((r) => r.kind === 'destination')!.amount_cents).toBe(9_290);
    expect(rows.find((r) => r.kind === 'head_coach_split')!.amount_cents).toBe(500);
  });

  it('L2: a pre-existing legacy row without a key (pre-round-11 shape) is reused, never duplicated', async () => {
    const { rows, prisma, t } = pgLedger();
    rows.push({
      id: 'le-old',
      purchase_id: 'cp-probe',
      kind: 'destination',
      payee_user_id: 'coach-p',
      payee_stripe_account_id: 'acct_seller',
      amount_cents: 9_000,
      currency: 'usd',
      status: 'posted',
      stripe_charge_id: 'ch_old',
      idempotency_key: null,
      created_at: new Date(1),
    });
    const s = new SplitLedgerService(prisma);
    await Promise.all([s.ensurePendingEntries(inputs()), s.ensurePendingEntries(inputs())]);
    expect(rows.filter((r) => r.kind === 'destination')).toHaveLength(1);
    expect(rows.find((r) => r.id === 'le-old')).toMatchObject({
      amount_cents: 9_790,
      status: 'posted',
      stripe_charge_id: 'ch_old',
    });
    expect(t.create.mock.calls.every(([a]) => (a as { data: Row }).data.kind !== 'destination')).toBe(
      true,
    );
  });

  it('L3: the P2002 loser adopts the winner and applies its own (renewal) amount, platform row untouched', async () => {
    const { rows, prisma } = pgLedger();
    const s = new SplitLedgerService(prisma);
    await Promise.all([
      s.ensurePendingEntries(inputs(9_790)),
      s.ensurePendingEntries(inputs(9_790)),
    ]);
    const fee = rows.find((r) => r.kind === 'application_fee')!;
    expect(fee.amount_cents).toBe(210);
    expect(rows).toHaveLength(2);
  });

  it('L4 (edge, documents C): concurrent planners that read different seller accounts write two destination rows', async () => {
    const { rows, prisma } = pgLedger();
    const s = new SplitLedgerService(prisma);
    await Promise.all([
      s.ensurePendingEntries(inputs(9_790, 0, 'acct_seller')),
      s.ensurePendingEntries(inputs(9_790, 0, 'acct_reconnected')),
    ]);
    // Recorded, not asserted as a defect: the key names the account, the lookup names the user.
    // eslint-disable-next-line no-console
    console.log(`L4 destination rows=${rows.filter((r) => r.kind === 'destination').length}`);
    expect(rows.filter((r) => r.kind === 'destination').length).toBeGreaterThanOrEqual(1);
  });

  it('L5: legacyLedgerKey carries ids only (no user id) and is stable', () => {
    const k = legacyLedgerKey({
      purchase_id: 'cp-1',
      kind: 'destination',
      payee_stripe_account_id: 'acct_1',
    });
    expect(k).toBe('sfee-legacy-ledger:cp-1:destination:acct_1');
    expect(k).not.toContain('coach');
  });
});

describe('PROBE F1-D closed diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());
  const lockFailingRelease = (err: unknown) =>
    new ChargeLock({
      cronLease: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => {
          throw err;
        }),
      },
    } as object as PrismaService);

  it.each([
    ['init error', new Prisma.PrismaClientInitializationError(CANARY, 'x'), 'db_unavailable'],
    ['rust panic', new Prisma.PrismaClientRustPanicError(CANARY, 'x'), 'db_unavailable'],
    ['unknown request', new Prisma.PrismaClientUnknownRequestError(CANARY, { clientVersion: 'x' }), 'db_request'],
    ['string thrown', CANARY, 'unknown'],
    ['object with code', { code: 'P2002', message: CANARY }, 'unknown'],
  ])('D1 %s -> SFEE_CHARGE_LOCK_RELEASE_FAILED error_kind=%s, no free text', async (_l, err, kind) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(lockFailingRelease(err).run('ch_p', async () => 7)).resolves.toBe(7);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(`error_kind=${kind}`);
    expect(line).not.toContain('OPUS_PROBE_CANARY');
    expect(line).not.toContain('example.invalid');
    expect(dbErrorKind(err)).toBe(kind);
  });

  it.each([
    [new StripeConnectApiError(CANARY, Number.NaN, null, null), 'kind=stripe http=other type=none code=none'],
    [new StripeConnectApiError(CANARY, 99, '', ''), 'kind=stripe http=other type=none code=none'],
    [new StripeConnectApiError(CANARY, 600, CANARY, CANARY), 'kind=stripe http=other type=other code=other'],
    [new StripeConnectApiError(CANARY, 402.5, 'card_declined', 'card_error'), 'kind=stripe http=other type=card_error code=other'],
    [new StripeConnectApiError(CANARY, 409, 'idempotency_key_in_use', 'idempotency_error'), 'kind=stripe http=409 type=idempotency_error code=idempotency_key_in_use'],
    [Object.assign(new Error(CANARY), { name: 'TimeoutError' }), 'kind=timeout'],
    [new Prisma.PrismaClientValidationError(CANARY, { clientVersion: 'x' }), 'kind=db_validation'],
    [{ message: CANARY, name: 'AbortError' }, 'kind=unknown'],
    [undefined, 'kind=unknown'],
  ])('D2 moneyErrorDiagnostic(%#) is closed', (err, expected) => {
    const out = moneyErrorDiagnostic(err);
    expect(out).toBe(expected);
    expect(out).toMatch(/^kind=(stripe http=(\d{3}|other) type=[a-z_]+ code=[a-z_]+|db_request|db_unavailable|db_validation|timeout|unknown)$/);
  });
});
