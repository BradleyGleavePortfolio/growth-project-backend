import 'reflect-metadata';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';
import { moneyReadPrisma } from './support/money-read-double';

describe('Sol agent 118 — independent chargeback occurrence query boundaries', () => {
  it('zero-ledger lost events retain ids while other-coach, wrong-currency, won, and source grants stay out', async () => {
    const at = new Date('2027-03-21T10:00:00.000Z');
    const h = harness();
    for (const id of ['p-own', 'p-foreign', 'p-gbp', 'p-grant']) seedPurchase(h.db, id, at);
    Object.assign(h.db.state.clientPurchase[1], { coach_user_id: 'other-coach' });
    Object.assign(h.db.state.clientPurchase[2], { currency: 'gbp' });
    Object.assign(h.db.state.clientPurchase[3], { source: 'coach_code' });
    for (const [id, purchase, status] of [
      ['d-a', 'p-own', 'lost'], ['d-b', 'p-own', 'lost'],
      ['d-won', 'p-own', 'won'], ['d-foreign', 'p-foreign', 'lost'],
      ['d-gbp', 'p-gbp', 'lost'], ['d-grant', 'p-grant', 'lost'],
    ]) {
      h.db.state.chargeDispute.push({
        id, purchase_id: purchase, stripe_charge_id: `ch_${id}`,
        amount_cents: 1, status, closed_at: at, updated_at: at,
      });
    }
    const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(h.db)]);
    const window = { from: at, to: new Date(at.getTime() + HOUR) };
    const occurrences = await service.loadOccurrences('coach-1', window, { limit: 20, currency: 'usd' });
    expect(occurrences.map((o) => [o.source_id, o.amount_cents, o.stripe_charge_id])).toEqual([
      ['d-a', 1, 'ch_d-a'], ['d-b', 1, 'ch_d-b'],
    ]);
    const csv = await service.exportCsv('coach-1', window, 'usd');
    const refunds = csv.trim().split('\r\n').slice(1).map((line) => line.split(','))
      .filter((row) => row[1] === 'chargeback');
    expect(refunds.map((row) => [row[3], row[8], row[12]])).toEqual([
      ['ch_d-a', '0.01', '0.00'], ['ch_d-b', '0.01', '0.00'],
    ]);
  });

  it('the lost-dispute occurrence query independently rejects an incomplete over-limit file', async () => {
    const h = harness();
    const read = moneyReadPrisma(h.db);
    read.chargeDispute.findMany = jest.fn(async () => [Object.create(null), Object.create(null)]);
    const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [read]);
    const at = new Date('2027-03-21T10:00:00.000Z');
    await expect(service.loadOccurrences('coach-1', { from: at, to: new Date(at.getTime() + HOUR) },
      { limit: 1, currency: 'usd' })).rejects.toMatchObject({
      response: { code: 'MONEY_EXPORT_TOO_LARGE' },
    });
    expect(read.chargeDispute.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it('a never-billed trial with a failed first invoice is not paying MRR; a previously billed past-due plan still is', async () => {
    const at = new Date('2027-03-21T10:00:00.000Z');
    const h = harness();
    seedPurchase(h.db, 'p-trial', new Date(at.getTime() - HOUR));
    h.db.state.splitLedgerEntry.length = 0;
    Object.assign(h.db.state.clientPurchase[0], {
      status: 'trialing', stripe_subscription_id: 'sub_trial', entitlement_active: true,
    });
    const writer: CheckoutWebhookHandlerService = Reflect.construct(CheckoutWebhookHandlerService, [h.db, {}]);
    const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(h.db)]);
    const window = { from: new Date(at.getTime() - HOUR), to: at };
    await expect(service.getSummary('coach-1', window, null, at, 'usd')).resolves.toMatchObject({
      recurring: { mrr_cents: 0, paying_clients: 0, trial_clients: 1 },
    });
    await writer.handle({
      id: 'evt_first_invoice_failed', type: 'invoice.payment_failed',
      data: { object: { id: 'in_first', subscription: 'sub_trial', amount_due: 4900, attempt_count: 1 } },
    });
    expect(h.db.state.clientPurchase[0]).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.db.state.splitLedgerEntry).toHaveLength(0);
    const neverBilled = await service.getSummary('coach-1', window, null, at, 'usd');
    console.log('AUDIT_118_NEVER_BILLED_FIRST_FAILURE', JSON.stringify(neverBilled.recurring));
    // Preserve the existing expected MRR for a past-due renewal with proof
    // of an earlier paid destination posting.
    seedPurchase(h.db, 'p-paid', new Date(at.getTime() - HOUR));
    Object.assign(h.db.state.clientPurchase[1], {
      status: 'past_due', client_user_id: 'paid-client',
    });
    const withBilledControl = await service.getSummary('coach-1', window, null, at, 'usd');
    console.log('AUDIT_118_BILLED_PAST_DUE_CONTROL', JSON.stringify(withBilledControl.recurring));
    expect({ never: neverBilled.recurring.mrr_cents, withPaid: withBilledControl.recurring.mrr_cents,
      neverPaying: neverBilled.recurring.paying_clients, paying: withBilledControl.recurring.paying_clients,
    }).toEqual({ never: 0, withPaid: 4900, neverPaying: 0, paying: 1 });
  });
});
