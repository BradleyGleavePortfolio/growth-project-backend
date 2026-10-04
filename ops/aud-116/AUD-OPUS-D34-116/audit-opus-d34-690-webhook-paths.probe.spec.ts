/* AUDIT PROBE (AUD-OPUS-D34-116, Claude Opus 5.5 lens) on #690 @ f72668c2 - never merge. Harness copied from test/dunning-r2-native-card-1a-2a-e2e.spec.ts. */
/* eslint-disable */
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

describe('AUDIT PROBE #690: webhook dispute / cancel paths', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  const prevPk = process.env['STRIPE_PUBLISHABLE_KEY'];
  let w: World;
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'pk_test_probe';
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
    w = buildWorld();
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
    if (prevPk === undefined) delete process.env['STRIPE_PUBLISHABLE_KEY'];
    else process.env['STRIPE_PUBLISHABLE_KEY'] = prevPk;
  });

  /** Renewal fails, Stripe's retry pays it, Day 12 the client disputes it. */
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
      disputeId: 'dp_1',
      chargeId: 'ch_1',
    });
    expect(r.opened).toBe(true);
  }

  /** Day 14: the next renewal is paid by Stripe (dispute dp_1 still open). */
  async function nextRenewalPaid(): Promise<void> {
    jest.setSystemTime(at(14 * DAY));
    w.stripe.addInvoice({ id: 'in_dv2_renewal_2', subscription: 'sub_dv2_client', amount_due: 15000, created: sec(at(14 * DAY)) });
    w.stripe.stripeRetry('in_dv2_renewal_2');
  }

  it('W0 control: invoice.paid during an open dispute keeps the dispute cycle (FIX ROUND 8)', async () => {
    await openDispute();
    await nextRenewalPaid();
    await w.handler.handle(fixture('invoice.paid', { id: 'in_dv2_renewal_2' }));
    await flush();
    expect(stateRow(w)).toMatchObject({ status: 'active', last_failure_reason: 'charge_disputed' });
    expect(await w.v2.isDisputeCycleOpen('purchase-1')).toBe(true);
  });

  it('W1: one failed dispute read on invoice.paid must not settle the dispute cycle (fail closed)', async () => {
    await openDispute();
    await nextRenewalPaid();
    const spy = jest
      .spyOn(w.v2, 'isDisputeCycleOpen')
      .mockRejectedValueOnce(Object.assign(new Error('pool timeout'), { code: 'P2024' }));
    let threw = false;
    try {
      await w.handler.handle(fixture('invoice.paid', { id: 'in_dv2_renewal_2' }));
    } catch {
      threw = true;
    }
    await flush();
    spy.mockRestore();
    // Stripe redelivers (or a duplicate arrives) with the database healthy.
    await w.handler.handle(fixture('invoice.paid', { id: 'in_dv2_renewal_2' }));
    await flush();
    const lockAt = at(19 * DAY + 10 * MIN);
    jest.setSystemTime(lockAt);
    const sweep = await w.v2.runSweep(lockAt);
    const observed = {
      webhook_threw: threw,
      state_status: stateRow(w)?.status,
      state_reason: stateRow(w)?.last_failure_reason,
      dispute_cycle_open: await w.v2.isDisputeCycleOpen('purchase-1'),
      locked_on_dispute_day: sweep.locked,
    };
    console.log(`PROBE W1 observed ${JSON.stringify(observed)}`);
    expect(observed).toMatchObject({
      state_status: 'active',
      state_reason: 'charge_disputed',
      dispute_cycle_open: true,
      locked_on_dispute_day: 1,
    });
  });

  it('W2: a late invoice.payment_failed after a 2A cancel does not flip the ended plan back to past_due', async () => {
    await failRenewal(w);
    await stripeRetryFails(w, at(DAY + HOUR), 2);
    jest.setSystemTime(at(4 * DAY));
    const res = await w.billing.cancelPlan('client-1', 'purchase-1');
    expect(res.outcome).toBe('ended');
    expect(purchaseRow(w)).toMatchObject({ status: 'canceled', entitlement_active: false });
    // Out-of-order delivery: the Day-3 retry's payment_failed arrives late.
    await w.handler.handle(fixture('invoice.payment_failed', { attempt_count: 3 }));
    await flush();
    const observed = {
      purchase_status: purchaseRow(w)?.status,
      entitlement_active: purchaseRow(w)?.entitlement_active,
      state_status: stateRow(w)?.status,
      last_error: purchaseRow(w)?.last_error ?? null,
    };
    console.log(`PROBE W2 observed ${JSON.stringify(observed)}`);
    expect(observed).toMatchObject({ purchase_status: 'canceled', state_status: 'abandoned' });
  });
});
