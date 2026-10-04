// S-FEE round 8 — audit finding at 7c29d981 (Opus comment 5964167264):
//   B-627-9  "absent" is not proof of non-execution while another worker's
//            create is in flight. The sweeper called attempt(row.id) with no
//            charge fence while the inline settlement path held the charge
//            lock; worker B could read the marker during worker A's in-flight
//            create, list Stripe (absent), hit attempts >= max_attempts and
//            mark the row failed with a repay alert, while A's transfer
//            executed. markFailed and recordPosted were unconditional
//            `update where {id}`, so either ordering ended with money paid and
//            a repay alert (the operator could pay the coach twice).
//            Fix: (a) a marker younger than the in-flight window (Stripe
//            client timeout + margin, 5 min) is held: nothing sent, nothing
//            failed, re-checked after the window; (b) every outcome write is
//            a compare-and-set on {pending, no Stripe transfer, the claimed
//            attempt}, recordPosted never regresses a row, a lost CAS re-reads
//            and keeps the winner's result; (c) the sweeper and the legacy
//            inline attempt take the same per-charge lock + fence as the
//            inline settlement path.
// The two probe orderings (ops/aud-opus-114/627-probe.spec.ts) are the first
// two tests, with the assertions inverted to the correct outcome. Each test in
// the first three blocks fails on 7c29d981. No live Stripe or DB.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import {
  ChargeSettlementService,
  SWEEP_TRANSFER_LOCK_WAIT_MS,
} from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import {
  TRANSFER_IN_FLIGHT_MARGIN_MS,
  TransferOrchestratorService,
  transferInFlightWindowMs,
} from '../src/connect/fees/transfer-orchestrator.service';
import { STRIPE_CONNECT_TIMEOUT_MS } from '../src/connect/stripe-connect-api.service';
import {
  FakeStripe,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

const COACH = 'coach-1';
const HOUR = 3_600_000;

let errorLog: jest.SpyInstance;
let warnLog: jest.SpyInstance;
beforeEach(() => {
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const lines = (spy: jest.SpyInstance): string[] => spy.mock.calls.map((c) => String(c[0]));
const repayAlerts = () => lines(errorLog).filter((l) => /^SFEE_TRANSFER_FAILED alert=true/.test(l));
const tick = () => new Promise((r) => setImmediate(r));

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
  const splits = new PurchaseSplitHandlerService(
    asPrisma(prisma),
    stripe,
    feePolicy,
    ledger,
    transfers,
    svc,
  );
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  const purchase = {
    id: 'purchase-1',
    coach_user_id: COACH,
    client_user_id: 'client-1',
    package_id: 'package-1',
    amount_cents: 10_000,
    currency: 'usd',
    billing_type: 'one_time',
    status: 'paid',
    entitlement_active: true,
    stripe_payment_intent_id: 'pi_ch_1',
    source: null,
    created_at: new Date(),
  } as Row as ClientPurchase;
  db.purchases.push(purchase as Row);
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 10_000, fee: 320 }));
  // $100 sale, $3.20 fee, a full dispute ($15 fee), then the dispute is won:
  // the coach's $94.80 is reinstated by a transfer with no source charge.
  // `beforeWin` sets the Stripe failure the reinstatement send meets.
  const sellDisputeWin = async (beforeWin: (s: FakeStripe) => void = () => undefined) => {
    await svc.settleCharge({ purchase, charge_id: 'ch_1' });
    await svc.applyAdjustments({
      purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 10_000, fee_cents: 1_500 },
    });
    beforeWin(stripe);
    await svc.applyAdjustments({
      purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 0, fee_cents: 0 },
    });
  };
  const row = (kind: string) => db.transfers.find((t) => t.kind === kind)!;
  const reinstatements = () =>
    stripe.transfers.filter((t) => !t.source_transaction && /reinstate/.test(t.metadata.tgp_kind));
  const createsFor = (key: string) =>
    stripe.createTransfer.mock.calls.filter(([a]) => a.idempotencyKey === key).length;
  const at = (ms: number) => {
    const d = new Date(Date.now() + ms);
    transfers.clock = () => d;
    return d;
  };
  // Worker A's create: enters, then waits at `gate`. before = the request is
  // travelling to Stripe (not executed yet); after = Stripe executed it and
  // the response is travelling back.
  const gateCreate = (when: 'before' | 'after') => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => (entered = r));
    const real = stripe.createTransfer.getMockImplementation()!;
    stripe.createTransfer.mockImplementationOnce(async (args) => {
      if (when === 'before') {
        entered();
        await gate;
        return real(args);
      }
      const t = await real(args);
      entered();
      await gate;
      return t;
    });
    return { release, inFlight };
  };
  return {
    prisma,
    db,
    stripe,
    transfers,
    svc,
    splits,
    purchase,
    sellDisputeWin,
    row,
    reinstatements,
    createsFor,
    at,
    gateCreate,
  };
}

// The probe's starting point: the first reinstatement send failed before
// execution (marker set), the row is aged (25 h, keys pruned) and one attempt
// is left.
async function agedLastAttempt() {
  const c = setup();
  await c.sellDisputeWin((s) => (s.transferNetworkFailures = 1));
  const r = c.row('coach_reinstate');
  expect(r.status).toBe('pending');
  expect(r.stripe_send_unresolved_at).toBeInstanceOf(Date);
  r.attempts = r.max_attempts - 1;
  c.stripe.expireIdempotencyKeys();
  c.at(25 * HOUR);
  return { c, r };
}

describe('B-627-9 a peer create in flight is never "proven absent" (Opus probe orderings)', () => {
  it('ordering 1: worker B reads while A sends the last attempt: B holds, A pays once, no repay alert', async () => {
    const { c, r } = await agedLastAttempt();
    const g = c.gateCreate('before');
    const a = c.transfers.attempt(r.id); // A: old marker, absent, claims attempt 6, sends
    await g.inFlight;
    const b = await c.transfers.attempt(r.id); // B: A's marker is young
    expect(b.status).toBe('pending');
    expect(c.row('coach_reinstate').status).toBe('pending');
    g.release();
    const aRes = await a;

    const fresh = c.row('coach_reinstate');
    expect(aRes.status).toBe('succeeded');
    expect(fresh.status).toBe('succeeded');
    expect(fresh.stripe_transfer_id).toBe(c.reinstatements()[0].id);
    expect(c.reinstatements()).toHaveLength(1);
    expect(c.createsFor(r.idempotency_key)).toBe(2); // the lost first send + A's
    expect(repayAlerts()).toHaveLength(0);
    expect(lines(errorLog).some((l) => /SFEE_TRANSFER_FAILED/.test(l))).toBe(false);
    expect(
      lines(warnLog).some((l) =>
        /^SFEE_TRANSFER_IN_FLIGHT transfer=.* attempt=6\/6 .*lookup=absent: .*nothing sent, nothing failed/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it('ordering 2: A records before B writes: the paid transfer ends succeeded, never failed', async () => {
    const { c, r } = await agedLastAttempt();
    const g = c.gateCreate('before');
    // Hold every outcome write B could make (fail / re-check) until A has
    // recorded its receipt, so B's write lands on a row A already moved.
    const real = c.prisma.connectTransfer.updateMany.getMockImplementation()!;
    const realUpdate = c.prisma.connectTransfer.update.getMockImplementation()!;
    let aDone!: () => void;
    const aRecorded = new Promise<void>((res) => (aDone = res));
    const isBWrite = (data: Row) =>
      data.status === 'failed' ||
      (!('status' in data) && !('attempts' in data) && 'next_attempt_at' in data);
    c.prisma.connectTransfer.updateMany.mockImplementation(async (args) => {
      if (isBWrite(args.data)) await aRecorded;
      const out = await real(args);
      if (args.data.status === 'succeeded' && out.count === 1) aDone();
      return out;
    });
    c.prisma.connectTransfer.update.mockImplementation(async (args) => {
      if (isBWrite(args.data)) await aRecorded;
      const out = await realUpdate(args);
      if (args.data.status === 'succeeded') aDone();
      return out;
    });
    const a = c.transfers.attempt(r.id);
    await g.inFlight;
    const b = c.transfers.attempt(r.id); // reads + lists while A's request is in transit
    await tick();
    await tick();
    g.release();
    const [aRes, bRes] = await Promise.all([a, b]);

    const fresh = c.row('coach_reinstate');
    expect(c.reinstatements()).toHaveLength(1);
    expect(fresh.stripe_transfer_id).toBe(c.reinstatements()[0].id);
    expect(fresh.status).toBe('succeeded');
    expect(aRes.status).toBe('succeeded');
    expect(bRes.status).toBe('succeeded'); // B's lost CAS re-read A's result
    expect(fresh.next_attempt_at).toBeNull();
    expect(repayAlerts()).toHaveLength(0);
    expect(
      lines(warnLog).some((l) => /^SFEE_TRANSFER_OUTCOME_SUPERSEDED .*wanted=recheck/.test(l)),
    ).toBe(true);
  });
});

describe('B-627-9 (a) the in-flight window', () => {
  it('is the Stripe client timeout plus the margin: 5 minutes at the default 10 s timeout', () => {
    const c = setup();
    expect(STRIPE_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(c.stripe.requestTimeoutMs).toBe(STRIPE_CONNECT_TIMEOUT_MS);
    expect(c.transfers.inFlightWindowMs).toBe(5 * 60_000);
    expect(transferInFlightWindowMs(60_000)).toBe(60_000 + TRANSFER_IN_FLIGHT_MARGIN_MS);
    // A misconfigured timeout never shrinks the window below the default.
    expect(transferInFlightWindowMs(Number.NaN)).toBe(5 * 60_000);
    expect(transferInFlightWindowMs(0)).toBe(5 * 60_000);
  });

  it('young marker at the attempt budget: no send, no failure, re-check at marker + window; after it the attempt is adopted (round 9)', async () => {
    const c = setup();
    await c.sellDisputeWin((s) => (s.transferNetworkFailures = 1));
    const r = c.row('coach_reinstate');
    r.max_attempts = 1; // the one send used the whole budget
    const marker: Date = r.stripe_send_unresolved_at;
    c.at(4 * 60_000); // 4 minutes after the send: still in flight

    const held = await c.transfers.attempt(r.id);
    expect(held.status).toBe('pending');
    expect(c.row('coach_reinstate').status).toBe('pending');
    expect(c.row('coach_reinstate').stripe_send_unresolved_at).toEqual(marker);
    expect(c.row('coach_reinstate').next_attempt_at.getTime()).toBe(
      marker.getTime() + c.transfers.inFlightWindowMs,
    );
    expect(c.createsFor(r.idempotency_key)).toBe(1);
    expect(repayAlerts()).toHaveLength(0);
    // Not due for the sweeper until the window has passed.
    const early = await c.transfers.findDueTransfers(new Date(marker.getTime() + 4.5 * 60_000));
    expect(early.map((t) => t.id)).not.toContain(r.id);

    // Round 9 (B-627-9 narrowed): after the window an empty listing is still
    // not proof (a paused sender may start its request later), so the
    // unresolved attempt is adopted: re-sent under the same key. It pays.
    c.at(6 * 60_000);
    const adopted = await c.transfers.attempt(r.id);
    expect(adopted.status).toBe('succeeded');
    expect(c.row('coach_reinstate').stripe_send_unresolved_at).toBeNull();
    expect(c.row('coach_reinstate').attempts).toBe(1);
    expect(c.createsFor(r.idempotency_key)).toBe(2);
    expect(c.reinstatements()).toHaveLength(1);
    expect(repayAlerts()).toHaveLength(0);
  });

  it('young marker with budget left: no re-send inside the window (an expired key would mint a second transfer)', async () => {
    const c = setup();
    await c.sellDisputeWin((s) => (s.transferNetworkFailures = 1));
    const r = c.row('coach_reinstate');
    c.stripe.expireIdempotencyKeys();
    c.at(60_000);
    await c.transfers.attempt(r.id);
    await c.transfers.attempt(r.id);
    expect(c.createsFor(r.idempotency_key)).toBe(1);
    expect(c.row('coach_reinstate').attempts).toBe(1);
    expect(c.row('coach_reinstate').status).toBe('pending');
  });

  it('young marker, transfer already visible at Stripe: recorded at once (found is always safe), nothing sent', async () => {
    const c = setup();
    // The sender could not see it: response lost, listing down.
    await c.sellDisputeWin((s) => {
      s.transferResponsesLost = 1;
      s.failListTransfers = true;
    });
    const r = c.row('coach_reinstate');
    expect(r.status).toBe('pending');
    c.stripe.failListTransfers = false;
    c.at(30_000);
    const out = await c.transfers.attempt(r.id);
    expect(out.status).toBe('succeeded');
    expect(c.createsFor(r.idempotency_key)).toBe(1);
    expect(c.reinstatements()).toHaveLength(1);
  });
});

describe('B-627-9 (b) every outcome write is a compare-and-set', () => {
  it('a final failure that loses to a concurrent receipt: no failed status, no ledger failure, no repay alert', async () => {
    const c = setup();
    c.stripe.transferNetworkFailures = 1;
    await c.svc.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    const r = c.row('coach_net');
    expect(r.status).toBe('pending');
    expect(r.stripe_send_unresolved_at).toBeInstanceOf(Date);
    r.max_attempts = r.attempts; // budget spent
    // Round 9: the final failure without Stripe's answer is reached only when
    // no create is unresolved (an unresolved one is adopted instead).
    r.stripe_send_unresolved_at = null;
    c.at(25 * HOUR);
    // Between B's read and B's write, another worker records the transfer.
    const real = c.prisma.connectTransfer.updateMany.getMockImplementation()!;
    c.prisma.connectTransfer.updateMany.mockImplementation(async (args) => {
      if (args.data.status === 'failed') {
        const live = c.row('coach_net');
        live.status = 'succeeded';
        live.stripe_transfer_id = 'tr_peer';
        live.stripe_send_unresolved_at = null;
        c.db.ledger.find((l) => l.id === live.ledger_entry_id)!.status = 'posted';
      }
      return real(args);
    });
    const out = await c.transfers.attempt(r.id);
    expect(out.status).toBe('succeeded');
    expect(out.stripe_transfer_id).toBe('tr_peer');
    expect(c.row('coach_net').status).toBe('succeeded');
    expect(c.db.ledger.find((l) => l.id === r.ledger_entry_id)!.status).toBe('posted');
    expect(repayAlerts()).toHaveLength(0);
    expect(
      lines(warnLog).some((l) =>
        /^SFEE_TRANSFER_OUTCOME_SUPERSEDED .*wanted=failed .*status=succeeded/.test(l),
      ),
    ).toBe(true);
  });

  it('a stale success response never regresses a row another worker recorded and then reversed', async () => {
    const c = setup();
    await c.sellDisputeWin((s) => (s.transferNetworkFailures = 1));
    const r = c.row('coach_reinstate');
    c.stripe.expireIdempotencyKeys();
    c.at(25 * HOUR);
    const g = c.gateCreate('after'); // Stripe executes A's create; A's response is late
    const a = c.transfers.attempt(r.id);
    await g.inFlight;
    // B finds the transfer at Stripe and records it; then it is reversed.
    const b = await c.transfers.attempt(r.id);
    expect(b.status).toBe('succeeded');
    const live = c.row('coach_reinstate');
    const postedAt: Date = live.posted_at;
    live.status = 'reversed';
    live.reversed_amount_cents = live.amount_cents;
    g.release();
    const aRes = await a;
    expect(aRes.status).toBe('reversed');
    expect(c.row('coach_reinstate').status).toBe('reversed');
    expect(c.row('coach_reinstate').posted_at).toBe(postedAt);
    expect(c.reinstatements()).toHaveLength(1);
    expect(
      lines(warnLog).some((l) => /^SFEE_TRANSFER_OUTCOME_SUPERSEDED .*wanted=posted/.test(l)),
    ).toBe(true);
  });

  it('a row marked failed while Stripe holds its transfer is recovered as paid with a do-not-repay alert', async () => {
    const c = setup();
    c.stripe.transferResponsesLost = 1;
    c.stripe.failListTransfers = true;
    await c.svc.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    const r = c.row('coach_net');
    // Pre-fix data: a superseded worker marked it failed, marker kept.
    r.status = 'failed';
    c.db.ledger.find((l) => l.id === r.ledger_entry_id)!.status = 'failed';
    c.stripe.failListTransfers = false;
    c.at(25 * HOUR);
    const out = await c.transfers.attempt(r.id);
    expect(out.status).toBe('succeeded');
    expect(out.stripe_transfer_id).toBe(c.stripe.transfers[0].id);
    expect(c.db.ledger.find((l) => l.id === r.ledger_entry_id)!.status).toBe('posted');
    expect(c.createsFor(r.idempotency_key)).toBe(1);
    expect(
      lines(errorLog).some((l) =>
        /^SFEE_TRANSFER_RECOVERED alert=true .*amount=9480 .*Do not repay/.test(l),
      ),
    ).toBe(true);
  });

  it('a duplicate Stripe transfer for one row is never written over the recorded one; it alerts', async () => {
    const c = setup();
    await c.sellDisputeWin((s) => (s.transferNetworkFailures = 1));
    const r = c.row('coach_reinstate');
    c.at(25 * HOUR);
    const g = c.gateCreate('after');
    const a = c.transfers.attempt(r.id);
    await g.inFlight;
    // Another receipt (a different Stripe transfer) lands first.
    const live = c.row('coach_reinstate');
    live.status = 'succeeded';
    live.stripe_transfer_id = 'tr_other';
    g.release();
    const aRes = await a;
    expect(aRes.stripe_transfer_id).toBe('tr_other');
    expect(c.row('coach_reinstate').stripe_transfer_id).toBe('tr_other');
    expect(
      lines(errorLog).some((l) =>
        /^SFEE_TRANSFER_DUPLICATE alert=true .*recorded_stripe_transfer=tr_other also_at_stripe=tr_/.test(
          l,
        ),
      ),
    ).toBe(true);
  });
});

describe('B-627-9 old marker: looked up, then acted on', () => {
  it('old marker, transfer at Stripe: receipt repaired, nothing re-sent', async () => {
    const c = setup();
    await c.sellDisputeWin((s) => {
      s.transferResponsesLost = 1;
      s.failListTransfers = true;
    });
    const r = c.row('coach_reinstate');
    c.stripe.failListTransfers = false;
    c.stripe.expireIdempotencyKeys();
    c.at(25 * HOUR);
    const out = await c.transfers.attempt(r.id);
    expect(out.status).toBe('succeeded');
    expect(c.createsFor(r.idempotency_key)).toBe(1);
    expect(c.reinstatements()).toHaveLength(1);
  });

  it('old marker, proven absent with budget left: re-sent exactly once', async () => {
    const c = setup();
    await c.sellDisputeWin((s) => (s.transferNetworkFailures = 1));
    const r = c.row('coach_reinstate');
    c.stripe.expireIdempotencyKeys();
    c.at(25 * HOUR);
    const out = await c.transfers.attempt(r.id);
    expect(out.status).toBe('succeeded');
    expect(c.createsFor(r.idempotency_key)).toBe(2);
    expect(c.reinstatements()).toHaveLength(1);
  });
});

// The settlement sweep (already under the charge lock) also re-converges
// settlements and may post their transfers; these tests isolate the
// transfer-retry loop that B-627-9 found unfenced.
function transferLoopOnly(c: ReturnType<typeof setup>) {
  jest.spyOn(c.svc, 'runSettlementSweep').mockResolvedValue({
    retried: 0,
    backfilled: 0,
    settled: 0,
    invoices_scanned: 0,
    invoices_backfilled: 0,
    stale_awaiting: 0,
    stale_transfers: 0,
    reversals_resolved: 0,
    reconciled: 0,
    open_recovery_payees: 0,
  });
}

describe('B-627-9 (c) the sweeper takes the charge lock the inline path takes', () => {
  it('while another worker holds the charge lock the sweeper sends nothing; the next run posts it once', async () => {
    const c = setup();
    c.stripe.transferNetworkFailures = 1;
    await c.svc.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    const r = c.row('coach_net');
    expect(r.status).toBe('pending');
    const later = c.at(25 * HOUR);
    transferLoopOnly(c);
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const isLocked = new Promise<void>((res) => (locked = res));
    const holder = c.svc.withChargeLock('ch_1', async () => {
      locked();
      await held;
    });
    await isLocked;
    const busy = await c.splits.runTransferSweeper(later);
    expect(busy.attempted).toBe(1);
    expect(busy.succeeded).toBe(0);
    expect(c.createsFor(r.idempotency_key)).toBe(1);
    expect(c.row('coach_net').status).toBe('pending');
    expect(
      lines(warnLog).some((l) => /^SFEE_TRANSFER_DEFERRED transfer=.* charge=ch_1: /.test(l)),
    ).toBe(true);
    release();
    await holder;
    const next = await c.splits.runTransferSweeper(later);
    expect(next.succeeded).toBe(1);
    expect(c.row('coach_net').status).toBe('succeeded');
    expect(c.createsFor(r.idempotency_key)).toBe(2);
    expect(c.stripe.netTo('acct_coach')).toBe(c.row('coach_net').amount_cents);
  });

  it('a reinstatement (no source charge) is fenced on its settlement charge', async () => {
    const c = setup();
    await c.sellDisputeWin((s) => (s.transferNetworkFailures = 1));
    const r = c.row('coach_reinstate');
    const later = c.at(25 * HOUR);
    transferLoopOnly(c);
    const runSpy = jest.spyOn(c.svc.chargeLock, 'run');
    const res = await c.splits.runTransferSweeper(later);
    expect(res.attempted).toBe(1);
    expect(
      runSpy.mock.calls.some(
        ([charge, , wait]) => charge === 'ch_1' && wait === SWEEP_TRANSFER_LOCK_WAIT_MS,
      ),
    ).toBe(true);
    expect(c.row('coach_reinstate').status).toBe('succeeded');
    expect(c.createsFor(r.idempotency_key)).toBe(2);
  });
});
