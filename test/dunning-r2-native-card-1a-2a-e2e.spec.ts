import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import {
  ApprovedInvoice,
  CardUpdateResult,
  ClientBillingService,
} from '../src/checkout/client-billing.service';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import {
  DUNNING_UPDATE_CARD_URL,
  LOCKED_DUNNING_CODE,
} from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { EmailTemplateKey } from '../src/email/email.types';
import { NotificationKind } from '../src/notifications/notification-kind';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

/**
 * S-DUNNING-R2 — owner rulings 1A / 2A and the native card update (OR-110-2),
 * end to end: Stripe-shaped webhook fixtures through the REAL webhook
 * handler, v1 DunningService, v2 service + dispatcher + hourly sweep, the
 * lockout and entitlement guards, and the new ClientBillingService, against
 * a STATEFUL fake Stripe (test/support/fake-stripe-billing.ts) that enforces
 * "an invoice is paid at most once", "a void invoice cannot be paid", "a paid
 * invoice cannot be voided" and Stripe's retry-on-subscription-default rule.
 * Clock faked; database in memory; every amount is integer cents.
 *
 *   1A    locked Day 10 -> native card update -> open invoice paid now -> unlocked
 *   1A-d  the new card is declined too -> truthful outcome, still locked, no charge
 *   1A-3  bank wants 3DS -> client secret -> client confirms -> unlocked
 *   R1    card update races Stripe's own retry -> one charge, unlocked
 *   R2    card update vs cancel / double tap -> lease serializes (409 + next step)
 *   2A    cancel in dunning -> invoice void, sub canceled, access ends now,
 *         no Day-10 lock, no more notices, late webhook cannot revive it
 *   2A-p  cancel races a retry that just paid -> option A (keeps paid period)
 *   2A-r  Stripe cancel fails after the void -> 503 says so -> reconciler finishes
 *   A     voluntary cancel outside dunning -> period end, no refund, no void
 *   B     Day 0 / Day 9 / Day 10 boundaries
 */

const FIXTURES = join(__dirname, 'fixtures', 'stripe', 'dunning-v2');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = new Date('2026-10-05T16:00:00.000Z'); // Day 0: renewal charge fails
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;

let eventSeq = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fixture(name: string, object: Record<string, unknown> = {}): any {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  eventSeq += 1;
  return {
    ...raw,
    id: `${raw.id}_r2_${eventSeq}`,
    data: { ...raw.data, object: { ...raw.data.object, ...object } },
  };
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (ms: number) => new Date(T0.getTime() + ms);

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class FakeController {
  handler(): void {}
}

function ctxFor(path: string, user?: { id: string; role: string }, method = 'GET') {
  const req = { path, user, method };
  return stub({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => FakeController.prototype.handler,
    getClass: () => FakeController,
  });
}

interface World {
  fake: FakePrisma;
  stripe: FakeStripeBilling;
  handler: CheckoutWebhookHandlerService;
  v2: DunningV2Service;
  billing: ClientBillingService;
  lockGuard: DunningLockoutGuard;
  entitlementGuard: ClientEntitlementGuard;
  push: jest.Mock;
  email: jest.Mock;
}

function buildWorld(): World {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const stripe = new FakeStripeBilling();
  stripe.customers.set('cus_dv2_client', {
    id: 'cus_dv2_client',
    default_payment_method: 'pm_old',
  });
  stripe.subs.set('sub_dv2_client', {
    id: 'sub_dv2_client',
    status: 'active',
    customer: 'cus_dv2_client',
    current_period_end: sec(at(30 * DAY)),
    default_payment_method: 'pm_old',
    cancel_at_period_end: false,
    latest_invoice: null,
  });
  stripe.addCard('pm_old', 'decline', '0341');
  stripe.addCard('pm_new_ok', 'ok', '4242');
  stripe.addCard('pm_new_declined', 'decline', '0002');
  stripe.addCard('pm_new_3ds', 'requires_action', '3155', 'mastercard');

  const push = jest.fn(async () => true);
  const email = jest.fn(async () => ({ ok: true }));
  const notifications = {
    pushToUser: push,
    pushToCoach: jest.fn(async () => true),
    createNotification: jest.fn(async (n: { user_id: string; kind: string; body: string }) =>
      fake.seed('notification', { ...n, read_at: null, created_at: new Date() }),
    ),
  };
  const telemetry = new DunningV2Telemetry();
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    telemetry,
    stub(notifications),
    stub({ send: email }),
    stub({ emit: jest.fn(async () => undefined) }),
  );
  const v2 = new DunningV2Service(prisma, telemetry, dispatcher, stub(stripe));
  const v1 = new DunningService(prisma, stub(stripe));
  const handler = new CheckoutWebhookHandlerService(
    prisma,
    stub(stripe),
    undefined,
    v1,
    undefined,
    undefined,
    undefined,
    v2,
  );
  const billing = new ClientBillingService(prisma, stub(stripe), v1, v2, undefined);

  fake.seed('user', {
    id: 'coach-1',
    name: 'Morgan Coach',
    email: 'coach@tgp.invalid',
    role: 'coach',
  });
  fake.seed('user', {
    id: 'client-1',
    name: 'Avery Client',
    email: 'client@tgp.invalid',
    role: 'student',
  });
  fake.seed('user', {
    id: 'client-2',
    name: 'Other Tenant',
    email: 'other@tgp.invalid',
    role: 'student',
  });
  fake.seed('coachPackage', {
    id: 'pkg-1',
    coach_user_id: 'coach-1',
    billing_type: 'recurring',
    interval: 'month',
    duration_days: null,
    price_cents: 15000,
  });
  fake.seed('connectCustomer', {
    id: 'cc-1',
    client_user_id: 'client-1',
    stripe_customer_id: 'cus_dv2_client',
    default_payment_method_id: 'pm_old',
    default_card_last4: '0341',
    default_card_brand: 'visa',
  });
  fake.seed('connectCustomer', {
    id: 'cc-2',
    client_user_id: 'client-2',
    stripe_customer_id: 'cus_other',
  });
  fake.seed('notificationPreferences', {
    id: 'np-1',
    user_id: 'client-1',
    timezone: 'America/Los_Angeles',
  });
  fake.seed('clientPurchase', {
    id: 'purchase-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'active',
    entitlement_active: true,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: 'sub_dv2_client',
    stripe_payment_intent_id: 'pi_dv2_renewal_1',
    access_expires_at: at(0),
    current_period_end: at(0),
    cancel_at_period_end: false,
    canceled_at: null,
    created_at: at(-60 * DAY),
  });

  return {
    fake,
    stripe,
    handler,
    v2,
    billing,
    lockGuard: new DunningLockoutGuard(prisma),
    entitlementGuard: new ClientEntitlementGuard(prisma, new Reflector()),
    push,
    email,
  };
}

const CLIENT = { id: 'client-1', role: 'student' };

async function lockVerdict(w: World, path: string): Promise<'allowed' | 'LOCKED_DUNNING'> {
  try {
    await w.lockGuard.canActivate(ctxFor(path, CLIENT));
    return 'allowed';
  } catch (err) {
    if (err instanceof ForbiddenException) {
      const body = err.getResponse() as { code?: string };
      if (body.code === LOCKED_DUNNING_CODE) return 'LOCKED_DUNNING';
    }
    throw err;
  }
}

async function entitlementVerdict(w: World): Promise<'allowed' | 402> {
  try {
    await w.entitlementGuard.canActivate(ctxFor('/api/v1/workouts', CLIENT));
    return 'allowed';
  } catch (err) {
    if (err instanceof HttpException && err.getStatus() === 402) return 402;
    throw err;
  }
}

const stateRow = (w: World) => w.fake.find('dunningState', { purchase_id: 'purchase-1' });
const purchaseRow = (w: World) => w.fake.find('clientPurchase', { id: 'purchase-1' });

/** Day 0: the renewal invoice ($150.00 = 15000 cents) fails on the old card. */
async function failRenewal(w: World): Promise<void> {
  w.stripe.addInvoice({
    id: 'in_dv2_renewal_1',
    subscription: 'sub_dv2_client',
    amount_due: 15000,
    created: sec(T0),
  });
  w.stripe.subs.get('sub_dv2_client')!.status = 'past_due';
  await w.handler.handle(
    fixture('customer.subscription.updated.past_due', {
      current_period_start: sec(at(0)),
      current_period_end: sec(at(30 * DAY)),
    }),
  );
  await w.handler.handle(fixture('invoice.payment_failed', { attempt_count: 1 }));
  await flush();
}

async function stripeRetryFails(w: World, when: Date, attempt: number): Promise<void> {
  jest.setSystemTime(when);
  expect(w.stripe.stripeRetry('in_dv2_renewal_1')).toBe('failed');
  await w.handler.handle(fixture('invoice.payment_failed', { attempt_count: attempt }));
  await flush();
}

/** Days 1/3/7 retries fail; the Day-10 sweep locks. */
async function driveToLocked(w: World): Promise<Date> {
  await failRenewal(w);
  await stripeRetryFails(w, at(DAY + HOUR), 2);
  await stripeRetryFails(w, at(3 * DAY + HOUR), 3);
  await stripeRetryFails(w, at(7 * DAY + HOUR), 4);
  const lockAt = at(10 * DAY + 7 * MIN);
  jest.setSystemTime(lockAt);
  expect((await w.v2.runSweep(lockAt)).locked).toBe(1);
  return lockAt;
}

/** The app: mint a SetupIntent, the PaymentSheet saves `pm`, then confirm. */
async function updateCardInApp(w: World, pm: string, n = 1): Promise<CardUpdateResult> {
  const setup = await w.billing.createCardSetup('client-1', UUID(n));
  w.stripe.confirmSetupIntentInSheet(setup.setup_intent_id, pm);
  return w.billing.confirmCardUpdate('client-1', setup.setup_intent_id, await approveAll(w));
}

/** S-DUNNING-R3 (B-628-3): the app approves the quote it showed. */
async function approveAll(w: World, client = 'client-1'): Promise<ApprovedInvoice[]> {
  const quote = await w.billing.getPaymentQuote(client);
  return quote.lines.map((l) => ({
    invoice_id: l.invoice_id,
    amount_cents: l.amount_cents,
    currency: l.currency,
  }));
}

const leaseRow = (w: World) => w.fake.find('clientBillingLease', { purchase_id: 'purchase-1' });

function expectIntegerCents(...values: Array<number | null | undefined>): void {
  for (const v of values) {
    if (v == null) continue;
    expect(Number.isInteger(v)).toBe(true);
  }
}

async function errorOf(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) {
      return { status: err.getStatus(), body: err.getResponse() as Record<string, unknown> };
    }
    throw err;
  }
  throw new Error('expected an HttpException');
}

describe('S-DUNNING-R2: native card update, owner rulings 1A / 2A (stateful Stripe, fake clock)', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  const prevPk = process.env['STRIPE_PUBLISHABLE_KEY'];
  let w: World;

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'pk_test_r2';
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
    w = buildWorld();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
    if (prevPk === undefined) delete process.env['STRIPE_PUBLISHABLE_KEY'];
    else process.env['STRIPE_PUBLISHABLE_KEY'] = prevPk;
  });

  describe('native setup (OR-110-2)', () => {
    it('mints a SetupIntent on the client platform Customer for off-session use, idempotent per key', async () => {
      const a = await w.billing.createCardSetup('client-1', UUID(7));
      const b = await w.billing.createCardSetup('client-1', UUID(7));
      expect(a).toEqual(b);
      expect(a).toMatchObject({
        customer_id: 'cus_dv2_client',
        ephemeral_key: 'ek_test_cus_dv2_client',
        publishable_key: 'pk_test_r2',
        merchant_display_name: 'The Growth Project',
      });
      expect(a.setup_intent_client_secret).toMatch(/^seti_.*_secret_/);
      const [call] = w.stripe.callsOf('createSetupIntent');
      expect(call.args).toEqual({
        customer: 'cus_dv2_client',
        metadata: { tgp_client_user_id: 'client-1', tgp_purpose: 'client_card_update' },
        idempotencyKey: `tgp-card-setup-client-1-${UUID(7)}`,
        // Main's signature (B-DUNB-120): the plan's coach account; this fixture plan has none.
        onBehalfOf: '',
      });
      expect(w.stripe.setupIntents.get(a.setup_intent_id)?.usage).toBe('off_session');
    });

    it('answers 404 CUSTOMER_NOT_FOUND for a client with no Stripe customer', async () => {
      const e = await errorOf(w.billing.createCardSetup('nobody', UUID(1)));
      expect(e.status).toBe(404);
      expect(e.body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
      expect(String(e.body.message)).toMatch(/Message your coach/);
    });

    it('never confirms another client SetupIntent (404) or an unconfirmed one (409), and charges nothing', async () => {
      await failRenewal(w);
      const foreign = await w.billing.createCardSetup('client-2', UUID(2));
      w.stripe.confirmSetupIntentInSheet(foreign.setup_intent_id, 'pm_new_ok');
      const e1 = await errorOf(w.billing.confirmCardUpdate('client-1', foreign.setup_intent_id));
      expect(e1.status).toBe(404);
      expect(e1.body).toMatchObject({ code: 'SETUP_INTENT_NOT_FOUND' });

      const mine = await w.billing.createCardSetup('client-1', UUID(3));
      const e2 = await errorOf(w.billing.confirmCardUpdate('client-1', mine.setup_intent_id));
      expect(e2.status).toBe(409);
      // R3: the production envelope keeps code + message only.
      expect(e2.body).toMatchObject({ code: 'SETUP_INTENT_NOT_CONFIRMED' });
      expect(String(e2.body.message)).toMatch(/nothing was charged/);
      expect(w.stripe.callsOf('payInvoice')).toHaveLength(0);
      expect(w.stripe.charges).toHaveLength(0);
    });

    it('outside dunning: saves the card as the default everywhere and charges nothing (outcome saved)', async () => {
      const res = await updateCardInApp(w, 'pm_new_ok');
      expect(res).toMatchObject({
        outcome: 'saved',
        amount_paid_cents: 0,
        amount_due_cents: 0,
        access_restored: false,
        card: { brand: 'visa', last4: '4242' },
      });
      expect(w.stripe.customers.get('cus_dv2_client')?.default_payment_method).toBe('pm_new_ok');
      expect(w.stripe.subs.get('sub_dv2_client')?.default_payment_method).toBe('pm_new_ok');
      expect(w.fake.find('connectCustomer', { id: 'cc-1' })).toMatchObject({
        default_payment_method_id: 'pm_new_ok',
        default_card_last4: '4242',
      });
      expect(w.stripe.charges).toHaveLength(0);
    });
  });

  describe('owner 1A: card update in dunning pays the open invoice now', () => {
    it('1A. locked on Day 10 -> new card -> invoice paid once -> unlocked at once; webhook + replay are no-ops', async () => {
      const lockAt = await driveToLocked(w);
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');
      // The update-card routes stay reachable while locked.
      for (const p of [
        '/api/v1/checkout/payment-method/setup-intent',
        '/api/v1/checkout/payment-method/confirm',
        '/api/v1/checkout/subscriptions/purchase-1/cancel',
        '/api/v1/checkout/dunning',
      ]) {
        expect(await lockVerdict(w, p)).toBe('allowed');
      }
      const status = await w.v2.getClientStatus('client-1');
      expect(status).toMatchObject({
        state: 'locked',
        amount_cents: 15000,
        update_payment_route: '/v1/checkout/payment-method/setup-intent',
        update_card_url: DUNNING_UPDATE_CARD_URL,
        cancel_route: '/v1/checkout/subscriptions/purchase-1/cancel',
        card_last4: '0341',
        card_brand: 'visa',
      });

      jest.setSystemTime(new Date(lockAt.getTime() + 2 * HOUR));
      const res = await updateCardInApp(w, 'pm_new_ok');

      // Money: exactly one charge of 15000 cents, on the NEW card, by our pay.
      expect(res).toMatchObject({
        outcome: 'paid',
        amount_paid_cents: 15000,
        amount_due_cents: 0,
        currency: 'usd',
        access_restored: true,
        card: { last4: '4242' },
      });
      expectIntegerCents(res.amount_paid_cents, res.amount_due_cents);
      expect(w.stripe.charges).toEqual([
        { invoice: 'in_dv2_renewal_1', payment_method: 'pm_new_ok', amount: 15000, by: 'tgp_pay' },
      ]);
      const [pay] = w.stripe.callsOf('payInvoice');
      expect(pay.key).toMatch(/^tgp-1a-pay-in_dv2_renewal_1-seti_/);
      // Future retries/renewals use the new card: subscription default moved.
      expect(w.stripe.subs.get('sub_dv2_client')?.default_payment_method).toBe('pm_new_ok');

      // Unlocked BEFORE any webhook arrives.
      expect(stateRow(w)).toMatchObject({
        status: 'resolved',
        locked_out_at: null,
      });
      expect(purchaseRow(w)).toMatchObject({ status: 'active', entitlement_active: true });
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
      expect(await entitlementVerdict(w)).toBe('allowed');
      expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
      const blockers = w.fake
        .rows('notification')
        .filter((n) => n.user_id === 'client-1' && n.kind === NotificationKind.DUNNING_BLOCKER);
      expect(blockers.every((n) => n.read_at instanceof Date)).toBe(true);

      // Stripe's invoice.paid webhook, then a redelivery: idempotent, no charge.
      await w.handler.handle(fixture('invoice.paid'));
      await w.handler.handle(fixture('invoice.paid'));
      await flush();
      expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
      expect(purchaseRow(w)).toMatchObject({ status: 'active', entitlement_active: true });
      // Re-sending the same confirm (app retry) charges nothing more.
      const setupId = w.stripe.callsOf('retrieveSetupIntent')[0].args as string;
      const again = await w.billing.confirmCardUpdate('client-1', setupId, await approveAll(w));
      // R3: a replay (the app lost our reply) reports what that confirm paid.
      expect(again).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
      expect(w.stripe.charges).toHaveLength(1);
      // The sweep is quiet afterwards; nothing is ever cancelled.
      expect(await w.v2.runSweep(at(12 * DAY))).toEqual({ locked: 0, advanced: 0, skipped: 0 });
      expect(w.stripe.callsOf('cancelSubscription')).toHaveLength(0);
    });

    it('1A-d. the new card is declined too: truthful outcome, invoice stays open, still locked, nothing charged', async () => {
      await driveToLocked(w);
      const res = await updateCardInApp(w, 'pm_new_declined');
      expect(res).toMatchObject({
        outcome: 'declined',
        decline_code: 'insufficient_funds',
        amount_paid_cents: 0,
        amount_due_cents: 15000,
        access_restored: false,
        card: { last4: '0002' },
      });
      expect(res.message).toMatch(/declined the payment of \$150\.00, so nothing was charged/);
      expect(res.message).not.toMatch(/!/);
      expect(w.stripe.charges).toHaveLength(0);
      expect(w.stripe.invoices.get('in_dv2_renewal_1')?.status).toBe('open');
      expect(stateRow(w)).toMatchObject({ status: 'active' });
      expect(leaseRow(w)).toMatchObject({ holder: null });
      expect(stateRow(w)?.locked_out_at).toBeInstanceOf(Date);
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');

      // A second, good card then pays it (a fresh SetupIntent, fresh key).
      const ok = await updateCardInApp(w, 'pm_new_ok', 2);
      expect(ok).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
      expect(w.stripe.charges).toHaveLength(1);
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    });

    it('1A-3. the bank asks for 3DS: client secret returned; after the client confirms, access returns', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(4 * DAY));
      const res = await updateCardInApp(w, 'pm_new_3ds');
      expect(res).toMatchObject({
        outcome: 'requires_action',
        payment_intent_client_secret: 'pi_for_in_dv2_renewal_1_secret_test',
        amount_paid_cents: 0,
        amount_due_cents: 15000,
        access_restored: false,
      });
      expect(w.stripe.charges).toHaveLength(0);
      // Days 0-9 the client keeps full access throughout.
      expect(await entitlementVerdict(w)).toBe('allowed');

      // The app runs handleNextAction; the bank approves; Stripe settles.
      w.stripe.completeBankConfirmation('in_dv2_renewal_1');
      const setupId = w.stripe.callsOf('retrieveSetupIntent')[0].args as string;
      const after = await w.billing.confirmCardUpdate('client-1', setupId, await approveAll(w));
      // R3: the journal ties the bank-confirmed payment to this card update,
      // so the answer reports it (integer cents) instead of "0 paid".
      expect(after).toMatchObject({
        outcome: 'paid',
        amount_paid_cents: 15000,
        access_restored: true,
      });
      expect(w.stripe.charges).toEqual([
        {
          invoice: 'in_dv2_renewal_1',
          payment_method: 'pm_new_3ds',
          amount: 15000,
          by: 'client_3ds',
        },
      ]);
      expect(stateRow(w)?.status).toBe('resolved');
      expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
    });

    it('R1. card update races Stripe own retry: the invoice is charged exactly once and access returns', async () => {
      await driveToLocked(w);
      // Stripe's retry (on the NEW subscription default) lands between our
      // list and our pay: our pay then finds the invoice already paid.
      w.stripe.beforePay = () => {
        w.stripe.beforePay = undefined;
        expect(w.stripe.stripeRetry('in_dv2_renewal_1')).toBe('paid');
      };
      const res = await updateCardInApp(w, 'pm_new_ok');
      expect(res).toMatchObject({ outcome: 'paid', amount_paid_cents: 0, access_restored: true });
      expect(w.stripe.charges).toEqual([
        {
          invoice: 'in_dv2_renewal_1',
          payment_method: 'pm_new_ok',
          amount: 15000,
          by: 'stripe_retry',
        },
      ]);
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
      await w.handler.handle(fixture('invoice.paid'));
      expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
      expect(w.stripe.charges).toHaveLength(1);
    });

    it('R2. a card update in flight blocks a cancel and a double tap (409 + next step); an expired lease is free', async () => {
      await failRenewal(w);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      w.stripe.beforePay = async () => {
        w.stripe.beforePay = undefined;
        await gate;
      };
      const setup = await w.billing.createCardSetup('client-1', UUID(9));
      w.stripe.confirmSetupIntentInSheet(setup.setup_intent_id, 'pm_new_ok');
      const inflight = w.billing.confirmCardUpdate(
        'client-1',
        setup.setup_intent_id,
        await approveAll(w),
      );
      for (let i = 0; i < 20 && w.stripe.callsOf('payInvoice').length === 0; i += 1) await flush();
      expect(w.stripe.callsOf('payInvoice')).toHaveLength(1);
      expect(String(leaseRow(w)?.holder)).toMatch(/^paying:/);

      const cancel = await errorOf(w.billing.cancelPlan('client-1', 'purchase-1'));
      expect(cancel.status).toBe(409);
      expect(cancel.body).toMatchObject({ code: 'BILLING_ACTION_IN_PROGRESS' });
      expect(String(cancel.body.message)).toMatch(/pull down to see the result/);
      const tap2 = await errorOf(
        w.billing.confirmCardUpdate('client-1', setup.setup_intent_id, await approveAll(w)),
      );
      expect(tap2.body).toMatchObject({ code: 'BILLING_ACTION_IN_PROGRESS' });
      expect(w.stripe.callsOf('voidInvoice')).toHaveLength(0);

      release();
      const res = await inflight;
      expect(res.outcome).toBe('paid');
      expect(w.stripe.charges).toHaveLength(1);
      expect(leaseRow(w)?.holder).toBeNull();

      // A crashed holder's lease expires on its own.
      const row = stateRow(w)!;
      row.status = 'active';
      const lease = leaseRow(w)!;
      lease.holder = 'canceling:dead';
      lease.holder_until = new Date(Date.now() - 1);
      w.stripe.addInvoice({
        id: 'in_next',
        subscription: 'sub_dv2_client',
        amount_due: 15000,
        created: sec(at(DAY)),
      });
      w.stripe.subs.get('sub_dv2_client')!.status = 'past_due';
      purchaseRow(w)!.status = 'past_due';
      const next = await updateCardInApp(w, 'pm_new_ok', 10);
      expect(next).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
    });
  });

  describe('owner 2A: cancel in dunning voids the invoice and ends access now', () => {
    it('2A. Day 4 cancel -> invoice void, sub canceled, access ends now, no lock, no notices; late webhooks cannot revive it', async () => {
      await failRenewal(w);
      await stripeRetryFails(w, at(DAY + HOUR), 2);
      await stripeRetryFails(w, at(3 * DAY + HOUR), 3);
      jest.setSystemTime(at(4 * DAY));
      const pushesBefore = w.push.mock.calls.length;
      const emailsBefore = w.email.mock.calls.length;

      const res = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(res).toMatchObject({
        outcome: 'ended',
        purchase_id: 'purchase-1',
        access_ends_at: at(4 * DAY).toISOString(),
        voided_invoice_count: 1,
        voided_amount_cents: 15000,
        currency: 'usd',
      });
      expectIntegerCents(res.voided_amount_cents);
      expect(res.message).toMatch(/will not be charged for it/);
      // Money: nothing charged, the invoice can never be collected.
      expect(w.stripe.charges).toHaveLength(0);
      expect(w.stripe.invoices.get('in_dv2_renewal_1')?.status).toBe('void');
      expect(w.stripe.subs.get('sub_dv2_client')?.status).toBe('canceled');
      // Void happened BEFORE the cancel.
      const ops = w.stripe.calls.map((c) => c.op);
      expect(ops.indexOf('voidInvoice')).toBeLessThan(ops.indexOf('cancelSubscription'));

      expect(purchaseRow(w)).toMatchObject({
        status: 'canceled',
        entitlement_active: false,
        cancel_at_period_end: false,
      });
      expect(stateRow(w)).toMatchObject({
        status: 'abandoned',
        locked_out_at: null,
      });
      expect(stateRow(w)?.client_canceled_at).toEqual(at(4 * DAY));
      // Access ends immediately (paywall), and it is not a dunning lockout.
      expect(await entitlementVerdict(w)).toBe(402);
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
      expect((await w.v2.getClientStatus('client-1')).state).toBe('none');

      // Out-of-order delivery: the void's subscription.updated(active)
      // arrives after we ended the plan; then deleted, twice.
      await w.handler.handle(
        fixture('customer.subscription.updated.past_due', {
          status: 'active',
          current_period_end: sec(at(30 * DAY)),
        }),
      );
      expect(purchaseRow(w)).toMatchObject({ status: 'canceled', entitlement_active: false });
      await w.handler.handle(
        fixture('customer.subscription.deleted', { canceled_at: sec(at(4 * DAY)) }),
      );
      await w.handler.handle(
        fixture('customer.subscription.deleted', { canceled_at: sec(at(4 * DAY)) }),
      );
      expect(purchaseRow(w)).toMatchObject({ status: 'canceled', entitlement_active: false });
      expect(stateRow(w)?.status).toBe('abandoned');

      // No Day-7 notice, no Day-10 lock, ever.
      for (const t of [at(7 * DAY + HOUR), at(10 * DAY + 7 * MIN), at(11 * DAY)]) {
        jest.setSystemTime(t);
        expect(await w.v2.runSweep(t)).toEqual({ locked: 0, advanced: 0, skipped: 0 });
      }
      expect(w.push.mock.calls.length).toBe(pushesBefore);
      expect(w.email.mock.calls.length).toBe(emailsBefore);
      expect(await entitlementVerdict(w)).toBe(402);

      // Cancelling again is idempotent.
      const again = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(again.outcome).toBe('already_ended');
      expect(w.stripe.callsOf('cancelSubscription')).toHaveLength(1);
    });

    it('2A while locked (Day 11): the lock gives way to a plain ended plan; nothing more is collected', async () => {
      await driveToLocked(w);
      jest.setSystemTime(at(11 * DAY));
      const res = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(res).toMatchObject({ outcome: 'ended', voided_amount_cents: 15000 });
      expect(stateRow(w)).toMatchObject({ status: 'abandoned', locked_out_at: null });
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
      expect(await entitlementVerdict(w)).toBe(402);
      // Stripe can no longer collect: the invoice is void.
      expect(w.stripe.stripeRetry('in_dv2_renewal_1')).toBe('not_open');
      expect(w.stripe.charges).toHaveLength(0);
    });

    it('2A-p. a Stripe retry paid a moment before the cancel: no void possible -> option A (keeps the paid period)', async () => {
      await failRenewal(w);
      w.stripe.addCard('pm_old', 'ok', '0341'); // the bank now approves the old card
      w.stripe.beforeVoid = () => {
        w.stripe.beforeVoid = undefined;
        expect(w.stripe.stripeRetry('in_dv2_renewal_1')).toBe('paid');
      };
      jest.setSystemTime(at(2 * DAY));
      const res = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(res).toMatchObject({
        outcome: 'scheduled',
        voided_invoice_count: 0,
        voided_amount_cents: 0,
        access_ends_at: at(30 * DAY).toISOString(),
      });
      expect(w.stripe.subs.get('sub_dv2_client')).toMatchObject({
        status: 'active',
        cancel_at_period_end: true,
      });
      expect(w.stripe.callsOf('cancelSubscription')).toHaveLength(0);
      expect(w.stripe.charges).toHaveLength(1); // the retry's own charge; no refund
      expect(purchaseRow(w)?.cancel_at_period_end).toBe(true);
    });

    it('2A-r. Stripe cancel fails after the void: 503 says the invoice is canceled; no lock/notices; reconciler finishes', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(5 * DAY));
      w.stripe.cancelFailures = 1;
      const e = await errorOf(w.billing.cancelPlan('client-1', 'purchase-1'));
      expect(e.status).toBe(503);
      expect(e.body).toMatchObject({ code: 'CANCEL_INCOMPLETE' });
      expect(String(e.body.message)).toMatch(/unpaid invoice is canceled/);
      expect(w.stripe.invoices.get('in_dv2_renewal_1')?.status).toBe('void');
      expect(stateRow(w)).toMatchObject({
        status: 'active',
        client_canceled_at: at(5 * DAY),
      });
      // In between: no banner, no Day-10 lock, no notices.
      expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
      jest.setSystemTime(at(10 * DAY + 7 * MIN));
      expect((await w.v2.runSweep(at(10 * DAY + 7 * MIN))).locked).toBe(0);
      // The reconciler (hourly) finishes the cancel.
      w.stripe.cancelFailures = 0;
      expect(await w.billing.reconcile(at(10 * DAY + 37 * MIN))).toEqual({
        finished: 1,
        applied: 0,
        failed: 0,
      });
      expect(w.stripe.subs.get('sub_dv2_client')?.status).toBe('canceled');
      expect(purchaseRow(w)).toMatchObject({ status: 'canceled', entitlement_active: false });
      expect(stateRow(w)?.status).toBe('abandoned');
      expect(w.stripe.charges).toHaveLength(0);
    });

    it('2A via a cancel outside the app (cancel_at_period_end while past_due) is applied by the reconciler under v2 only', async () => {
      await failRenewal(w);
      purchaseRow(w)!.cancel_at_period_end = true;
      delete process.env['FEATURE_DUNNING_V2'];
      expect(await w.billing.reconcile(at(DAY))).toEqual({ finished: 0, applied: 0, failed: 0 });
      expect(w.stripe.invoices.get('in_dv2_renewal_1')?.status).toBe('open');
      process.env['FEATURE_DUNNING_V2'] = 'true';
      expect(await w.billing.reconcile(at(DAY))).toEqual({ finished: 0, applied: 1, failed: 0 });
      expect(w.stripe.invoices.get('in_dv2_renewal_1')?.status).toBe('void');
      expect(purchaseRow(w)).toMatchObject({ status: 'canceled', entitlement_active: false });
    });

    it('rejects a foreign purchase (404) and a non-subscription (409)', async () => {
      const e1 = await errorOf(w.billing.cancelPlan('client-2', 'purchase-1'));
      expect(e1.status).toBe(404);
      expect(e1.body).toMatchObject({ code: 'PURCHASE_NOT_FOUND' });
      w.fake.seed('clientPurchase', {
        id: 'purchase-once',
        client_user_id: 'client-1',
        coach_user_id: 'coach-1',
        package_id: 'pkg-1',
        status: 'paid',
        billing_type: 'one_time',
        amount_cents: 9900,
        stripe_subscription_id: null,
      });
      const e2 = await errorOf(w.billing.cancelPlan('client-1', 'purchase-once'));
      expect(e2.status).toBe(409);
      expect(e2.body).toMatchObject({ code: 'NOT_A_SUBSCRIPTION' });
    });
  });

  describe('owner 13:43 option A: voluntary cancel outside dunning', () => {
    it('A. schedules the end at period end: no void, no refund, no immediate cancel, access through the period', async () => {
      purchaseRow(w)!.current_period_end = at(20 * DAY);
      purchaseRow(w)!.access_expires_at = at(20 * DAY);
      w.stripe.subs.get('sub_dv2_client')!.current_period_end = sec(at(20 * DAY));
      const res = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(res).toMatchObject({
        outcome: 'scheduled',
        access_ends_at: at(20 * DAY).toISOString(),
        voided_invoice_count: 0,
        voided_amount_cents: 0,
      });
      expect(res.message).toMatch(/keep access until 2026-10-25/);
      const [ape] = w.stripe.callsOf('setCancelAtPeriodEnd');
      // MONEY-REFUND-124 B1: each cancel is its own Stripe request (a cancel
      // after Keep plan must not replay the first answer).
      expect(ape.key).toMatch(/^tgp-cancel-ape-sub_dv2_client-[0-9a-f-]{36}$/);
      expect(w.stripe.callsOf('voidInvoice')).toHaveLength(0);
      expect(w.stripe.callsOf('cancelSubscription')).toHaveLength(0);
      expect(w.stripe.charges).toHaveLength(0);
      jest.setSystemTime(at(15 * DAY));
      expect(await entitlementVerdict(w)).toBe('allowed');
      // Idempotent: a second tap does not call Stripe again.
      await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(w.stripe.callsOf('setCancelAtPeriodEnd')).toHaveLength(1);
    });
  });

  describe('non-payment boundaries: Day 0 / Day 9 / Day 10', () => {
    it('full access Day 0 through the last instant of Day 9; hard lock exactly at Day 10', async () => {
      await failRenewal(w);
      expect(await entitlementVerdict(w)).toBe('allowed'); // Day 0
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
      const lastMs = at(10 * DAY - 1);
      jest.setSystemTime(lastMs);
      expect((await w.v2.runSweep(lastMs)).locked).toBe(0); // Day 9, 23:59:59.999
      expect(await entitlementVerdict(w)).toBe('allowed');
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
      const lockMs = at(10 * DAY);
      jest.setSystemTime(lockMs);
      expect((await w.v2.runSweep(lockMs)).locked).toBe(1); // Day 10, 00:00:00.000
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');
      // The account-rights and recovery routes stay reachable.
      for (const p of [
        '/api/v1/checkout/payment-method/setup-intent',
        '/api/v1/me/data-export/request',
        '/api/me/delete-account',
        '/api/messages',
        '/api/me/ai-consent',
      ]) {
        expect(await lockVerdict(w, p)).toBe('allowed');
      }
    });
  });

  describe('dunning emails (F17)', () => {
    it('v2 client notices use the v2 template with the update-card link; the coach gets the coach template', async () => {
      await failRenewal(w);
      await stripeRetryFails(w, at(DAY + HOUR), 2);
      const clientMail = w.email.mock.calls.find((c) => c[0].to === 'client@tgp.invalid')?.[0];
      expect(clientMail).toMatchObject({
        template: EmailTemplateKey.DUNNING_V2_CLIENT,
        data: {
          update_card_url: DUNNING_UPDATE_CARD_URL,
          subject: 'Your payment is still outstanding',
          amount: '$150.00',
        },
      });
      expect(String(clientMail.data.roman_body)).toMatch(/\$150\.00/);
      await stripeRetryFails(w, at(3 * DAY + HOUR), 3);
      await stripeRetryFails(w, at(7 * DAY + HOUR), 4);
      const coachMail = w.email.mock.calls.find((c) => c[0].to === 'coach@tgp.invalid')?.[0];
      expect(coachMail?.template).toBe(EmailTemplateKey.DUNNING_V2_COACH);
      const day7 = w.email.mock.calls.filter((c) => c[0].to === 'client@tgp.invalid').pop()?.[0];
      expect(String(day7.data.subject)).toMatch(/^Final notice: access pauses on /);
    });
  });
});
