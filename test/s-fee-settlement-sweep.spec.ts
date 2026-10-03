// S-FEE round 2 — scheduled payout / settlement sweep.
//
// Covers the single-runner lease (two machines racing, expiry, release), the
// kill switch, bounded runs, specific failure codes, and that two sweeps that
// overlap anyway (lease expired mid-run) still pay each coach exactly once
// (Stripe idempotency key + unique ConnectTransfer rows). No live Stripe.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { CronLeaseService } from '../src/checkout/cron-lease.service';
import { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import {
  LEASE_TTL_MS,
  SWEEP_JOB_NAME,
  SettlementSweepCron,
  sweepEnabled,
} from '../src/checkout/settlement-sweep.cron';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import {
  TRANSFER_FAILURE_CODES,
  TransferOrchestratorService,
  transferFailureCode,
} from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  FakeStripe,
  Table,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

const T0 = new Date('2026-10-01T22:00:00Z');

function leaseFor(rows: Row[] = []) {
  const cronLease = new Table(rows, { prefix: 'lease', unique: ['name'] });
  // CronLease's primary key is `name`; mirror it as the row id too.
  return { lease: new CronLeaseService(asPrisma({ cronLease })), cronLease, rows };
}

type SweepFn = PurchaseSplitHandlerService['runTransferSweeper'];

function sweepWith(
  lease: CronLeaseService,
  run: jest.Mock<ReturnType<SweepFn>, Parameters<SweepFn>>,
) {
  const splits: Pick<PurchaseSplitHandlerService, 'runTransferSweeper'> = {
    runTransferSweeper: run,
  };
  return new SettlementSweepCron(lease, splits as PurchaseSplitHandlerService);
}

const okRun = () =>
  jest.fn<ReturnType<SweepFn>, Parameters<SweepFn>>(async () => ({
    attempted: 1,
    succeeded: 1,
    failed: 0,
  }));

const logLines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

let errorLog: jest.SpyInstance;
let warnLog: jest.SpyInstance;
beforeEach(() => {
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.SFEE_SETTLEMENT_SWEEP_ENABLED;
  jest.restoreAllMocks();
});

describe('CronLeaseService (single runner across machines)', () => {
  it('only one of two machines racing for a new lease gets it', async () => {
    const { lease } = leaseFor();
    const [a, b] = await Promise.all([
      lease.tryAcquire(SWEEP_JOB_NAME, 'machine-a', LEASE_TTL_MS, T0),
      lease.tryAcquire(SWEEP_JOB_NAME, 'machine-b', LEASE_TTL_MS, T0),
    ]);
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
  });

  it('only one of two machines racing for an expired lease gets it', async () => {
    const { lease, rows } = leaseFor([
      {
        id: SWEEP_JOB_NAME,
        name: SWEEP_JOB_NAME,
        holder: 'machine-old',
        lease_until: new Date(T0.getTime() - 1),
        acquired_at: new Date(T0.getTime() - LEASE_TTL_MS),
      },
    ]);
    const [a, b] = await Promise.all([
      lease.tryAcquire(SWEEP_JOB_NAME, 'machine-a', LEASE_TTL_MS, T0),
      lease.tryAcquire(SWEEP_JOB_NAME, 'machine-b', LEASE_TTL_MS, T0),
    ]);
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(['machine-a', 'machine-b']).toContain(rows[0].holder);
  });

  it('a held lease blocks until it expires; release frees it early', async () => {
    const { lease } = leaseFor();
    expect((await lease.tryAcquire(SWEEP_JOB_NAME, 'a', LEASE_TTL_MS, T0)).acquired).toBe(true);
    const at5 = new Date(T0.getTime() + 5 * 60_000);
    expect((await lease.tryAcquire(SWEEP_JOB_NAME, 'b', LEASE_TTL_MS, at5)).acquired).toBe(false);
    const at11 = new Date(T0.getTime() + 11 * 60_000);
    expect((await lease.tryAcquire(SWEEP_JOB_NAME, 'b', LEASE_TTL_MS, at11)).acquired).toBe(true);

    // b releases; c can take it straight away.
    const at12 = new Date(T0.getTime() + 12 * 60_000);
    await lease.release(SWEEP_JOB_NAME, 'b', at12);
    const at12b = new Date(at12.getTime() + 1);
    expect((await lease.tryAcquire(SWEEP_JOB_NAME, 'c', LEASE_TTL_MS, at12b)).acquired).toBe(true);
  });

  it('release by a machine that does not hold the lease changes nothing', async () => {
    const { lease, rows } = leaseFor();
    await lease.tryAcquire(SWEEP_JOB_NAME, 'a', LEASE_TTL_MS, T0);
    const until = rows[0].lease_until;
    await lease.release(SWEEP_JOB_NAME, 'intruder', T0);
    expect(rows[0].lease_until).toEqual(until);
  });
});

describe('SettlementSweepCron', () => {
  it('two concurrent runners: exactly one sweeps, the other skips with SFEE_SWEEP_SKIPPED_LOCK_HELD', async () => {
    const { lease } = leaseFor();
    const run = okRun();
    const cronA = sweepWith(lease, run);
    const cronB = sweepWith(lease, run);
    const [a, b] = await Promise.all([
      cronA.runOnce(T0, 'machine-a'),
      cronB.runOnce(T0, 'machine-b'),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    const results = [a, b];
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(results.filter((r) => !r.ran && r.reason === 'lock_held')).toHaveLength(1);
  });

  it('releases the lease after a run so the next tick on any machine can run', async () => {
    const { lease } = leaseFor();
    const run = okRun();
    await sweepWith(lease, run).runOnce(T0, 'machine-a');
    const next = new Date(T0.getTime() + 15 * 60_000);
    const r = await sweepWith(lease, run).runOnce(next, 'machine-b');
    expect(r.ran).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('passes a bounded batch and a deadline inside the lease', async () => {
    const { lease } = leaseFor();
    const run = okRun();
    const before = Date.now();
    await sweepWith(lease, run).runOnce(T0, 'machine-a');
    const opts = run.mock.calls[0][1] ?? {};
    expect(opts.batch).toBe(50);
    expect((opts.deadlineAt ?? Infinity) - before).toBeLessThan(LEASE_TTL_MS);
  });

  it('kill switch SFEE_SETTLEMENT_SWEEP_ENABLED=false: no lease, no sweep', async () => {
    process.env.SFEE_SETTLEMENT_SWEEP_ENABLED = 'false';
    const { lease, cronLease } = leaseFor();
    const run = okRun();
    const r = await sweepWith(lease, run).runOnce(T0, 'machine-a');
    expect(r).toEqual({ ran: false, reason: 'disabled' });
    expect(run).not.toHaveBeenCalled();
    expect(cronLease.updateMany).not.toHaveBeenCalled();
    expect(sweepEnabled({})).toBe(true);
    expect(sweepEnabled({ SFEE_SETTLEMENT_SWEEP_ENABLED: 'true' })).toBe(true);
  });

  it('lease read error: skips the tick with SFEE_SWEEP_LOCK_ERROR and never sweeps', async () => {
    const { lease, cronLease } = leaseFor();
    cronLease.updateMany.mockRejectedValueOnce(new Error('connection reset'));
    const run = okRun();
    const r = await sweepWith(lease, run).runOnce(T0, 'machine-a');
    expect(r).toEqual({ ran: false, reason: 'lock_error' });
    expect(run).not.toHaveBeenCalled();
    expect(logLines(errorLog).some((l) => /^SFEE_SWEEP_LOCK_ERROR alert=true/.test(l))).toBe(true);
  });

  it('a failing sweep logs SFEE_SWEEP_FAILED, never throws, and releases the lease', async () => {
    const { lease, rows } = leaseFor();
    const run = jest.fn<ReturnType<SweepFn>, Parameters<SweepFn>>(async () => {
      throw new Error('db timeout');
    });
    const r = await sweepWith(lease, run).runOnce(T0, 'machine-a');
    expect(r).toEqual({ ran: true, ok: false });
    expect(logLines(errorLog).some((l) => /^SFEE_SWEEP_FAILED alert=true/.test(l))).toBe(true);
    expect(rows[0].lease_until).toEqual(T0);
  });

  it('final transfer failures raise SFEE_SWEEP_TRANSFERS_FAILED', async () => {
    const { lease } = leaseFor();
    const run = jest.fn<ReturnType<SweepFn>, Parameters<SweepFn>>(async () => ({
      attempted: 2,
      succeeded: 1,
      failed: 1,
    }));
    await sweepWith(lease, run).runOnce(T0, 'machine-a');
    expect(
      logLines(errorLog).some((l) => /^SFEE_SWEEP_TRANSFERS_FAILED alert=true 1 transfer/.test(l)),
    ).toBe(true);
  });
});

describe('transfer failure codes', () => {
  const stripeErr = (code: string | null, message: string, status = 400) =>
    new StripeConnectApiError(message, status, code, 'invalid_request_error');

  it('classifies platform balance, restricted account and other failures', () => {
    expect(transferFailureCode(stripeErr('balance_insufficient', 'Insufficient funds'))).toBe(
      'SFEE_TRANSFER_PLATFORM_BALANCE_INSUFFICIENT',
    );
    expect(
      transferFailureCode(
        stripeErr(
          'insufficient_capabilities_for_transfer',
          'Your destination account needs to have at least one of the following capabilities enabled: transfers',
        ),
      ),
    ).toBe('SFEE_TRANSFER_ACCOUNT_RESTRICTED');
    expect(transferFailureCode(stripeErr('account_invalid', 'No such destination'))).toBe(
      'SFEE_TRANSFER_ACCOUNT_RESTRICTED',
    );
    expect(transferFailureCode(stripeErr(null, 'Stripe is down', 503))).toBe(
      'SFEE_TRANSFER_FAILED',
    );
    expect(transferFailureCode(new Error('socket hang up'))).toBe(TRANSFER_FAILURE_CODES.failed);
  });
});

// ---------------------------------------------------------------------------
// End to end with the settlement fakes: a coach transfer that failed once is
// retried by the sweep with backoff and paid exactly once, even when two
// sweeps overlap.
// ---------------------------------------------------------------------------

function purchaseRow(): ClientPurchase {
  const base: Row = {
    id: 'cp-1',
    coach_user_id: 'coach-1',
    client_user_id: 'client-1',
    package_id: 'pkg-1',
    amount_cents: 4_900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    source: null,
    stripe_payment_intent_id: null,
    stripe_subscription_id: 'sub_1',
    created_at: new Date('2026-10-01T12:00:00Z'),
  };
  return base as ClientPurchase;
}

function settlementSetup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(
    asPrisma(prisma),
    stripe,
    feePolicy,
    ledger,
    transfers,
  );
  const splits = new PurchaseSplitHandlerService(
    asPrisma(prisma),
    stripe,
    feePolicy,
    ledger,
    transfers,
    settlements,
  );
  db.accounts.push({ coach_user_id: 'coach-1', stripe_account_id: 'acct_coach' });
  const purchase = purchaseRow();
  db.purchases.push(purchase as Row);
  return { db, stripe, settlements, splits, transfers, purchase };
}

describe('sweep retries a failed coach transfer with backoff, exactly once', () => {
  it('first attempt fails (SFEE_TRANSFER_FAILED, backoff), two overlapping sweeps pay $46.30 once', async () => {
    const { db, stripe, settlements, splits, transfers, purchase } = settlementSetup();
    stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
    stripe.createTransfer.mockRejectedValueOnce(
      new StripeConnectApiError('Stripe is temporarily unavailable', 503, null, 'api_error'),
    );

    await settlements.settleCharge({ purchase, charge_id: 'ch_1' });
    const row = db.transfers.find((t) => t.kind === 'coach_net')!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(String(row.last_error)).toMatch(/^SFEE_TRANSFER_FAILED: /);
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(logLines(warnLog).some((l) => /^SFEE_TRANSFER_FAILED transfer=/.test(l))).toBe(true);

    // Not due yet: a sweep now does not retry it.
    const early = await splits.runTransferSweeper(new Date());
    expect(early.attempted).toBe(0);

    // Lease expired mid-run on one machine and a second machine started too:
    // both sweeps see the same due row. Stripe's idempotency key collapses
    // them; the coach is paid once.
    // First retry backoff is 5 minutes (BACKOFF_MINUTES[1]).
    const later = new Date(Date.now() + 6 * 60_000);
    // Round 8 (B-627-9): 6 minutes later is past the 5 minute in-flight
    // window of the first (unresolved) send.
    transfers.clock = () => later;
    await Promise.all([splits.runTransferSweeper(later), splits.runTransferSweeper(later)]);
    expect(stripe.netTo('acct_coach')).toBe(4_630);
    expect(new Set(stripe.createTransfer.mock.calls.map((c) => c[0].idempotencyKey)).size).toBe(1);
    expect(db.transfers.filter((t) => t.kind === 'coach_net')).toHaveLength(1);
    expect(db.transfers.find((t) => t.kind === 'coach_net')!.status).toBe('succeeded');

    // A further sweep finds nothing due.
    const again = await splits.runTransferSweeper(new Date(Date.now() + 60 * 60_000));
    expect(again.attempted).toBe(0);
  });

  it('restricted coach account: logged at error level with alert=true and the account code', async () => {
    const { db, stripe, settlements, purchase } = settlementSetup();
    stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
    stripe.createTransfer.mockRejectedValueOnce(
      new StripeConnectApiError(
        'Your destination account needs to have at least one of the following capabilities enabled: transfers',
        400,
        'insufficient_capabilities_for_transfer',
        'invalid_request_error',
      ),
    );
    await settlements.settleCharge({ purchase, charge_id: 'ch_1' });
    const row = db.transfers.find((t) => t.kind === 'coach_net')!;
    expect(String(row.last_error)).toMatch(/^SFEE_TRANSFER_ACCOUNT_RESTRICTED: /);
    expect(
      logLines(errorLog).some((l) =>
        /^SFEE_TRANSFER_ACCOUNT_RESTRICTED transfer=.* alert=true/.test(l),
      ),
    ).toBe(true);
  });

  it('a run past its deadline starts no new transfers and says so', async () => {
    const { stripe, settlements, splits, purchase } = settlementSetup();
    stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
    stripe.createTransfer.mockRejectedValueOnce(new Error('socket hang up'));
    await settlements.settleCharge({ purchase, charge_id: 'ch_1' });
    const later = new Date(Date.now() + 6 * 60_000);
    const r = await splits.runTransferSweeper(later, { deadlineAt: Date.now() - 1 });
    expect(r.attempted).toBe(0);
    expect(r.deadline_reached).toBe(true);
    expect(stripe.netTo('acct_coach')).toBe(0);
  });
});
