// Shared harness for the B-641-7 / B-641-8 refund reversal specs (B-COACH-5).
// Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the stateful Prisma double; only Stripe is
// synthetic, and it models key retention: a key creates one reversal while it
// is retained, and `expireKeys()` forgets every key, as Stripe may after 24 h.
import 'reflect-metadata';
import { RefundDisputeHandlerService } from '../../src/checkout/refund-dispute-handler.service';
import { SplitLedgerService } from '../../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../../src/connect/fees/transfer-orchestrator.service';
import { StatefulPrisma } from './stateful-prisma';

const COACH = 'coach-1';
export const HOUR = 60 * 60 * 1000;

export type Row = Record<string, unknown>;

export function refundRow(id: string, purchaseId: string, at: Date, extra: Row = {}): Row {
  return {
    id,
    stripe_refund_id: `re_${id}`,
    purchase_id: purchaseId,
    stripe_charge_id: `ch_${purchaseId}`,
    amount_cents: 2450,
    currency: 'usd',
    status: 'succeeded',
    posted_at: at,
    ledger_reversed: true,
    transfer_reversed: false,
    transfer_reversal_first_attempt_at: at,
    transfer_reversal_review_at: null,
    transfer_reversal_last_attempt_at: null,
    transfer_reversal_stripe_id: null,
    created_at: at,
    reason: null,
    note: null,
    initiated_by_user_id: null,
    failure_reason: null,
    ...extra,
  };
}

export function seedPurchase(db: StatefulPrisma, purchaseId: string, at: Date): void {
  db.state.clientPurchase.push({
    id: purchaseId,
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
    id: `${purchaseId}-${kind}`,
    purchase_id: purchaseId,
    kind,
    payee_user_id: payee,
    amount_cents: amount,
    reversed_cents: 0,
    currency: 'usd',
    status: 'posted',
    stripe_charge_id: `ch_${purchaseId}`,
    posted_at: at,
    reversed_at: null,
    created_at: at,
    updated_at: at,
  });
  db.state.splitLedgerEntry.push(
    slice('destination', 4802, COACH),
    slice('application_fee', 98, null),
  );
  db.state.connectTransfer.push({
    id: `tr-${purchaseId}`,
    purchase_id: purchaseId,
    stripe_transfer_id: `tr_${purchaseId}`,
    status: 'succeeded',
    amount_cents: 245,
    reversed_amount_cents: 0,
    ledger_entry_id: null,
    reversed_at: null,
  });
}

interface StripeReversal {
  id: string;
  transfer: string;
  amount: number;
  metadata: Record<string, string>;
}

export function harness() {
  const db = new StatefulPrisma();
  db.model('user');
  db.model('coachPackage');
  db.model('clientPurchase');
  db.model('chargeRefund', [['id'], ['stripe_refund_id'], ['transfer_reversal_stripe_id']], () => ({
    ledger_reversed: false,
    transfer_reversed: false,
    transfer_reversal_first_attempt_at: null,
    transfer_reversal_review_at: null,
    transfer_reversal_last_attempt_at: null,
    transfer_reversal_stripe_id: null,
  }));
  db.model('chargeDispute', [['id'], ['stripe_dispute_id'], ['transfer_reversal_stripe_id']]);
  db.model('splitLedgerEntry');
  db.model('splitLedgerReversal', [['id'], ['entry_id', 'source_kind', 'source_id']]);
  db.model('connectTransfer');
  db.model('connectAccount', [['id'], ['coach_user_id']]);
  db.model('guestCheckout');
  db.model('notification');
  db.state.user.push({ id: COACH, name: 'Coach One', email: 'coach@example.test' });
  db.state.coachPackage.push({ id: 'pkg-1', name: 'Monthly coaching', interval: 'month' });

  // Synthetic Stripe with key retention.
  const retained = new Map<string, StripeReversal>();
  const reversals: StripeReversal[] = [];
  let seq = 0;
  const reverseTransfer = jest.fn(
    async (args: {
      transfer_id: string;
      amount: number;
      idempotencyKey: string;
      metadata?: Record<string, string>;
    }) => {
      const hit = retained.get(args.idempotencyKey);
      if (hit) return hit;
      const made: StripeReversal = {
        id: `trr_${++seq}`,
        transfer: args.transfer_id,
        amount: args.amount,
        metadata: args.metadata ?? {},
      };
      retained.set(args.idempotencyKey, made);
      reversals.push(made);
      return made;
    },
  );
  const listTransferReversals = jest.fn(async (args: { transfer_id: string }) => ({
    data: reversals.filter((r) => r.transfer === args.transfer_id),
    has_more: false,
  }));
  const createRefund = jest.fn(async () => ({
    id: 're_r-late',
    status: 'succeeded',
    amount: 2450,
  }));
  const stripe = {
    reverseTransfer,
    listTransferReversals,
    createRefund,
    retrieveCharge: jest.fn(async () => ({ payment_intent: null })),
    retrievePaymentIntent: jest.fn(async () => ({ latest_charge: 'ch_p-late' })),
  };
  const ledger = Reflect.construct(SplitLedgerService, [db]);
  const transfers = Reflect.construct(TransferOrchestratorService, [db, stripe, ledger]);
  const alerts = jest.fn(async () => undefined);
  const svc: RefundDisputeHandlerService = Reflect.construct(RefundDisputeHandlerService, [
    db,
    stripe,
    ledger,
    transfers,
    { recordPayoutEvent: jest.fn() },
    { createNotification: alerts },
  ]);
  return {
    db,
    svc,
    reverseTransfer,
    reversals,
    expireKeys: () => retained.clear(),
    stripeTotal: (transferId: string) =>
      reversals.filter((r) => r.transfer === transferId).reduce((a, r) => a + r.amount, 0),
    headCoach: (purchaseId: string) =>
      Number(
        db.state.connectTransfer.find((t) => t.purchase_id === purchaseId)?.reversed_amount_cents,
      ),
    refund: (id: string) => db.state.chargeRefund.find((r) => r.id === id) as Row,
  };
}

// A refund whose Stripe reversal SUCCEEDED 25 hours ago under the
// refund-scoped key, but whose local record rolled back (transfer still owed
// locally). Stripe has since forgotten the key.
export async function staleOwedRefund() {
  const h = harness();
  const at = new Date(Date.now() - 25 * HOUR);
  seedPurchase(h.db, 'p-late', at);
  h.db.state.chargeRefund.push(
    refundRow('r-late', 'p-late', at, { stripe_refund_id: 're_r-late' }),
  );
  await h.reverseTransfer({
    transfer_id: 'tr_p-late',
    amount: 122,
    idempotencyKey: 'tgp-tr-rev-refund-r-late',
    metadata: { tgp_charge_refund_id: 'r-late' },
  });
  h.reverseTransfer.mockClear();
  h.expireKeys();
  return h;
}
