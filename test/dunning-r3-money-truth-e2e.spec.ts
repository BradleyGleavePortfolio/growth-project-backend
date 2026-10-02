import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import {
  ApprovedInvoice,
  CardUpdateResult,
  ClientBillingService,
} from '../src/checkout/client-billing.service';
import { DunningService } from '../src/checkout/dunning.service';
import {
  DunningV2Service,
  mergeDisputeObligations,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
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
    id: `${raw.id}_r3_${eventSeq}`,
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
  /** The prisma-shaped client every service was built with (jest.fn delegates). */
  prisma: ReturnType<FakePrisma['client']>;
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
    prisma,
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

/** A second delinquent plan (another coach package) for multi-plan cases. */
function addSecondPlan(w: World, opts: { currency?: string; amount?: number } = {}): void {
  const currency = opts.currency ?? 'usd';
  const amount = opts.amount ?? 9000;
  w.stripe.subs.set('sub_dv2_client_2', {
    id: 'sub_dv2_client_2',
    status: 'past_due',
    customer: 'cus_dv2_client',
    current_period_end: sec(at(30 * DAY)),
    default_payment_method: 'pm_old',
    cancel_at_period_end: false,
    latest_invoice: null,
  });
  w.stripe.addInvoice({
    id: 'in_plan2_1',
    subscription: 'sub_dv2_client_2',
    amount_due: amount,
    currency,
    created: sec(at(HOUR)),
  });
  w.fake.seed('clientPurchase', {
    id: 'purchase-2',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'past_due',
    entitlement_active: true,
    billing_type: 'recurring',
    amount_cents: amount,
    currency,
    stripe_subscription_id: 'sub_dv2_client_2',
    access_expires_at: at(0),
    current_period_end: at(0),
    cancel_at_period_end: false,
    canceled_at: null,
    created_at: at(-50 * DAY),
  });
}

async function cardUpdate(
  w: World,
  pm: string,
  n: number,
  approved?: ApprovedInvoice[],
): Promise<{ res: CardUpdateResult; setupId: string }> {
  const setup = await w.billing.createCardSetup('client-1', UUID(n));
  w.stripe.confirmSetupIntentInSheet(setup.setup_intent_id, pm);
  const res = await w.billing.confirmCardUpdate(
    'client-1',
    setup.setup_intent_id,
    approved ?? (await approveAll(w)),
  );
  return { res, setupId: setup.setup_intent_id };
}

describe('S-DUNNING-R3: money truth, fencing, durable intent (stateful Stripe, fake clock)', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  const prevPk = process.env['STRIPE_PUBLISHABLE_KEY'];
  let w: World;

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'pk_test_r3';
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

  describe('B-628-1: a payment that lands before or during a 2A cancel keeps the paid period', () => {
    it('paid before the list (Opus probe): no void, no cancel now; plan ends at period end', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(4 * DAY));
      // Stripe's retry succeeds on a card the bank re-enabled; the webhook is late.
      w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
      expect(w.stripe.stripeRetry('in_dv2_renewal_1')).toBe('paid');
      const res = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(res).toMatchObject({
        outcome: 'scheduled',
        paid_period_kept: true,
        voided_invoice_count: 0,
        voided_amount_cents: 0,
      });
      expect(res.access_ends_at).toBe(at(30 * DAY).toISOString());
      expect(w.stripe.callsOf('voidInvoice')).toHaveLength(0);
      expect(w.stripe.callsOf('cancelSubscription')).toHaveLength(0);
      expect(w.stripe.subs.get('sub_dv2_client')?.cancel_at_period_end).toBe(true);
      expect(purchaseRow(w)).toMatchObject({
        entitlement_active: true,
        cancel_at_period_end: true,
      });
      expect(res.message).toMatch(/payment went through/i);
      expect(await entitlementVerdict(w)).toBe('allowed');
    });

    it('paid between the list and the void: the void is refused, the paid period is kept', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(4 * DAY));
      w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
      w.stripe.beforeVoid = () => {
        w.stripe.stripeRetry('in_dv2_renewal_1');
      };
      const res = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(res).toMatchObject({ outcome: 'scheduled', paid_period_kept: true });
      expect(w.stripe.invoices.get('in_dv2_renewal_1')?.status).toBe('paid');
      expect(w.stripe.callsOf('cancelSubscription')).toHaveLength(0);
      expect(purchaseRow(w)).toMatchObject({ entitlement_active: true });
      expect(stateRow(w)).toMatchObject({ client_canceled_at: null });
    });

    it('reconciler: a recorded intent whose invoice was paid meanwhile keeps the period', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(4 * DAY));
      w.stripe.beforeVoid = () => {
        throw new Error('socket hang up');
      };
      const e = await errorOf(w.billing.cancelPlan('client-1', 'purchase-1'));
      expect(e.status).toBe(503);
      expect(e.body.code).toBe('PLAN_CHANGE_RESULT_UNKNOWN');
      // Durable intent: the journal row exists before any void went through.
      const op = w.fake.find('clientBillingOperation', {
        purchase_id: 'purchase-1',
        kind: 'cancel',
      });
      expect(op).toBeDefined();
      expect(op?.completed_at ?? null).toBeNull();
      w.stripe.beforeVoid = undefined;
      w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
      w.stripe.stripeRetry('in_dv2_renewal_1');
      jest.setSystemTime(at(4 * DAY + HOUR));
      await w.billing.reconcile(at(4 * DAY + HOUR));
      expect(w.stripe.callsOf('cancelSubscription')).toHaveLength(0);
      expect(purchaseRow(w)).toMatchObject({
        entitlement_active: true,
        cancel_at_period_end: true,
      });
      expect(w.fake.find('clientBillingOperation', { id: op!.id })).toMatchObject({
        phase: 'kept_paid_period',
      });
    });
  });

  describe('B-628-2 / B-628-3: per-invoice integer-cent truth and approval', () => {
    it('two plans, the second list fails: the answer leads with what was paid, never "nothing was charged"', async () => {
      await failRenewal(w);
      addSecondPlan(w);
      jest.setSystemTime(at(2 * DAY));
      const approved = await approveAll(w);
      expect(approved.map((a) => a.invoice_id).sort()).toEqual(['in_dv2_renewal_1', 'in_plan2_1']);
      w.stripe.listFailures.add('sub_dv2_client_2');
      const { res } = await cardUpdate(w, 'pm_new_ok', 2, approved);
      expect(res.paid_totals).toEqual([{ currency: 'usd', amount_cents: 15000 }]);
      expect(res.amount_paid_cents).toBe(15000);
      expect(res.access_state).toBe('partial');
      expect(res.access_restored).toBe(false);
      expect(res.message).toMatch(/^Your card ending 4242 is saved\. \$150\.00 went through/);
      expect(res.message).not.toMatch(/nothing was charged/);
      const plans = Object.fromEntries(res.plans.map((p) => [p.purchase_id, p]));
      expect(plans['purchase-1']).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
      expect(plans['purchase-2']).toMatchObject({ outcome: 'failed', amount_paid_cents: 0 });
      expectIntegerCents(res.amount_paid_cents, res.amount_due_cents);
    });

    it('a lost pay reply is re-read: the charge is reported once; a replay never charges again', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      w.stripe.loseNextPayReply = 1;
      const { res, setupId } = await cardUpdate(w, 'pm_new_ok', 3);
      expect(res).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
      const again = await w.billing.confirmCardUpdate('client-1', setupId, await approveAll(w));
      expect(again).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
      expect(w.stripe.charges).toHaveLength(1);
    });

    it('nothing approved, or a higher amount than approved: approval_required, nothing charged, fresh quote', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      const none = await cardUpdate(w, 'pm_new_ok', 4, []);
      expect(none.res.outcome).toBe('approval_required');
      expect(none.res.quote?.lines.map((l) => l.amount_cents)).toEqual([15000]);
      expect(none.res.message).toMatch(/not approved yet, so it was not charged/);
      const low = await cardUpdate(w, 'pm_new_ok', 5, [
        { invoice_id: 'in_dv2_renewal_1', amount_cents: 14999, currency: 'usd' },
      ]);
      expect(low.res.outcome).toBe('approval_required');
      expect(w.stripe.charges).toHaveLength(0);
    });

    it('mixed currencies are never summed: per-currency totals, single amount null', async () => {
      await failRenewal(w);
      addSecondPlan(w, { currency: 'eur', amount: 8000 });
      jest.setSystemTime(at(2 * DAY));
      const quote = await w.billing.getPaymentQuote('client-1');
      expect(quote.totals).toEqual([
        { currency: 'eur', amount_cents: 8000 },
        { currency: 'usd', amount_cents: 15000 },
      ]);
      const { res } = await cardUpdate(w, 'pm_new_ok', 6);
      expect(res.amount_paid_cents).toBeNull();
      expect(res.currency).toBeNull();
      expect(res.paid_totals).toEqual([
        { currency: 'eur', amount_cents: 8000 },
        { currency: 'usd', amount_cents: 15000 },
      ]);
      expect(res.access_state).toBe('restored');
    });
  });

  describe('C-628-1: a bank-action answer is re-read before it is reported', () => {
    it('the invoice is already paid when Stripe answers requires_action: reported settled, no bank step', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      const orig = w.stripe.payInvoice.bind(w.stripe);
      jest.spyOn(w.stripe, 'payInvoice').mockImplementationOnce(async (args) => {
        await orig(args);
        throw new StripeConnectApiError(
          'Payment for this invoice requires additional user action.',
          402,
          'invoice_payment_intent_requires_action',
          'invalid_request_error',
        );
      });
      const { res } = await cardUpdate(w, 'pm_new_ok', 7);
      expect(res.outcome).not.toBe('requires_action');
      expect(['paid', 'saved']).toContain(res.outcome);
      expect(res.payment_intent_client_secret ?? null).toBeNull();
      expect(w.stripe.charges).toHaveLength(1);
    });
  });

  describe('B-628-4: pagination', () => {
    it('25 delinquent plans: the quote covers every plan (no take:20 cut)', async () => {
      for (let i = 0; i < 25; i += 1) {
        const sub = `sub_many_${i}`;
        w.stripe.subs.set(sub, {
          id: sub,
          status: 'past_due',
          customer: 'cus_dv2_client',
          current_period_end: sec(at(30 * DAY)),
          default_payment_method: 'pm_old',
          cancel_at_period_end: false,
          latest_invoice: null,
        });
        w.stripe.addInvoice({
          id: `in_many_${i}`,
          subscription: sub,
          amount_due: 1000,
          created: i,
        });
        w.fake.seed('clientPurchase', {
          id: `purchase-many-${String(i).padStart(2, '0')}`,
          client_user_id: 'client-1',
          coach_user_id: 'coach-1',
          package_id: 'pkg-1',
          status: 'past_due',
          entitlement_active: true,
          billing_type: 'recurring',
          amount_cents: 1000,
          currency: 'usd',
          stripe_subscription_id: sub,
          created_at: at(-DAY),
        });
      }
      const quote = await w.billing.getPaymentQuote('client-1');
      expect(quote.lines).toHaveLength(25);
      expect(quote.totals).toEqual([{ currency: 'usd', amount_cents: 25000 }]);
    });
  });

  describe('B-628-5: durable cancel intent, live updates ignored meanwhile', () => {
    it('a live subscription.updated during a pending cancel does not re-entitle the client', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(4 * DAY));
      w.stripe.cancelFailures = 1;
      const e = await errorOf(w.billing.cancelPlan('client-1', 'purchase-1'));
      expect(e.body.code).toBe('CANCEL_INCOMPLETE');
      // The void made Stripe flip the subscription to active; the event lands.
      const r = await w.handler.handle(
        fixture('customer.subscription.updated.past_due', {
          status: 'active',
          current_period_end: sec(at(30 * DAY)),
        }),
      );
      expect(r).toMatchObject({ reason: 'stale_during_client_cancel' });
      expect(purchaseRow(w)?.status).not.toBe('active');
      await w.billing.reconcile(at(4 * DAY + HOUR));
      expect(purchaseRow(w)).toMatchObject({ status: 'canceled', entitlement_active: false });
    });
  });

  describe('B-628-6: notice outbox (durable delivery, per-cycle keys)', () => {
    it('a failed email is retried by the sweep with a fresh key; telemetry only counts real sends', async () => {
      w.email.mockImplementation(async () => ({ status: 'failed', error: 'provider 500' }));
      await failRenewal(w);
      // Day 1 step: push + email.
      jest.setSystemTime(at(DAY + HOUR));
      await w.v2.runSweep(at(DAY + HOUR));
      const rows = w.fake.rows('dunningNoticeDelivery');
      const email = rows.find((r) => r.channel === 'client_email' && r.step_index === 1);
      expect(email).toMatchObject({ status: 'failed', attempts: 1 });
      w.email.mockImplementation(async () => ({ status: 'sent' }));
      jest.setSystemTime(at(DAY + 2 * HOUR));
      await w.v2.runSweep(at(DAY + 2 * HOUR));
      expect(w.fake.find('dunningNoticeDelivery', { id: email!.id })).toMatchObject({
        status: 'sent',
        attempts: 2,
      });
      const keys = w.email.mock.calls.map(
        (c: unknown[]) => (c[0] as { idempotencyKey: string }).idempotencyKey,
      );
      expect(keys.some((k: string) => /:email:1$/.test(k))).toBe(true);
      expect(keys.some((k: string) => /:email:1:r1$/.test(k))).toBe(true);
    });

    it('a second cycle on the same row gets its own keys (never deduplicated against the first)', async () => {
      await failRenewal(w);
      const first = String(
        stateRow(w)!.entered_at instanceof Date ? (stateRow(w)!.entered_at as Date).getTime() : '',
      );
      // Paid, then a later renewal fails again: a new cycle.
      w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
      w.stripe.stripeRetry('in_dv2_renewal_1');
      await w.handler.handle(fixture('invoice.paid'));
      await flush();
      jest.setSystemTime(at(31 * DAY));
      w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_old';
      w.stripe.addInvoice({
        id: 'in_dv2_renewal_2',
        subscription: 'sub_dv2_client',
        amount_due: 15000,
        created: sec(at(31 * DAY)),
      });
      await w.handler.handle(
        fixture('invoice.payment_failed', { id: 'in_dv2_renewal_2', attempt_count: 1 }),
      );
      await flush();
      const cycles = new Set(w.fake.rows('dunningNoticeDelivery').map((r) => r.cycle_key));
      expect(cycles.has(first)).toBe(true);
      expect(cycles.size).toBe(2);
    });
  });

  describe('B-628-7: comp / live-grant parity between the guard and the status', () => {
    it('locked plan + another live grant: the status shows the banner (lock_waived), the guard allows', async () => {
      await driveToLocked(w);
      w.fake.seed('clientPurchase', {
        id: 'purchase-comp',
        client_user_id: 'client-1',
        coach_user_id: 'coach-1',
        package_id: 'pkg-1',
        status: 'paid',
        entitlement_active: true,
        billing_type: 'one_time',
        amount_cents: 0,
        currency: 'usd',
        access_expires_at: null,
        created_at: at(-DAY),
      });
      const status = await w.v2.getClientStatus('client-1');
      expect(status).toMatchObject({ state: 'past_due', lock_waived: true, kind: 'payment' });
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    });
  });

  describe('B-628-8: dispute cycles', () => {
    async function openDispute(): Promise<void> {
      await failRenewal(w);
      w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
      w.stripe.stripeRetry('in_dv2_renewal_1');
      await w.handler.handle(fixture('invoice.paid'));
      await flush();
      jest.setSystemTime(at(12 * DAY));
      w.fake.seed('chargeDispute', {
        id: 'dp-1',
        purchase_id: 'purchase-1',
        stripe_dispute_id: 'dp_1',
        stripe_charge_id: 'ch_1',
        amount_cents: 15000,
        currency: 'usd',
        status: 'needs_response',
        created_at: at(12 * DAY),
      });
      const r = await w.v2.handleLateReversal({
        purchaseId: 'purchase-1',
        reversedChargeAt: at(12 * DAY),
      });
      expect(r.opened).toBe(true);
    }

    it('locks on its Day 10 although the subscription is active; a renewal payment and a card update do not settle it; a won dispute does', async () => {
      await openDispute();
      // A renewal invoice.paid while the dispute is open keeps the cycle.
      await w.handler.handle(fixture('invoice.paid'));
      await flush();
      expect(stateRow(w)).toMatchObject({
        status: 'active',
        last_failure_reason: 'charge_disputed',
      });
      const lockAt = at(19 * DAY + 10 * MIN);
      jest.setSystemTime(lockAt);
      expect((await w.v2.runSweep(lockAt)).locked).toBe(1);
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');
      expect((await w.v2.getClientStatus('client-1')).kind).toBe('dispute');
      const { res } = await cardUpdate(w, 'pm_new_ok', 8);
      expect(res.plans[0]?.dispute_open).toBe(true);
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');
      w.fake.find('chargeDispute', { id: 'dp-1' })!.status = 'won';
      w.fake.seed('connectTransfer', {
        id: 'tr-1',
        source_stripe_charge_id: 'ch_1',
        purchase_id: 'purchase-1',
      });
      const closed = await w.v2.onDisputeClosed({ chargeId: 'ch_1', status: 'won' });
      expect(closed.resolved).toBe(true);
      expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
      expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    });
  });

  describe('B-628-9: the lease is a fence', () => {
    it('a stalled holder whose lease expired cannot write after a newer holder took over', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      let release: () => void = () => undefined;
      let first = true;
      w.stripe.beforePay = () =>
        first
          ? new Promise<void>((resolve) => {
              first = false;
              release = resolve;
            })
          : undefined;
      const setupA = await w.billing.createCardSetup('client-1', UUID(20));
      w.stripe.confirmSetupIntentInSheet(setupA.setup_intent_id, 'pm_new_ok');
      const approved = await approveAll(w);
      const stalled = w.billing.confirmCardUpdate('client-1', setupA.setup_intent_id, approved);
      for (let i = 0; i < 300 && w.stripe.callsOf('payInvoice').length === 0; i += 1) await flush();
      expect(w.stripe.callsOf('payInvoice')).toHaveLength(1);
      const fenceA = leaseRow(w)!.fence as number;
      // A's lease expires while it is stalled; B takes over and pays.
      leaseRow(w)!.holder_until = new Date(Date.now() - 1);
      const b = await cardUpdate(w, 'pm_new_ok', 21, approved);
      expect(b.res).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
      expect(leaseRow(w)!.fence).toBe(fenceA + 1);
      const opA = w.fake.find('clientBillingOperation', {
        setup_intent_id: setupA.setup_intent_id,
      });
      release();
      // A resumes: Stripe refuses its pay (already paid), and its fenced
      // write fails the holder CAS, so A answers 409 and writes nothing.
      const a = await errorOf(stalled);
      expect(a.status).toBe(409);
      expect(a.body.code).toBe('BILLING_ACTION_IN_PROGRESS');
      // R4 (B-628-11): A's intent was journaled before its pay call; its
      // stale receipt write was refused, so the journal still says `paying`.
      expect(w.fake.find('clientBillingOperation', { id: opA!.id })).toMatchObject({
        phase: 'paying',
        fence: fenceA,
        lines: [expect.objectContaining({ invoice_id: 'in_dv2_renewal_1', result: 'paying' })],
      });
      expect(w.stripe.charges).toHaveLength(1);
    });
  });
});

/**
 * S-DUNNING-R4 (fix round 4): the boundaries Sol's round-3 audit executed
 * (ops/aud-sol3-112/backend628-independent-boundaries.spec.ts), turned into
 * regression tests. Each one fails on 739e9a54.
 */
describe('S-DUNNING-R4: durable money intent, dispute obligations, claimed notice delivery', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  const prevPk = process.env['STRIPE_PUBLISHABLE_KEY'];
  let w: World;

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'pk_test_r4';
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

  /** Fail the first journal write (inside a transaction) once `when()` holds. */
  function failJournalWriteOnce(when: () => boolean): void {
    const makeClient = w.fake.client.bind(w.fake);
    let armed = true;
    jest.spyOn(w.fake, 'client').mockImplementation((viaTx = false) => {
      const client = makeClient(viaTx);
      if (viaTx) {
        const update = client.clientBillingOperation.update;
        client.clientBillingOperation.update = async (args: unknown) => {
          if (armed && when()) {
            armed = false;
            throw new Error('journal transaction failed before commit');
          }
          return update(args);
        };
      }
      return client;
    });
  }

  const cardOp = (setupId: string) =>
    w.fake.find('clientBillingOperation', { setup_intent_id: setupId, kind: 'card_pay' });

  describe('B-628-11: each pay / void intent is journaled before Stripe acts', () => {
    it('pay, then the receipt write fails: the intent was committed first and the same-SetupIntent retry reports the 15000 cents collected once', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      const approved = await approveAll(w);
      let journalAtPay: unknown = null;
      const pay = w.stripe.payInvoice.bind(w.stripe);
      jest.spyOn(w.stripe, 'payInvoice').mockImplementation(async (args) => {
        journalAtPay = w.fake
          .rows('clientBillingOperation')
          .find((o) => o.kind === 'card_pay')?.lines;
        return pay(args);
      });
      failJournalWriteOnce(() => w.stripe.charges.length > 0);
      const first = await cardUpdate(w, 'pm_new_ok', 91, approved);
      expect(w.stripe.charges).toHaveLength(1);
      // The intent (identity, currency, approved amount, key) was durable
      // before the pay call.
      expect(journalAtPay).toEqual([
        expect.objectContaining({
          invoice_id: 'in_dv2_renewal_1',
          currency: 'usd',
          amount_due_cents: 15000,
          result: 'paying',
          idempotency_key: `tgp-1a-pay-in_dv2_renewal_1-${first.setupId}`,
        }),
      ]);
      // The first answer never claims nothing was charged.
      expect(first.res.outcome).not.toBe('saved');
      expect(first.res.plans[0]?.outcome).toBe('uncertain');
      const retry = await w.billing.confirmCardUpdate('client-1', first.setupId, approved);
      expect(retry.amount_paid_cents).toBe(15000);
      expect(retry.paid_totals).toEqual([{ currency: 'usd', amount_cents: 15000 }]);
      expect(w.stripe.charges).toHaveLength(1);
      expectIntegerCents(retry.amount_paid_cents, retry.amount_due_cents);
    });

    it('the webhook restored the plan before the retry: the replay still reports the 15000 cents from Stripe', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      const approved = await approveAll(w);
      failJournalWriteOnce(() => w.stripe.charges.length > 0);
      const first = await cardUpdate(w, 'pm_new_ok', 92, approved);
      expect(w.stripe.charges).toHaveLength(1);
      await w.handler.handle(fixture('invoice.paid'));
      await flush();
      expect(purchaseRow(w)?.status).not.toBe('past_due');
      const retry = await w.billing.confirmCardUpdate('client-1', first.setupId, approved);
      expect(retry.amount_paid_cents).toBe(15000);
      expect(w.stripe.charges).toHaveLength(1);
    });

    it('the background reconciler turns the committed intent into a paid receipt', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      const approved = await approveAll(w);
      failJournalWriteOnce(() => w.stripe.charges.length > 0);
      const first = await cardUpdate(w, 'pm_new_ok', 93, approved);
      expect(cardOp(first.setupId)?.completed_at ?? null).toBeNull();
      jest.setSystemTime(at(2 * DAY + 10 * MIN));
      await w.billing.reconcile(at(2 * DAY + 10 * MIN));
      const op = cardOp(first.setupId)!;
      expect(op.completed_at).toBeInstanceOf(Date);
      expect(op.lines).toEqual([
        expect.objectContaining({
          invoice_id: 'in_dv2_renewal_1',
          result: 'paid',
          amount_paid_cents: 15000,
        }),
      ]);
    });

    it('the intent write itself fails: Stripe is never called and nothing is collected', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      const approved = await approveAll(w);
      const paySpy = jest.spyOn(w.stripe, 'payInvoice');
      failJournalWriteOnce(() => true);
      const first = await cardUpdate(w, 'pm_new_ok', 94, approved);
      expect(paySpy).not.toHaveBeenCalled();
      expect(w.stripe.charges).toHaveLength(0);
      expect(first.res.plans[0]?.outcome).toBe('failed');
    });

    it('void, then the receipt write fails: the void intent was committed first and the resumed cancel reports 1 invoice / 15000 cents forgiven', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      let journalAtVoid: unknown = null;
      const voidFn = w.stripe.voidInvoice.bind(w.stripe);
      jest.spyOn(w.stripe, 'voidInvoice').mockImplementation(async (args) => {
        journalAtVoid = w.fake
          .rows('clientBillingOperation')
          .find((o) => o.kind === 'cancel')?.lines;
        return voidFn(args);
      });
      failJournalWriteOnce(() => w.stripe.invoices.get('in_dv2_renewal_1')?.status === 'void');
      await expect(w.billing.cancelPlan('client-1', 'purchase-1')).rejects.toThrow(
        'journal transaction failed before commit',
      );
      expect(w.stripe.invoices.get('in_dv2_renewal_1')?.status).toBe('void');
      expect(journalAtVoid).toEqual([
        expect.objectContaining({
          invoice_id: 'in_dv2_renewal_1',
          amount_due_cents: 15000,
          result: 'voiding',
          idempotency_key: 'tgp-2a-void-in_dv2_renewal_1',
        }),
      ]);
      const retry = await w.billing.cancelPlan('client-1', 'purchase-1');
      expect(retry).toMatchObject({
        outcome: 'ended',
        voided_invoice_count: 1,
        voided_amount_cents: 15000,
        currency: 'usd',
      });
      expect(retry.message).toContain('$150.00');
    });
    it('a superseded update whose intent never got a receipt is settled as already paid by someone else, never as a second payment', async () => {
      await failRenewal(w);
      jest.setSystemTime(at(2 * DAY));
      let release: () => void = () => undefined;
      let first = true;
      w.stripe.beforePay = () =>
        first
          ? new Promise<void>((resolve) => {
              first = false;
              release = resolve;
            })
          : undefined;
      const setupA = await w.billing.createCardSetup('client-1', UUID(40));
      w.stripe.confirmSetupIntentInSheet(setupA.setup_intent_id, 'pm_new_ok');
      const approved = await approveAll(w);
      const stalled = w.billing.confirmCardUpdate('client-1', setupA.setup_intent_id, approved);
      for (let i = 0; i < 300 && w.stripe.callsOf('payInvoice').length === 0; i += 1) await flush();
      w.fake.find('clientBillingLease', { purchase_id: 'purchase-1' })!.holder_until = new Date(
        Date.now() - 1,
      );
      const b = await cardUpdate(w, 'pm_new_ok', 41, approved);
      expect(b.res.amount_paid_cents).toBe(15000);
      release();
      await stalled.catch(() => undefined);
      // A's replay: Stripe replays A's own answer (invoice already paid).
      const replayA = await w.billing.confirmCardUpdate(
        'client-1',
        setupA.setup_intent_id,
        approved,
      );
      expect(replayA.paid_totals).toEqual([]);
      // The reconciler settles A's intent the same way.
      jest.setSystemTime(at(2 * DAY + 10 * MIN));
      await w.billing.reconcile(at(2 * DAY + 10 * MIN));
      expect(cardOp(setupA.setup_intent_id)?.lines).toEqual([
        expect.objectContaining({ result: 'already_paid', amount_paid_cents: 0 }),
      ]);
      expect(w.stripe.charges).toHaveLength(1);
    });
  });

  describe('B-628-8: a won dispute settles only its own obligation', () => {
    function lockedDisputeCycle(): void {
      const state = stateRow(w)!;
      state.last_failure_reason = 'charge_disputed';
      state.locked_out_at = at(10 * DAY);
      purchaseRow(w)!.entitlement_active = false;
      w.fake.seed('connectTransfer', {
        id: 'tr-won',
        purchase_id: 'purchase-1',
        source_stripe_charge_id: 'ch_won',
      });
    }
    const dispute = (id: string, charge: string, status: string, day: number) =>
      w.fake.seed('chargeDispute', {
        id,
        purchase_id: 'purchase-1',
        stripe_charge_id: charge,
        stripe_dispute_id: `dp_${id}`,
        amount_cents: 15000,
        currency: 'usd',
        status,
        created_at: at(day * DAY),
      });

    it('one won charge does not clear another charge still under dispute (Sol probe)', async () => {
      await failRenewal(w);
      lockedDisputeCycle();
      dispute('won', 'ch_won', 'won', 1);
      dispute('open', 'ch_open', 'needs_response', 2);
      const closed = await w.v2.onDisputeClosed({ chargeId: 'ch_won', status: 'won' });
      expect(closed).toEqual({ resolved: false, reason: 'other_dispute_outstanding' });
      expect(stateRow(w)).toMatchObject({
        status: 'active',
        last_failure_reason: 'charge_disputed',
      });
      expect(stateRow(w)?.locked_out_at).toBeInstanceOf(Date);
      expect(purchaseRow(w)?.entitlement_active).toBe(false);
    });

    it('a lost dispute on another charge is an outstanding obligation too', async () => {
      await failRenewal(w);
      lockedDisputeCycle();
      dispute('won', 'ch_won', 'needs_response', 1);
      dispute('lost', 'ch_lost', 'lost', 2);
      const closed = await w.v2.onDisputeClosed({
        chargeId: 'ch_won',
        disputeId: 'dp_won',
        status: 'won',
      });
      expect(closed.resolved).toBe(false);
      expect(purchaseRow(w)?.entitlement_active).toBe(false);
    });

    it('a replayed old won closure after a new dispute opened does not lift the new lock', async () => {
      await failRenewal(w);
      lockedDisputeCycle();
      dispute('won', 'ch_won', 'won', 1);
      dispute('new', 'ch_won', 'needs_response', 5); // a second dispute on the same charge
      const replay = await w.v2.onDisputeClosed({
        chargeId: 'ch_won',
        disputeId: 'dp_won',
        status: 'won',
      });
      expect(replay.resolved).toBe(false);
      expect(stateRow(w)?.status).toBe('active');
    });

    it('the closing event wins over a table row the dispute handler has not updated yet: last open dispute won -> resolved and unlocked', async () => {
      await failRenewal(w);
      lockedDisputeCycle();
      dispute('a', 'ch_a', 'won', 1);
      dispute('won', 'ch_won', 'under_review', 2); // the event closes this one
      const closed = await w.v2.onDisputeClosed({
        chargeId: 'ch_won',
        disputeId: 'dp_won',
        status: 'won',
      });
      expect(closed).toEqual({ resolved: true, reason: 'dispute_won' });
      expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
      expect(purchaseRow(w)?.entitlement_active).toBe(true);
    });
  });

  describe('B-628-6: each notice delivery is claimed before its transport is called', () => {
    /** Day 1: the push fails once, leaving a failed, due-later row. */
    async function failedDay1Push(): Promise<Record<string, unknown>> {
      await failRenewal(w);
      w.push.mockResolvedValue({ delivered: false, code: 'provider-error' });
      jest.setSystemTime(at(DAY + HOUR));
      await w.v2.runSweep(at(DAY + HOUR));
      const row = w.fake
        .rows('dunningNoticeDelivery')
        .find((r) => r.channel === 'client_push' && r.step_index === 1)!;
      expect(row.status).toBe('failed');
      return row;
    }

    it('two concurrent retry workers send the due push once (Sol probe)', async () => {
      const row = await failedDay1Push();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      w.push.mockReset();
      w.push.mockImplementation(async () => {
        await gate;
        return { delivered: true };
      });
      jest.setSystemTime(at(DAY + 2 * HOUR));
      const a = w.v2.retryDueNotices(at(DAY + 2 * HOUR));
      const b = w.v2.retryDueNotices(at(DAY + 2 * HOUR));
      await flush();
      expect(w.push).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([a, b]);
      expect(w.push).toHaveBeenCalledTimes(1);
      expect(w.fake.find('dunningNoticeDelivery', { id: row.id as string })).toMatchObject({
        status: 'sent',
        attempts: 2,
        claim_token: null,
      });
    });

    it('a stale worker whose claim expired cannot overwrite the newer receipt', async () => {
      const row = await failedDay1Push();
      let releaseSlow: () => void = () => undefined;
      const slowGate = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      w.push.mockReset();
      w.push.mockImplementationOnce(async () => {
        await slowGate;
        return { delivered: false, code: 'provider-error' };
      });
      w.push.mockImplementation(async () => ({ delivered: true }));
      jest.setSystemTime(at(DAY + 2 * HOUR));
      const slow = w.v2.retryDueNotices(at(DAY + 2 * HOUR));
      await flush();
      // The slow worker's claim expires; a new worker takes the row over.
      jest.setSystemTime(at(DAY + 2 * HOUR + 11 * MIN));
      await w.v2.retryDueNotices(at(DAY + 2 * HOUR + 11 * MIN));
      expect(w.fake.find('dunningNoticeDelivery', { id: row.id as string })?.status).toBe('sent');
      releaseSlow();
      await slow;
      expect(w.fake.find('dunningNoticeDelivery', { id: row.id as string })).toMatchObject({
        status: 'sent',
        attempts: 3,
      });
    });

    it('a crashed worker (claim expired, outcome unknown): the email takeover reuses the same idempotency key', async () => {
      await failRenewal(w);
      w.email.mockImplementation(async () => ({ status: 'failed', error: 'provider 500' }));
      jest.setSystemTime(at(DAY + HOUR));
      await w.v2.runSweep(at(DAY + HOUR));
      const row = w.fake
        .rows('dunningNoticeDelivery')
        .find((r) => r.channel === 'client_email' && r.step_index === 1)!;
      // A worker claimed retry attempt 1 and died after (maybe) sending.
      Object.assign(row, {
        status: 'sending',
        claim_token: 'dead-worker',
        key_attempt: 1,
        attempts: 2,
        next_attempt_at: at(DAY + 2 * HOUR),
      });
      w.email.mockReset();
      w.email.mockImplementation(async () => ({ status: 'skipped' }));
      jest.setSystemTime(at(DAY + 3 * HOUR));
      await w.v2.retryDueNotices(at(DAY + 3 * HOUR));
      expect(w.email).toHaveBeenCalledTimes(1);
      const key = (w.email.mock.calls[0] as unknown[])[0] as { idempotencyKey: string };
      expect(key.idempotencyKey).toMatch(/:email:1:r1$/);
      expect(w.fake.find('dunningNoticeDelivery', { id: row.id as string })).toMatchObject({
        status: 'skipped',
        attempts: 3,
        claim_token: null,
      });
    });

    it('the cycle ends between the retry read and the send: the claimed row is canceled, nothing is sent', async () => {
      const row = await failedDay1Push();
      w.push.mockReset();
      w.push.mockImplementation(async () => ({ delivered: true }));
      // The cycle ends (paid meanwhile) right after this worker's claim
      // commits, i.e. after the retry read and before any transport call.
      const deliveries = w.prisma.dunningNoticeDelivery;
      const claimWrite = deliveries.updateMany.getMockImplementation();
      deliveries.updateMany.mockImplementation(async (args: { data?: { status?: string } }) => {
        const out = await claimWrite(args);
        if (args.data?.status === 'sending') stateRow(w)!.status = 'resolved';
        return out;
      });
      jest.setSystemTime(at(DAY + 2 * HOUR));
      await w.v2.retryDueNotices(at(DAY + 2 * HOUR));
      expect(w.push).not.toHaveBeenCalled();
      expect(w.fake.find('dunningNoticeDelivery', { id: row.id as string })?.status).toBe(
        'canceled',
      );
    });

    it('a due channel does not drag a not-yet-due channel of the same step into the send', async () => {
      const row = await failedDay1Push();
      const email = w.fake
        .rows('dunningNoticeDelivery')
        .find((r) => r.channel === 'client_email' && r.step_index === 1)!;
      Object.assign(email, { status: 'failed', attempts: 1, next_attempt_at: at(DAY + 5 * HOUR) });
      w.push.mockReset();
      w.push.mockImplementation(async () => ({ delivered: true }));
      w.email.mockClear();
      jest.setSystemTime(at(DAY + 2 * HOUR));
      await w.v2.retryDueNotices(at(DAY + 2 * HOUR));
      expect(w.push).toHaveBeenCalledTimes(1);
      expect(w.email).not.toHaveBeenCalled();
      expect(w.fake.find('dunningNoticeDelivery', { id: row.id as string })?.status).toBe('sent');
      expect(w.fake.find('dunningNoticeDelivery', { id: email.id as string })?.status).toBe(
        'failed',
      );
    });
  });

  describe('B-322-7 contract: the partial-busy answer the paired client must accept', () => {
    it('one plan paid, another plan busy: outcome in_progress with the 15000 cents paid and partial access', async () => {
      await failRenewal(w);
      addSecondPlan(w);
      jest.setSystemTime(at(2 * DAY));
      w.fake.seed('clientBillingLease', {
        purchase_id: 'purchase-2',
        holder: 'another-live-worker',
        holder_until: new Date(Date.now() + 120000),
        fence: 4,
      });
      const { res } = await cardUpdate(w, 'pm_new_ok', 95);
      expect(res).toMatchObject({
        outcome: 'in_progress',
        amount_paid_cents: 15000,
        paid_totals: [{ currency: 'usd', amount_cents: 15000 }],
        access_state: 'partial',
      });
      expect(res.plans.map((p) => p.outcome).sort()).toEqual(['in_progress', 'paid']);
      expect(w.stripe.charges).toHaveLength(1);
      if (process.env['DUMP_R4_CONTRACT']) {
        // eslint-disable-next-line no-console
        console.log(`R4_CONTRACT ${JSON.stringify(res)}`);
      }
    });
  });
});

describe('S-DUNNING-R5: every dispute webhook records its obligation (B-628-8 races)', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  const prevPk = process.env['STRIPE_PUBLISHABLE_KEY'];
  let w: World;

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'pk_test_r5';
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

  /** Recovered renewal, then dispute A on charge ch_a opens a compressed cycle. */
  async function cycleFromDisputeA(): Promise<void> {
    await failRenewal(w);
    w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
    w.stripe.stripeRetry('in_dv2_renewal_1');
    await w.handler.handle(fixture('invoice.paid'));
    await flush();
    expect(stateRow(w)?.status).toBe('resolved');
    jest.setSystemTime(at(12 * DAY));
    for (const ch of ['ch_a', 'ch_b']) {
      w.fake.seed('connectTransfer', {
        id: `tr-${ch}`,
        purchase_id: 'purchase-1',
        source_stripe_charge_id: ch,
      });
    }
    w.fake.seed('chargeDispute', {
      id: 'cd-a',
      purchase_id: 'purchase-1',
      stripe_dispute_id: 'dp_a',
      stripe_charge_id: 'ch_a',
      amount_cents: 15000,
      currency: 'usd',
      status: 'needs_response',
      created_at: at(12 * DAY),
    });
    const opened = await w.v2.detectAndHandleLateReversal({
      chargeId: 'ch_a',
      disputeId: 'dp_a',
      reversedChargeAt: at(12 * DAY),
    });
    expect(opened.opened).toBe(true);
  }

  const obligation = (id: string) =>
    w.fake.find('dunningDisputeObligation', { stripe_dispute_id: id });

  it('dispute B is created while A is open and its ledger row is not committed yet: A winning keeps the lock', async () => {
    await cycleFromDisputeA();
    jest.setSystemTime(at(13 * DAY));
    // B's dunning probe runs; the refund / dispute handler's transaction
    // that writes B's ChargeDispute row has not committed (no ledger row).
    const probeB = await w.v2.detectAndHandleLateReversal({
      chargeId: 'ch_b',
      disputeId: 'dp_b',
      reversedChargeAt: at(13 * DAY),
    });
    expect(probeB).toEqual({ opened: false, reason: 'cycle_already_active' });
    expect(obligation('dp_b')).toMatchObject({ status: 'open', purchase_id: 'purchase-1' });
    w.fake.find('chargeDispute', { id: 'cd-a' })!.status = 'won';
    const closedA = await w.v2.onDisputeClosed({
      chargeId: 'ch_a',
      disputeId: 'dp_a',
      status: 'won',
    });
    expect(closedA).toEqual({ resolved: false, reason: 'other_dispute_outstanding' });
    expect(stateRow(w)).toMatchObject({ status: 'active', last_failure_reason: 'charge_disputed' });
    expect(obligation('dp_a')?.status).toBe('won');
    // B wins later: now every obligation is settled in the client's favour.
    const closedB = await w.v2.onDisputeClosed({
      chargeId: 'ch_b',
      disputeId: 'dp_b',
      status: 'won',
    });
    expect(closedB).toEqual({ resolved: true, reason: 'dispute_won' });
    expect(stateRow(w)?.status).toBe('resolved');
  });

  it("A wins before B's probe runs: B (created before that resolution) reopens the reversal cycle", async () => {
    await cycleFromDisputeA();
    jest.setSystemTime(at(14 * DAY));
    const closedA = await w.v2.onDisputeClosed({
      chargeId: 'ch_a',
      disputeId: 'dp_a',
      status: 'won',
    });
    expect(closedA.resolved).toBe(true);
    // B was created on Day 13 (before A's resolution), its probe lands now.
    const probeB = await w.v2.detectAndHandleLateReversal({
      chargeId: 'ch_b',
      disputeId: 'dp_b',
      reversedChargeAt: at(13 * DAY),
    });
    expect(probeB).toEqual({ opened: true, reason: 'compressed_cycle_opened' });
    expect(stateRow(w)).toMatchObject({ status: 'active', last_failure_reason: 'charge_disputed' });
    // A redelivered created probe for B is a no-op (not a second cycle).
    const again = await w.v2.detectAndHandleLateReversal({
      chargeId: 'ch_b',
      disputeId: 'dp_b',
      reversedChargeAt: at(13 * DAY),
    });
    expect(again.opened).toBe(false);
  });

  it("B's closed (won) webhook lands before its created one: the late created event opens nothing", async () => {
    await cycleFromDisputeA();
    w.fake.find('chargeDispute', { id: 'cd-a' })!.status = 'won';
    expect(
      (await w.v2.onDisputeClosed({ chargeId: 'ch_a', disputeId: 'dp_a', status: 'won' })).resolved,
    ).toBe(true);
    jest.setSystemTime(at(15 * DAY));
    const closedB = await w.v2.onDisputeClosed({
      chargeId: 'ch_b',
      disputeId: 'dp_b',
      status: 'won',
    });
    expect(closedB).toEqual({ resolved: false, reason: 'no_open_dispute_cycle' });
    const lateCreated = await w.v2.detectAndHandleLateReversal({
      chargeId: 'ch_b',
      disputeId: 'dp_b',
      reversedChargeAt: at(15 * DAY),
    });
    expect(lateCreated).toEqual({ opened: false, reason: 'dispute_already_won' });
    expect(stateRow(w)?.status).toBe('resolved');
  });

  it('a lost closure is recorded and outvotes a later contradictory won event for the same dispute', async () => {
    await cycleFromDisputeA();
    const lost = await w.v2.onDisputeClosed({
      chargeId: 'ch_a',
      disputeId: 'dp_a',
      status: 'lost',
    });
    expect(lost).toEqual({ resolved: false, reason: 'not_won' });
    expect(obligation('dp_a')?.status).toBe('lost');
    const won = await w.v2.onDisputeClosed({ chargeId: 'ch_a', disputeId: 'dp_a', status: 'won' });
    expect(won.resolved).toBe(false);
    expect(obligation('dp_a')?.status).toBe('lost');
    expect(stateRow(w)?.status).toBe('active');
  });

  it('the Day 10 sweep locks while a recorded obligation is open, even when the ledger shows only won disputes', async () => {
    await cycleFromDisputeA();
    await w.v2.detectAndHandleLateReversal({
      chargeId: 'ch_b',
      disputeId: 'dp_b',
      reversedChargeAt: at(13 * DAY),
    });
    w.fake.find('chargeDispute', { id: 'cd-a' })!.status = 'won';
    const lockAt = at(19 * DAY + 10 * MIN);
    jest.setSystemTime(lockAt);
    expect((await w.v2.runSweep(lockAt)).locked).toBe(1);
    expect(stateRow(w)?.locked_out_at).toBeInstanceOf(Date);
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');
  });

  it('the webhook passes the Stripe dispute id to the dunning probe (obligation recorded from charge.dispute.created)', async () => {
    await cycleFromDisputeA();
    await w.handler.handle(
      stub({
        id: 'evt_dp_b_created',
        type: 'charge.dispute.created',
        created: sec(at(13 * DAY)),
        livemode: false,
        data: {
          object: {
            id: 'dp_b',
            object: 'dispute',
            charge: 'ch_b',
            payment_intent: null,
            status: 'needs_response',
            amount: 15000,
            currency: 'usd',
            created: sec(at(13 * DAY)),
          },
        },
      }),
    );
    await flush();
    expect(obligation('dp_b')).toMatchObject({ status: 'open', stripe_charge_id: 'ch_b' });
  });

  it('a renewal charge with no settlement transfer yet resolves through Stripe (charge -> invoice -> subscription), whichever route created the subscription', async () => {
    await cycleFromDisputeA();
    w.stripe.chargeObjects.set('ch_renewal_9', {
      id: 'ch_renewal_9',
      amount: 15000,
      invoice: 'in_dv2_renewal_1',
      payment_intent: 'pi_renewal_9',
    });
    const probe = await w.v2.detectAndHandleLateReversal({
      chargeId: 'ch_renewal_9',
      disputeId: 'dp_renewal_9',
      paymentIntentId: 'pi_renewal_9',
      reversedChargeAt: at(13 * DAY),
    });
    expect(probe.reason).toBe('cycle_already_active');
    expect(obligation('dp_renewal_9')).toMatchObject({
      purchase_id: 'purchase-1',
      status: 'open',
    });
  });

  describe('B-RECUR seam: dunning keys off invoice / subscription events, however the subscription was created', () => {
    it('the FIRST invoice of a native (default_incomplete) subscription fails in the PaymentSheet: no past_due, no cycle, no banner, no notice', async () => {
      const p = purchaseRow(w)!;
      Object.assign(p, { status: 'pending', entitlement_active: false });
      w.push.mockClear();
      w.email.mockClear();
      await w.handler.handle(
        fixture('invoice.payment_failed', {
          billing_reason: 'subscription_create',
          attempt_count: 1,
        }),
      );
      await flush();
      expect(purchaseRow(w)).toMatchObject({ status: 'pending', entitlement_active: false });
      expect(stateRow(w)?.status ?? 'none').not.toBe('active');
      expect(w.fake.rows('dunningNoticeDelivery')).toHaveLength(0);
      expect(w.push).not.toHaveBeenCalled();
      expect(w.email).not.toHaveBeenCalled();
      expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
    });

    it('a subscription_create failure on a purchase already marked active is still not a missed renewal', async () => {
      await w.handler.handle(
        fixture('invoice.payment_failed', {
          billing_reason: 'subscription_create',
          attempt_count: 1,
        }),
      );
      await flush();
      expect(purchaseRow(w)?.status).toBe('active');
      expect(stateRow(w)?.status ?? 'none').not.toBe('active');
    });

    it('a renewal (subscription_cycle) of a natively created subscription (no Checkout session) enters the v2 cycle on Day 0', async () => {
      const p = purchaseRow(w)!;
      Object.assign(p, { stripe_checkout_session_id: null, stripe_payment_intent_id: null });
      await failRenewal(w);
      expect(purchaseRow(w)?.status).toBe('past_due');
      expect(stateRow(w)).toMatchObject({ status: 'active', step_index: 0 });
      expect((await w.v2.getClientStatus('client-1')).state).toBe('past_due');
    });
  });

  it('mergeDisputeObligations: a final status on either record wins; a not-in-favour final status beats a won one', () => {
    const merged = mergeDisputeObligations(
      [
        { stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1', status: 'needs_response' },
        { stripe_dispute_id: 'dp_2', stripe_charge_id: 'ch_2', status: 'won' },
        { stripe_dispute_id: 'dp_3', stripe_charge_id: 'ch_3', status: 'lost' },
      ],
      [
        { stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1', status: 'won' },
        { stripe_dispute_id: 'dp_2', stripe_charge_id: 'ch_2', status: 'lost' },
        { stripe_dispute_id: 'dp_3', stripe_charge_id: 'ch_3', status: 'won' },
        { stripe_dispute_id: 'dp_4', stripe_charge_id: null, status: 'open' },
      ],
    );
    const by = Object.fromEntries(merged.map((d) => [d.stripe_dispute_id, d.status]));
    expect(by).toEqual({ dp_1: 'won', dp_2: 'lost', dp_3: 'lost', dp_4: 'open' });
  });
});
