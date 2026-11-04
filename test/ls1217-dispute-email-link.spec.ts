import { readFileSync } from 'fs';
import { join } from 'path';
import * as Handlebars from 'handlebars';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { DUNNING_UPDATE_CARD_URL } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import type { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import type { EmailService } from '../src/email/email.service';
import { EmailTemplateKey, SendEmailInput } from '../src/email/email.types';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { StatefulPrisma } from './support/stateful-prisma';
import { moneyReadPrisma } from './support/money-read-double';
import { stub } from './broadcasts/_stub';

const T0 = new Date('2026-11-01T12:00:00.000Z');
const T1 = new Date('2026-11-02T12:00:00.000Z');
const COACH = 'coach-1';
const render = Handlebars.compile(
  readFileSync(join(__dirname, '../src/email/templates/dunning-v2-client.hbs'), 'utf8'),
);

function harness() {
  const fake = new FakePrisma();
  fake.seed('user', { id: COACH, name: 'Coach One', email: 'coach@example.test' });
  fake.seed('user', {
    id: 'client-1', name: 'Ana Ruiz', email: 'ana@example.test', coach_id: COACH,
  });
  fake.seed('coachPackage', { id: 'pkg-1', name: 'Monthly coaching', interval: 'month' });
  // A renewal failed after a previous invoice had been paid. This is still
  // an ordinary past-due plan when that previous payment is disputed.
  fake.seed('clientPurchase', {
    id: 'p1', client_user_id: 'client-1', coach_user_id: COACH,
    package_id: 'pkg-1', status: 'past_due', entitlement_active: true,
    billing_type: 'recurring', amount_cents: 4900, currency: 'usd',
    stripe_subscription_id: 'sub_1', source: null, moved_away_at: null,
    last_error: 'card_declined', created_at: T0, updated_at: T0,
  });
  fake.seed('dunningState', {
    id: 'ds1', purchase_id: 'p1', status: 'active', step_index: 0,
    entered_at: T0, locked_out_at: null, client_canceled_at: null,
    reversal_count: 0, last_failure_reason: 'card_declined',
    last_failed_amount_cents: 4900, last_failure_at: T0,
  });
  const clientHtml: string[] = [];
  const email = {
    send: jest.fn(async (input: SendEmailInput) => {
      if (input.template === EmailTemplateKey.DUNNING_V2_CLIENT) {
        clientHtml.push(render(input.data));
      }
      return {
        status: 'sent', providerMessageId: 'synthetic-mail',
        idempotencyKey: input.idempotencyKey,
      };
    }),
  };
  const telemetry = new DunningV2Telemetry();
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(), new DunningV2Renderer(), telemetry,
    undefined, stub<EmailService>(email),
  );
  const stripe = {
    pauseSubscriptionCollection: jest.fn(async () => ({ status: 'active' })),
    listOpenInvoices: jest.fn(async () => []),
    retrieveSubscription: jest.fn(async () => ({ status: 'past_due' })),
  };
  const v2 = new DunningV2Service(
    fake.client(), telemetry, dispatcher, stub<StripeConnectApiService>(stripe),
  );
  const linkAt = async () => {
    // Move only the rows written by the real service into the existing
    // read double, which evaluates CoachMoneyService's actual Prisma query.
    const db = new StatefulPrisma();
    const models = [
      'user', 'coachPackage', 'clientPurchase', 'dunningState',
      'dunningAttempt', 'dunningNoticeDelivery', 'chargeDispute', 'connectAccount',
    ] as const;
    for (const model of models) {
      db.model(model);
      db.state[model].push(...fake.store[model]);
    }
    const money: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(db)]);
    const item = (await money.getAttention(COACH)).items.find((i) => i.kind === 'failed_payment');
    expect(item).toBeDefined();
    return item?.failed_payment?.card_update_link_sent_at;
  };
  return { fake, v2, clientHtml, linkAt };
}

describe('LS-1217: only a real update-card email is a sent link', () => {
  const before = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => { process.env.FEATURE_DUNNING_V2 = 'true'; });
  afterAll(() => {
    if (before === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = before;
  });

  it('control: a payment-cycle email contains the link and supplies the date', async () => {
    const h = harness();
    const claim = await h.v2.recordPaymentFailed('p1', T1);
    expect(claim).not.toBeNull();
    await h.v2.dispatchClaim(claim, T1);
    expect(h.clientHtml).toHaveLength(1);
    expect(h.clientHtml[0]).toContain(DUNNING_UPDATE_CARD_URL);
    expect(await h.linkAt()).toBe(T1.toISOString());
  });

  it('B2: a dispute email with no update-card link must not be reported as link sent', async () => {
    const h = harness();
    const opened = await h.v2.handleLateReversal({
      purchaseId: 'p1', disputeId: 'dp_1', chargeId: 'ch_previous_invoice',
      reversedChargeAt: T0, now: T1,
    });
    expect(opened.opened).toBe(true);
    expect(h.fake.find('clientPurchase', { id: 'p1' })?.status).toBe('past_due');
    expect(h.clientHtml).toHaveLength(1);
    expect(h.clientHtml[0]).not.toContain(DUNNING_UPDATE_CARD_URL);
    const receipt = h.fake.store.dunningNoticeDelivery.find((r) => r.channel === 'client_email');
    expect(receipt).toMatchObject({
      status: 'sent', cycle_key: String(T1.getTime()), sent_at: T1,
    });
    expect(await h.linkAt()).toBeNull();
  });
});
