import 'reflect-metadata';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

afterEach(() => jest.useRealTimers());
const timeout = () =>
  new StripeConnectApiError('Synthetic timeout', 503, 'request_timeout', 'api_connection_error');

describe('Sol agent 118 — send-time authority and incomplete provider lists', () => {
  it('a long but bounded refund sweep never replays a key after its real retention expired', async () => {
    const started = new Date('2027-03-21T12:00:00.000Z');
    const first = new Date(started.getTime() - 22 * HOUR - 59 * 60_000);
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(started);
    const h = harness();
    // Default budget is 20 * 50 = 1,000 rows. 370 preceding provider calls
    // each use the production 10-second timeout, totaling 61m40s.
    for (let i = 0; i < 370; i++) {
      const id = `a-${String(i).padStart(3, '0')}`;
      seedPurchase(h.db, `p-${id}`, first);
      h.db.state.chargeRefund.push(refundRow(id, `p-${id}`, first));
    }
    seedPurchase(h.db, 'p-target', first);
    h.db.state.chargeRefund.push(refundRow('z-target', 'p-target', first));
    await h.reverseTransfer({
      transfer_id: 'tr_p-target',
      amount: 122,
      idempotencyKey: 'tgp-tr-rev-refund-z-target',
      metadata: { tgp_charge_refund_id: 'z-target' },
    });
    // The first answer/record was lost. The local record is still zero.
    expect([h.stripeTotal('tr_p-target'), h.headCoach('p-target')]).toEqual([122, 0]);
    const provider = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockClear();
    h.reverseTransfer.mockImplementation(async (args) => {
      if (args.transfer_id !== 'tr_p-target') {
        jest.setSystemTime(Date.now() + 10_000);
        throw timeout();
      }
      if (Date.now() - first.getTime() >= 24 * HOUR) h.expireKeys();
      return provider(args);
    });
    const result = await h.svc.retryPendingTransferReversals(started);
    console.log('AUDIT_118_REFUND_SEND_TIME', JSON.stringify({
      result,
      elapsed_ms: Date.now() - started.getTime(),
      age_at_send_ms: Date.now() - first.getTime(),
      stripe: h.stripeTotal('tr_p-target'),
      local: h.headCoach('p-target'),
      in_review: !!h.refund('z-target').transfer_reversal_review_at,
    }));
    expect(h.stripeTotal('tr_p-target')).toBe(122);
    expect(h.refund('z-target').transfer_reversal_review_at).toBeInstanceOf(Date);
  });

  it('an explicitly incomplete reversal list never proves absence for an expired dispute key', async () => {
    const h = harness();
    const first = new Date(Date.now() - 25 * HOUR);
    seedPurchase(h.db, 'p-incomplete', first);
    h.db.state.chargeDispute.push({
      id: 'd-incomplete', stripe_dispute_id: 'dp_incomplete',
      purchase_id: 'p-incomplete', stripe_charge_id: 'ch_p-incomplete',
      amount_cents: 2450, status: 'lost', ledger_reversed: true,
      closed_at: first, transfer_reversal_amount_cents: 122,
      transfer_reversal_first_attempt_at: first, transfer_reversal_last_attempt_at: null,
      transfer_reversed_at: null, transfer_reversal_stripe_id: null,
      created_at: first, updated_at: first,
    });
    await h.reverseTransfer({
      transfer_id: 'tr_p-incomplete', amount: 122,
      idempotencyKey: 'tgp-tr-rev-dispute-d-incomplete',
      metadata: { tgp_charge_dispute_id: 'd-incomplete' },
    });
    h.expireKeys();
    h.reverseTransfer.mockClear();
    Reflect.get(h.svc, 'stripe').listTransferReversals = jest.fn(async () => ({
      data: [], has_more: true,
    }));
    const result = await h.svc.retryPendingTransferReversals();
    console.log('AUDIT_118_INCOMPLETE_DISPUTE_LIST', JSON.stringify({
      result, sent_again: h.reverseTransfer.mock.calls.length,
      stripe: h.stripeTotal('tr_p-incomplete'), local: h.headCoach('p-incomplete'),
    }));
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.stripeTotal('tr_p-incomplete')).toBe(122);
    expect(h.headCoach('p-incomplete')).toBe(0);
  });
});
