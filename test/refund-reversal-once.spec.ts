// B-641-7 (B-TRIALS-2, agent 114) — one refund reverses the books and the
// head-coach transfer exactly once, whichever paths complete it and however
// they overlap, and a failed or interrupted transfer reversal is retried with
// the same Stripe request instead of being lost or doubled.
//
// Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the stateful Prisma double (transactions
// run serially with rollback, which is how a row lock orders two claimers).
// Only the Stripe provider is synthetic; it behaves like Stripe idempotency:
// a repeated key returns the first reversal and creates nothing new.

import 'reflect-metadata';
import {
  REFUND_TRANSFER_RETRY_WINDOW_MS,
  RefundDisputeHandlerService,
  refundTransferReversalKey,
} from '../src/checkout/refund-dispute-handler.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StatefulPrisma } from './support/stateful-prisma';

const COACH = 'coach-1';

function store(): StatefulPrisma {
  const db = new StatefulPrisma();
  db.model('user');
  db.model('coachPackage');
  db.model('clientPurchase');
  db.model('chargeRefund', [['id'], ['stripe_refund_id']], () => ({
    ledger_reversed: false,
    transfer_reversed: false,
  }));
  db.model('chargeDispute'); // B-674-5: the sweep also retries lost chargebacks
  db.model('splitLedgerEntry');
  db.model('splitLedgerReversal', [['id'], ['entry_id', 'source_kind', 'source_id']]);
  db.model('connectTransfer');
  db.model('transferReversalOp', [['id'], ['idempotency_key'], ['stripe_reversal_id']], () => ({
    status: 'pending',
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    stripe_reversal_id: null,
    resolved_at: null,
  }));
  db.model('connectAccount', [['id'], ['coach_user_id']]);
  db.model('guestCheckout');
  db.model('notification');
  db.state.user.push({ id: COACH, name: 'Coach One', email: 'coach@example.test' });
  db.state.coachPackage.push({ id: 'pkg-1', name: 'Monthly coaching', interval: 'month' });
  const at = new Date();
  db.state.clientPurchase.push({
    id: 'p-1',
    coach_user_id: COACH,
    client_user_id: 'client-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    entitlement_active: true,
    source: null,
    canceled_at: null,
    last_error: null,
    stripe_payment_intent_id: null,
    created_at: at,
    updated_at: at,
  });
  const slice = (kind: string, amount: number, payee: string | null) => ({
    id: `p-1-${kind}`,
    purchase_id: 'p-1',
    kind,
    payee_user_id: payee,
    amount_cents: amount,
    reversed_cents: 0,
    currency: 'usd',
    status: 'posted',
    stripe_charge_id: 'ch_1',
    posted_at: at,
    reversed_at: null,
    created_at: at,
    updated_at: at,
  });
  db.state.splitLedgerEntry.push(
    slice('destination', 4802, COACH),
    slice('application_fee', 98, null),
  );
  // A pending partial refund (USD 24.50 of 49.00) that completes later.
  db.state.chargeRefund.push({
    id: 'refund-1',
    stripe_refund_id: 're_1',
    purchase_id: 'p-1',
    stripe_charge_id: 'ch_1',
    amount_cents: 2450,
    status: 'pending',
    posted_at: null,
    ledger_reversed: false,
    transfer_reversed: false,
    created_at: at,
    reason: null,
    note: null,
    initiated_by_user_id: null,
    failure_reason: null,
  });
  db.state.connectTransfer.push({
    id: 'tr-1',
    purchase_id: 'p-1',
    stripe_transfer_id: 'tr_synthetic',
    status: 'succeeded',
    amount_cents: 245,
    reversed_amount_cents: 0,
    ledger_entry_id: null,
    reversed_at: null,
    kind: 'head_coach_split',
    settlement_id: null,
    reversal_seq: 0,
  });
  return db;
}

interface Harness {
  db: StatefulPrisma;
  svc: RefundDisputeHandlerService;
  reverseTransfer: jest.Mock;
  stripeReversals: Map<string, number>;
  alerts: jest.Mock;
}

function harness(): Harness {
  const db = store();
  const ledger = Reflect.construct(SplitLedgerService, [db]);
  // Stripe idempotency: the first request per key creates the reversal;
  // a repeat returns it and creates nothing.
  const stripeReversals = new Map<string, number>();
  const reverseTransfer = jest.fn(async (args: { amount: number; idempotencyKey: string }) => {
    if (!stripeReversals.has(args.idempotencyKey)) {
      stripeReversals.set(args.idempotencyKey, args.amount);
    }
    return { id: `trr_${args.idempotencyKey}` };
  });
  // Stripe's reversal list (each carries its operation key in metadata).
  const listTransferReversals = jest.fn(async () => ({
    data: [...stripeReversals].map(([key, amount]) => ({
      id: `trr_${key}`,
      amount,
      metadata: { tgp_reversal_op: key },
    })),
    has_more: false,
  }));
  const transfers = Reflect.construct(TransferOrchestratorService, [
    db,
    { reverseTransfer, listTransferReversals },
    ledger,
  ]);
  const alerts = jest.fn(async () => undefined);
  const svc = Reflect.construct(RefundDisputeHandlerService, [
    db,
    {
      retrieveCharge: jest.fn(async () => ({ amount: 4900, payment_intent: null })),
      listChargeRefunds: jest.fn(async () => ({
        data: [{ id: 're_1', amount: 2450, currency: 'usd', status: 'succeeded' }],
        has_more: false,
      })),
    },
    ledger,
    transfers,
    { recordPayoutEvent: jest.fn() },
    { createNotification: alerts },
  ]);
  return { db, svc, reverseTransfer, stripeReversals, alerts };
}

const refundUpdated = {
  id: 'evt_updated',
  type: 'charge.refund.updated',
  data: { object: { id: 're_1', charge: 'ch_1', amount: 2450, status: 'succeeded' } },
};
const chargeRefunded = {
  id: 'evt_refunded',
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_1',
      amount: 4900,
      amount_refunded: 2450,
      refunded: false,
      refunds: { data: [{ id: 're_1', amount: 2450, status: 'succeeded' }] },
    },
  },
};

function destination(db: StatefulPrisma): number {
  return db.state.splitLedgerEntry.find((r) => r.id === 'p-1-destination')!.reversed_cents;
}
function headCoach(db: StatefulPrisma): number {
  return db.state.connectTransfer[0].reversed_amount_cents;
}
function refundRow(db: StatefulPrisma): Record<string, unknown> {
  return db.state.chargeRefund[0];
}
const stripeTotal = (h: Harness) => [...h.stripeReversals.values()].reduce((a, b) => a + b, 0);

describe('B-641-7 — one refund, one reversal', () => {
  it('charge.refund.updated and charge.refunded overlapping on one partial refund reverse it once', async () => {
    const h = harness();
    let reached!: () => void;
    let release!: () => void;
    const atLedger = new Promise<void>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const originalFind = h.db.splitLedgerEntry.findMany.bind(h.db.splitLedgerEntry);
    let first = true;
    h.db.splitLedgerEntry.findMany = async (...args: unknown[]) => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return Reflect.apply(originalFind, h.db.splitLedgerEntry, args);
    };
    // The newer path stops inside its ledger read; the older path runs
    // meanwhile; then the newer one resumes.
    const newer = h.svc.handle(refundUpdated);
    await atLedger;
    const older = h.svc.handle(chargeRefunded);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all([newer, older]);

    expect(destination(h.db)).toBe(2401);
    expect(headCoach(h.db)).toBe(122);
    expect(new Set(h.reverseTransfer.mock.calls.map((c) => c[0].idempotencyKey))).toEqual(
      new Set([refundTransferReversalKey('refund-1')]),
    );
    expect(stripeTotal(h)).toBe(122);
    expect(h.alerts).toHaveBeenCalledTimes(1);
    expect(refundRow(h.db)).toMatchObject({ ledger_reversed: true, transfer_reversed: true });
  });

  it('a redelivery after completion changes nothing', async () => {
    const h = harness();
    await h.svc.handle(refundUpdated);
    await h.svc.handle(chargeRefunded);
    await h.svc.handle(refundUpdated);
    expect(destination(h.db)).toBe(2401);
    expect(headCoach(h.db)).toBe(122);
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(h.alerts).toHaveBeenCalledTimes(1);
  });

  it('a failed Stripe reversal stays owed and the retry sweep reverses it once with the same key', async () => {
    const h = harness();
    h.reverseTransfer.mockRejectedValueOnce(new Error('stripe unavailable'));
    await h.svc.handle(refundUpdated);
    expect(destination(h.db)).toBe(2401);
    expect(headCoach(h.db)).toBe(0);
    expect(refundRow(h.db)).toMatchObject({ ledger_reversed: true, transfer_reversed: false });
    expect(h.alerts).toHaveBeenCalledTimes(1);

    const first = await h.svc.retryPendingTransferReversals();
    expect(first).toEqual({ retried: 1, reversed: 1, needs_review: 0, in_review: 0 });
    const second = await h.svc.retryPendingTransferReversals();
    expect(second).toEqual({ retried: 0, reversed: 0, needs_review: 0, in_review: 0 });

    expect(headCoach(h.db)).toBe(122);
    expect(stripeTotal(h)).toBe(122);
    expect(h.reverseTransfer.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([
      refundTransferReversalKey('refund-1'),
      refundTransferReversalKey('refund-1'),
    ]);
    expect(refundRow(h.db)).toMatchObject({ transfer_reversed: true });
    expect(destination(h.db)).toBe(2401);
    expect(h.alerts).toHaveBeenCalledTimes(1);
  });

  it('a stop between Stripe and the local record is recovered without a second reversal', async () => {
    const h = harness();
    // The operation's completion writes the transfer total (after Stripe).
    const originalUpdate = h.db.connectTransfer.update.bind(h.db.connectTransfer);
    let failNext = true;
    h.db.connectTransfer.update = async (...args: unknown[]) => {
      if (failNext) {
        failNext = false;
        throw new Error('process stopped');
      }
      return Reflect.apply(originalUpdate, h.db.connectTransfer, args);
    };
    await h.svc.handle(refundUpdated);
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(headCoach(h.db)).toBe(0);
    expect(refundRow(h.db)).toMatchObject({ transfer_reversed: false });

    // The sweep retries rows last attempted before its `now`: run it 1 s later.
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 1000));
    // The retry finds Stripe's reversal by its key and records it: no resend.
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(stripeTotal(h)).toBe(122);
    expect(headCoach(h.db)).toBe(122);
    expect(refundRow(h.db)).toMatchObject({ transfer_reversed: true });
  });

  it('a stop inside the ledger reversal rolls the claim back so the redelivery applies it once', async () => {
    const h = harness();
    // B-674-1: the reversal write is a compare-and-set updateMany.
    const originalUpdate = h.db.splitLedgerEntry.updateMany.bind(h.db.splitLedgerEntry);
    let failNext = true;
    h.db.splitLedgerEntry.updateMany = async (...args: unknown[]) => {
      if (failNext) {
        failNext = false;
        throw new Error('process stopped');
      }
      return Reflect.apply(originalUpdate, h.db.splitLedgerEntry, args);
    };
    await expect(h.svc.handle(refundUpdated)).rejects.toThrow('process stopped');
    expect(destination(h.db)).toBe(0);
    expect(refundRow(h.db)).toMatchObject({ ledger_reversed: false });
    expect(h.alerts).not.toHaveBeenCalled();

    await h.svc.handle(refundUpdated);
    expect(destination(h.db)).toBe(2401);
    expect(headCoach(h.db)).toBe(122);
    expect(h.alerts).toHaveBeenCalledTimes(1);
  });

  // B-674-3: transfer.reversed lands before the record on the webhook and
  // admin completion paths; the reversal is recorded once and its id bound.
  it.each(['charge.refund.updated', 'admin refund'])(
    'B-674-3: %s, webhook first, records 122 once',
    async (path) => {
      const h = harness();
      const provider = h.reverseTransfer.getMockImplementation()!;
      h.reverseTransfer.mockImplementation(async (args) => {
        const receipt = await provider(args);
        const object = { id: 'tr_synthetic', amount_reversed: stripeTotal(h), reversed: false };
        await h.svc.handle({ id: 'evt_rev', type: 'transfer.reversed', data: { object } });
        return receipt;
      });
      if (path === 'admin refund') {
        Reflect.get(h.svc, 'stripe').createRefund = async () => ({
          id: 're_1',
          amount: 2450,
          status: 'succeeded',
        });
        await h.svc.createAdminRefund({
          purchase_id: 'p-1',
          amount_cents: 2450,
          initiated_by_user_id: 'owner-1',
        });
      } else {
        await h.svc.handle(refundUpdated);
      }
      expect([stripeTotal(h), headCoach(h.db)]).toEqual([122, 122]);
      expect(refundRow(h.db)).toMatchObject({
        transfer_reversed: true,
        transfer_reversal_amount_cents: 122,
        transfer_reversal_stripe_id: `trr_${refundTransferReversalKey('refund-1')}`,
      });
    },
  );

  it('outside the Stripe idempotency window the sweep reports instead of reversing again', async () => {
    const h = harness();
    h.reverseTransfer.mockRejectedValueOnce(new Error('stripe unavailable'));
    await h.svc.handle(refundUpdated);
    const later = new Date(Date.now() + REFUND_TRANSFER_RETRY_WINDOW_MS + 60_000);
    const out = await h.svc.retryPendingTransferReversals(later);
    expect(out).toEqual({ retried: 0, reversed: 0, needs_review: 1, in_review: 1 });
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(headCoach(h.db)).toBe(0);
  });

  it('a refund with no head-coach transfer is marked done without a Stripe call', async () => {
    const h = harness();
    h.db.state.connectTransfer.length = 0;
    await h.svc.handle(refundUpdated);
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(refundRow(h.db)).toMatchObject({ ledger_reversed: true, transfer_reversed: true });
    expect(await h.svc.retryPendingTransferReversals()).toEqual({
      retried: 0,
      reversed: 0,
      needs_review: 0,
      in_review: 0,
    });
  });
});
