// B-641-7 (B-COACH-5, agent 115) — owner reconciliation of a head-coach
// transfer reversal in review: Stripe is the truth. See
// docs/runbooks/refund-transfer-reversal-review.md.

import 'reflect-metadata';
import * as Sentry from '@sentry/node';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { REFUND_TRANSFER_RETRY_WINDOW_MS } from '../src/checkout/refund-dispute-handler.service';
import {
  HOUR,
  harness,
  refundRow,
  seedPurchase,
  staleOwedRefund,
} from './support/refund-reversal-harness';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual('@sentry/node'),
  captureMessage: jest.fn(),
}));

const captureMessage = jest.mocked(Sentry.captureMessage);

beforeEach(() => captureMessage.mockClear());

describe('B-641-7 — owner reconcile of a row in review (Stripe is the truth)', () => {
  async function inReview() {
    const h = await staleOwedRefund();
    await h.svc.retryPendingTransferReversals();
    h.reverseTransfer.mockClear();
    return h;
  }

  it('records the reversal Stripe already holds for this refund, without a Stripe write', async () => {
    const h = await inReview();
    const out = await h.svc.reconcileTransferReversal('r-late');
    expect(out).toMatchObject({
      outcome: 'recorded_from_stripe',
      stripe_transfer_reversal_id: 'trr_1',
      amount_cents: 122,
    });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.headCoach('p-late')).toBe(122);
    expect(h.refund('r-late').transfer_reversed).toBe(true);
    // A second owner click is refused with a specific code.
    await expect(h.svc.reconcileTransferReversal('r-late')).rejects.toMatchObject({
      response: { code: 'REFUND_TRANSFER_REVERSAL_ALREADY_RECORDED' },
    });
  });

  it('sends one new reversal under a review-scoped key when Stripe holds none', async () => {
    const h = harness();
    const at = new Date(Date.now() - 25 * HOUR);
    seedPurchase(h.db, 'p-x', at);
    h.db.state.chargeRefund.push(refundRow('r-x', 'p-x', at));
    await h.svc.retryPendingTransferReversals();
    const [a, b] = await Promise.all([
      h.svc.reconcileTransferReversal('r-x'),
      h.svc
        .reconcileTransferReversal('r-x')
        .catch((e: { response?: { code?: string } }) => e.response?.code),
    ]);
    expect(a).toMatchObject({ outcome: 'reversed', amount_cents: 122 });
    // The second owner either sees the record already made or loses the claim.
    expect(['REFUND_TRANSFER_REVERSAL_ALREADY_RECORDED', 'already_recorded']).toContain(
      typeof b === 'string' ? b : (b as { outcome: string }).outcome,
    );
    expect(h.stripeTotal('tr_p-x')).toBe(122);
    expect(h.headCoach('p-x')).toBe(122);
    expect(new Set(h.reverseTransfer.mock.calls.map((c) => c[0].idempotencyKey))).toEqual(
      new Set(['tgp-tr-rev-refund-r-x-review']),
    );
  });

  it('refuses when Stripe holds an unattributed reversal, until the owner names it or confirms none', async () => {
    const h = harness();
    const at = new Date(Date.now() - 25 * HOUR);
    seedPurchase(h.db, 'p-u', at);
    h.db.state.chargeRefund.push(refundRow('r-u', 'p-u', at));
    // Made by hand in the Dashboard: no tgp_charge_refund_id.
    await h.reverseTransfer({ transfer_id: 'tr_p-u', amount: 122, idempotencyKey: 'dashboard-1' });
    await h.svc.retryPendingTransferReversals();
    h.reverseTransfer.mockClear();
    await expect(h.svc.reconcileTransferReversal('r-u')).rejects.toMatchObject({
      response: {
        code: 'TRANSFER_REVERSAL_UNATTRIBUTED',
        unattributed: [{ id: 'trr_1', amount_cents: 122 }],
      },
    });
    await expect(
      h.svc.reconcileTransferReversal('r-u', { stripe_transfer_reversal_id: 'trr_404' }),
    ).rejects.toMatchObject({ response: { code: 'TRANSFER_REVERSAL_NOT_FOUND' } });
    const out = await h.svc.reconcileTransferReversal('r-u', {
      stripe_transfer_reversal_id: 'trr_1',
    });
    expect(out).toMatchObject({ outcome: 'recorded_from_stripe', amount_cents: 122 });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.headCoach('p-u')).toBe(122);
  });

  it('refuses a reversal that names another refund, and a row still inside the window', async () => {
    const h = await inReview();
    await h.reverseTransfer({
      transfer_id: 'tr_p-late',
      amount: 10,
      idempotencyKey: 'other',
      metadata: { tgp_charge_refund_id: 'r-other' },
    });
    await expect(
      h.svc.reconcileTransferReversal('r-late', { stripe_transfer_reversal_id: 'trr_2' }),
    ).rejects.toMatchObject({ response: { code: 'TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND' } });

    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-w', at);
    h.db.state.chargeRefund.push(refundRow('r-w', 'p-w', at));
    await expect(h.svc.reconcileTransferReversal('r-w')).rejects.toMatchObject({
      response: { code: 'REFUND_TRANSFER_REVERSAL_NOT_IN_REVIEW' },
    });
    await expect(h.svc.reconcileTransferReversal('r-missing')).rejects.toMatchObject({
      response: { code: 'REFUND_NOT_FOUND' },
    });
  });

  it('lists rows in review oldest first with ids only', async () => {
    const h = await inReview();
    const rows = await h.svc.listTransferReversalsInReview();
    expect(rows).toEqual([
      expect.objectContaining({
        charge_refund_id: 'r-late',
        purchase_id: 'p-late',
        amount_cents: 2450,
      }),
    ]);
  });

  it('every new reversal request carries the refund id in Stripe metadata', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-m', at);
    h.db.state.chargeRefund.push(
      refundRow('r-m', 'p-m', at, { transfer_reversal_first_attempt_at: null }),
    );
    await h.svc.retryPendingTransferReversals(
      new Date(Date.now() + REFUND_TRANSFER_RETRY_WINDOW_MS * 2),
    );
    expect(h.reverseTransfer.mock.calls[0][0].metadata).toEqual({
      tgp_charge_refund_id: 'r-m',
      tgp_purchase_id: 'p-m',
    });
  });
});

describe('B-641-7 — owner reconcile route', () => {
  function controller() {
    const reconcileTransferReversal = jest.fn(async () => ({ outcome: 'reversed' }));
    const refundDispute = {
      reconcileTransferReversal,
      listTransferReversalsInReview: jest.fn(async () => []),
    };
    const ctrl: AdminPaymentOpsController = Reflect.construct(AdminPaymentOpsController, [
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      refundDispute,
      {},
      {},
    ]);
    return { ctrl, reconcileTransferReversal };
  }

  it.each([
    [{ stripe_transfer_reversal_id: 'tr_wrong' }],
    [{ stripe_transfer_reversal_id: 42 }],
    [{ confirm_none_in_stripe: 'yes' }],
  ])('refuses a malformed body %j with RECONCILE_BODY_INVALID', async (body) => {
    const { ctrl, reconcileTransferReversal } = controller();
    await expect(ctrl.reconcileRefundReversal('r-1', body)).rejects.toMatchObject({
      response: { code: 'RECONCILE_BODY_INVALID' },
    });
    expect(reconcileTransferReversal).not.toHaveBeenCalled();
  });

  it('forwards a valid body to the service', async () => {
    const { ctrl, reconcileTransferReversal } = controller();
    await ctrl.reconcileRefundReversal('r-1', { stripe_transfer_reversal_id: 'trr_1' });
    await ctrl.reconcileRefundReversal('r-2', {});
    expect(reconcileTransferReversal.mock.calls).toEqual([
      ['r-1', { stripe_transfer_reversal_id: 'trr_1', confirm_none_in_stripe: false }],
      ['r-2', { stripe_transfer_reversal_id: undefined, confirm_none_in_stripe: false }],
    ]);
  });
});
