// B-641-7 (narrowed) + B-641-8 (B-COACH-5, agent 115) — the 23-hour retry
// admission for head-coach transfer reversals is enforced on the ONE shared
// path, for every caller (late charge.refund.updated, admin re-entry, the
// sweep, overlapping sweeps on several instances), and rows past the window
// leave the retry batch so fresh refunds are never starved.
//
// Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the stateful Prisma double (which honors
// orderBy / take / cursor like production Prisma). Only Stripe is synthetic,
// and it models key retention: a key creates one reversal while it is
// retained; `expireKeys()` forgets every key, as Stripe may after 24 hours.

import 'reflect-metadata';
import * as Sentry from '@sentry/node';
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

describe('B-641-7 — one shared 23-hour admission for every caller', () => {
  it('a late charge.refund.updated after the key expired sends nothing and moves the refund to review', async () => {
    const h = await staleOwedRefund();
    await h.svc.handle({
      id: 'evt_late',
      type: 'charge.refund.updated',
      data: { object: { id: 're_r-late', charge: 'ch_p-late', amount: 2450, status: 'succeeded' } },
    });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.stripeTotal('tr_p-late')).toBe(122);
    expect(h.refund('r-late').transfer_reversed).toBe(false);
    expect(h.refund('r-late').transfer_reversal_review_at).toBeInstanceOf(Date);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('an admin re-entry of the same refund after the key expired sends nothing', async () => {
    const h = await staleOwedRefund();
    await h.svc.createAdminRefund({
      purchase_id: 'p-late',
      amount_cents: 2450,
      reason: 'requested_by_customer',
      initiated_by_user_id: 'owner-1',
    });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.stripeTotal('tr_p-late')).toBe(122);
    expect(h.refund('r-late').transfer_reversal_review_at).toBeInstanceOf(Date);
  });

  it('the sweep moves an expired row to review and alerts once, however many runs see it', async () => {
    const h = await staleOwedRefund();
    const first = await h.svc.retryPendingTransferReversals();
    const second = await h.svc.retryPendingTransferReversals();
    expect(first).toMatchObject({ retried: 0, reversed: 0, needs_review: 1, in_review: 1 });
    expect(second).toMatchObject({ retried: 0, reversed: 0, needs_review: 0, in_review: 1 });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = captureMessage.mock.calls[0];
    expect(message).toBe('head-coach transfer reversal needs operator review');
    // Ids and codes only reach Sentry.
    expect(JSON.stringify(context)).not.toMatch(/coach@example|Coach One|client-1/);
    expect(context).toMatchObject({
      level: 'error',
      tags: { code: 'REFUND_TRANSFER_REVERSAL_REVIEW' },
      extra: { charge_refund_id: 'r-late', purchase_id: 'p-late' },
    });
  });

  it('a refund that was never sent is admitted however old its success is, and stamps its first attempt', async () => {
    const h = harness();
    const at = new Date(Date.now() - 40 * HOUR);
    seedPurchase(h.db, 'p-new', at);
    h.db.state.chargeRefund.push(
      refundRow('r-new', 'p-new', at, { transfer_reversal_first_attempt_at: null }),
    );
    const out = await h.svc.retryPendingTransferReversals();
    expect(out).toMatchObject({ retried: 1, reversed: 1, needs_review: 0 });
    expect(h.stripeTotal('tr_p-new')).toBe(122);
    expect(h.headCoach('p-new')).toBe(122);
    expect(h.refund('r-new').transfer_reversal_first_attempt_at).toBeInstanceOf(Date);
  });

  it('two sweeps on two instances overlapping on one owed refund reverse it once', async () => {
    const h = harness();
    const at = new Date(Date.now() - 2 * HOUR);
    seedPurchase(h.db, 'p-2', at);
    h.db.state.chargeRefund.push(refundRow('r-2', 'p-2', at));
    await Promise.all([
      h.svc.retryPendingTransferReversals(),
      h.svc.retryPendingTransferReversals(),
    ]);
    expect(h.stripeTotal('tr_p-2')).toBe(122);
    expect(h.headCoach('p-2')).toBe(122);
    expect(h.refund('r-2').transfer_reversed).toBe(true);
  });
});

describe('B-641-8 — expired rows never starve fresh recoverable refunds', () => {
  it('a fresh owed refund behind more than one batch of expired rows is reversed in the first run', async () => {
    const h = harness();
    const old = new Date(Date.now() - 30 * HOUR);
    for (let i = 0; i < 60; i++) {
      const pid = `p-old-${String(i).padStart(2, '0')}`;
      seedPurchase(h.db, pid, old);
      h.db.state.chargeRefund.push(
        refundRow(`r-old-${String(i).padStart(2, '0')}`, pid, new Date(old.getTime() + i)),
      );
    }
    const fresh = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-fresh', fresh);
    h.db.state.chargeRefund.push(refundRow('r-fresh', 'p-fresh', fresh));

    const out = await h.svc.retryPendingTransferReversals();
    expect(out).toMatchObject({ reversed: 1, needs_review: 60, in_review: 60 });
    expect(h.stripeTotal('tr_p-fresh')).toBe(122);
    expect(h.refund('r-fresh').transfer_reversed).toBe(true);
    // No expired row was resent.
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(60);

    // The next run repeats nothing.
    const again = await h.svc.retryPendingTransferReversals();
    expect(again).toMatchObject({ retried: 0, reversed: 0, needs_review: 0, in_review: 60 });
    expect(captureMessage).toHaveBeenCalledTimes(60);
  });

  it('more than one batch of fresh owed refunds is reached in one run', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < 120; i++) {
      const pid = `p-f-${String(i).padStart(3, '0')}`;
      seedPurchase(h.db, pid, at);
      h.db.state.chargeRefund.push(
        refundRow(`r-f-${String(i).padStart(3, '0')}`, pid, new Date(at.getTime() + i)),
      );
    }
    const out = await h.svc.retryPendingTransferReversals(new Date(), 50);
    expect(out).toMatchObject({ retried: 120, reversed: 120, needs_review: 0 });
  });

  it('pages past rows that leave the owed set and rows that stay owed, each retried once per run', async () => {
    // Every third Stripe call fails, so a page mixes rows that leave the set
    // (reversed) with rows that stay owed (pending). A cursor on a row that
    // left the filter returned an empty page at 183ed462; keyset paging on
    // (created_at, id) reaches all 120 and never retries a row twice.
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < 120; i++) {
      const pid = `p-m-${String(i).padStart(3, '0')}`;
      seedPurchase(h.db, pid, at);
      h.db.state.chargeRefund.push(
        refundRow(`r-m-${String(i).padStart(3, '0')}`, pid, new Date(at.getTime() + i)),
      );
    }
    const real = h.reverseTransfer.getMockImplementation();
    h.reverseTransfer.mockImplementation(async (args) => {
      const n = Number(args.idempotencyKey.slice(-3));
      if (n % 3 === 2) throw Object.assign(new Error('Stripe unavailable'), { code: 'api_error' });
      return (real as NonNullable<typeof real>)(args);
    });
    const out = await h.svc.retryPendingTransferReversals(new Date(), 50);
    expect(out).toMatchObject({ retried: 120, reversed: 80, needs_review: 0 });
    const keys = h.reverseTransfer.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toHaveLength(120);
    expect(new Set(keys).size).toBe(120);
  });
});
