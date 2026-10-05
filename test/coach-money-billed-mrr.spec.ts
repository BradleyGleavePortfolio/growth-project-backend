// B-676-5 (B-CM5-119): MRR and paying_clients count only a recurring purchase
// that billed (ruling 10-03: never-billed trials are excluded). A trial whose
// first invoice fails is written past_due and stays entitled during dunning,
// but it never billed, so it is neither MRR nor a paying client. A billed
// past_due renewal still counts; an active trial still counts as a trial.
// Real CheckoutWebhookHandlerService writes; the real CoachMoneyService reads
// the same rows (money-read-double).
import 'reflect-metadata';
import * as moneyModule from '../src/coach-money/coach-money.service';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';
import { moneyReadPrisma } from './support/money-read-double';

type Row = Record<string, unknown>;
const AT = new Date('2027-03-21T10:00:00.000Z');
const WINDOW = { from: new Date(AT.getTime() - HOUR), to: AT };

function setup() {
  const h = harness();
  const writer: CheckoutWebhookHandlerService = Reflect.construct(CheckoutWebhookHandlerService, [
    h.db,
    {},
  ]);
  const money: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(h.db)]);
  const purchase = (id: string) =>
    (h.db.state.clientPurchase as Row[]).find((p) => p.id === id) as Row;
  // A recurring purchase for `client`; `billed` keeps its posted ledger slices.
  const seed = (id: string, client: string, status: string, billed: boolean) => {
    seedPurchase(h.db, id, new Date(AT.getTime() - HOUR));
    const slices = h.db.state.splitLedgerEntry as Row[];
    for (let i = slices.length - 1; i >= 0; i--) {
      if (!billed && slices[i].purchase_id === id) slices.splice(i, 1);
    }
    Object.assign(purchase(id), {
      client_user_id: client,
      status,
      stripe_subscription_id: `sub_${id}`,
      entitlement_active: true,
    });
  };
  const recurring = async () =>
    (await money.getSummary('coach-1', WINDOW, null, AT, 'usd')).recurring;
  const failFirstInvoice = (id: string) =>
    writer.handle({
      id: `evt_fail_${id}`,
      type: 'invoice.payment_failed',
      data: {
        object: { id: `in_${id}`, subscription: `sub_${id}`, amount_due: 4900, attempt_count: 1 },
      },
    });
  return { h, purchase, seed, recurring, failFirstInvoice };
}

describe('B-676-5: MRR and paying clients need billed evidence', () => {
  it('a trial whose first invoice fails is not MRR or paying; a billed past_due renewal is', async () => {
    const { h, purchase, seed, recurring, failFirstInvoice } = setup();
    seed('p-trial', 'trial-client', 'trialing', false);
    expect(await recurring()).toMatchObject({ mrr_cents: 0, paying_clients: 0, trial_clients: 1 });
    await failFirstInvoice('p-trial');
    expect(purchase('p-trial')).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect((h.db.state.splitLedgerEntry as Row[]).some((s) => s.purchase_id === 'p-trial')).toBe(
      false,
    );
    expect(await recurring()).toMatchObject({ mrr_cents: 0, paying_clients: 0 });
    // Control: a renewal that billed before (posted destination slice) and is
    // now past_due still counts once.
    seed('p-paid', 'paid-client', 'past_due', true);
    expect(await recurring()).toMatchObject({ mrr_cents: 4900, paying_clients: 1 });
  });

  it('a trial converted by its first paid invoice counts', async () => {
    const { seed, recurring } = setup();
    seed('p-conv', 'conv-client', 'active', false);
    expect(await recurring()).toMatchObject({
      mrr_cents: 4900,
      paying_clients: 1,
      trial_clients: 0,
    });
  });

  it('an active trial stays a trial, apart from MRR and paying clients', async () => {
    const { seed, recurring } = setup();
    seed('p-trial', 'trial-client', 'trialing', false);
    seed('p-paid', 'paid-client', 'active', true);
    expect(await recurring()).toMatchObject({
      mrr_cents: 4900,
      paying_clients: 1,
      trial_clients: 1,
    });
  });

  it('a never-billed plan canceled while still entitled is not a paying client', async () => {
    const { seed, recurring } = setup();
    seed('p-cancel', 'cancel-client', 'canceled', false);
    expect(await recurring()).toMatchObject({ mrr_cents: 0, paying_clients: 0 });
  });

  it('one client with a billed plan and a never-billed past_due plan is one paying client at one price', async () => {
    const { seed, recurring, failFirstInvoice } = setup();
    seed('p-paid', 'same-client', 'active', true);
    seed('p-trial', 'same-client', 'trialing', false);
    await failFirstInvoice('p-trial');
    expect(await recurring()).toMatchObject({ mrr_cents: 4900, paying_clients: 1 });
  });

  it('exports the billed predicate the trials integration reuses (C-673-3)', () => {
    // Read off the module so a missing export fails this assertion, not the build.
    expect(Reflect.get(moneyModule, 'BILLED_WHERE')).toEqual({
      OR: [
        { status: { in: ['paid', 'active'] } },
        { splits: { some: { kind: 'destination', status: { in: ['posted', 'reversed'] } } } },
      ],
    });
  });
});
