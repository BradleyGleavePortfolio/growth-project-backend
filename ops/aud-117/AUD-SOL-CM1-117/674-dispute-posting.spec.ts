import 'reflect-metadata';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';

// The new source-aware posting writer must make BOTH transfer records and
// the linked head-coach slice once-only, including a lost-dispute redelivery
// after the downstream entitlement transaction fails.
describe('Sol agent 117 — M1 immutable dispute posting boundary', () => {
  it('B-674-10: lost-dispute recovery cannot reverse Stripe/transfer twice while its source posting stays once', async () => {
    const h = harness();
    h.db.model('chargeDispute', [['id'], ['stripe_dispute_id']]);
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-dispute', at);
    const fee = h.db.state.splitLedgerEntry.find((r) => r.kind === 'application_fee')!;
    h.db.state.splitLedgerEntry.push({
      ...fee, id: 'head-dispute', kind: 'head_coach_split',
      payee_user_id: 'head-1', amount_cents: 245, reversed_cents: 0,
    });
    h.db.state.connectTransfer[0].ledger_entry_id = 'head-dispute';
    h.db.state.chargeDispute.push({
      id: 'd-one', stripe_dispute_id: 'dp_one', purchase_id: 'p-dispute',
      stripe_charge_id: 'ch_p-dispute', amount_cents: 2450,
      status: 'needs_response', ledger_reversed: false,
      closed_at: null, created_at: at, updated_at: at,
    });
    const original = h.db.clientPurchase.update.bind(h.db.clientPurchase);
    h.db.clientPurchase.update = jest.fn()
      .mockRejectedValueOnce(new Error('synthetic downstream transaction failure'))
      .mockImplementation(original);
    const event = (id: string) => ({
      id, type: 'charge.dispute.closed',
      data: { object: { id: 'dp_one', status: 'lost', amount: 2450 } },
    });
    await expect(h.svc.handle(event('evt_first'))).rejects.toThrow('synthetic downstream transaction failure');
    expect(h.db.state.chargeDispute[0].ledger_reversed).toBe(false);
    expect([h.stripeTotal('tr_p-dispute'), h.headCoach('p-dispute')]).toEqual([122, 122]);
    expect(h.db.state.splitLedgerEntry.find((r) => r.id === 'head-dispute')!.reversed_cents).toBe(122);
    await h.svc.handle(event('evt_retry'));
    const result = {
      stripe: h.stripeTotal('tr_p-dispute'),
      transfer: h.headCoach('p-dispute'),
      headSlice: h.db.state.splitLedgerEntry.find((r) => r.id === 'head-dispute')!.reversed_cents,
      headPostings: h.db.state.splitLedgerReversal.filter((r) => r.entry_id === 'head-dispute')
        .map((r) => r.cents),
      stripeKeys: h.reverseTransfer.mock.calls.map(([a]) => a.idempotencyKey),
    };
    console.log('AUDIT_DISPUTE_REDELIVERY', JSON.stringify(result));
    expect(result).toMatchObject({ stripe: 122, transfer: 122, headSlice: 122, headPostings: [122] });
  });
});
