import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { NotificationKind } from '../src/notifications/notification-kind';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

/**
 * S-DUNNING — deterministic end-to-end lifecycle of Smart Dunning v2, driven
 * by Stripe-shaped event fixtures (test/fixtures/stripe/dunning-v2/*.json)
 * through the REAL webhook handler, v1 DunningService, v2 service + real
 * dispatcher, the hourly sweep, the DunningLockoutGuard and the
 * ClientEntitlementGuard. The clock is faked; the database is the in-memory
 * FakePrisma; Stripe HTTP, push, email and coach alerts are recording mocks.
 *
 * The four owner flows:
 *   A. fail Day 0 -> Stripe retries -> pays on Day 3 -> recovered, never locked
 *   B. fail through Day 10 -> locked -> pays -> unlocked immediately
 *   C. voluntary cancel -> access through the paid period -> then off, no dunning
 *   D. comp / invite-code client -> never enters dunning, never locked
 * plus the audit regressions (F3 tx join, F5 skipped resync, F6 entitlement
 * resync, F9 overlapping sweeps, F11 refund vs dispute).
 */

const FIXTURES = join(__dirname, 'fixtures', 'stripe', 'dunning-v2');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-10-05T16:00:00.000Z'); // Day 0: renewal charge fails

/**
 * Test doubles stand in for Nest providers (PrismaService, Stripe client,
 * notification transports) structurally; `stub` hands them to typed
 * constructor slots without a cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;

let eventSeq = 0;

/** Load a Stripe event fixture and overlay fields on its data.object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fixture(name: string, object: Record<string, unknown> = {}): any {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  eventSeq += 1;
  return {
    ...raw,
    id: `${raw.id}_${eventSeq}`,
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

function ctxFor(path: string, user?: { id: string; role: string }) {
  const req = { path, user };
  return stub({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => FakeController.prototype.handler,
    getClass: () => FakeController,
  });
}

interface World {
  fake: FakePrisma;
  handler: CheckoutWebhookHandlerService;
  v2: DunningV2Service;
  lockGuard: DunningLockoutGuard;
  entitlementGuard: ClientEntitlementGuard;
  stripe: {
    retrieveSubscription: jest.Mock;
    retrievePaymentMethod: jest.Mock;
    cancelSubscription: jest.Mock;
  };
  push: jest.Mock;
  email: jest.Mock;
  coachAlert: jest.Mock;
  lockoutEntered: jest.Mock;
  stripeSubStatus: { value: string };
}

function buildWorld(): World {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const stripeSubStatus = { value: 'past_due' };
  const stripe = {
    retrieveSubscription: jest.fn(async (id: string) => ({
      id,
      status: stripeSubStatus.value,
      current_period_end: sec(at(30 * DAY)),
      canceled_at: null,
    })),
    retrievePaymentMethod: jest.fn(async () => ({ card: { last4: '4242' } })),
    // Present only so a stray cancel would be observed (v2 must never call it).
    cancelSubscription: jest.fn(async () => ({ status: 'canceled' })),
  };
  const push = jest.fn(async () => true);
  const email = jest.fn(async () => ({ ok: true }));
  const coachAlert = jest.fn(async () => undefined);
  const notifications = {
    pushToUser: push,
    pushToCoach: jest.fn(async () => true),
    createNotification: jest.fn(async (n: { user_id: string; kind: string; body: string }) =>
      fake.seed('notification', { ...n, read_at: null, created_at: new Date() }),
    ),
  };
  const telemetry = new DunningV2Telemetry();
  const lockoutEntered = jest.fn();
  telemetry.lockoutEntered = lockoutEntered;
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    telemetry,
    stub(notifications),
    stub({ send: email }),
    stub({ emit: coachAlert }),
  );
  const v2 = new DunningV2Service(prisma, telemetry, dispatcher, stub(stripe));
  const v1 = new DunningService(prisma, stub(stripe));
  const handler = new CheckoutWebhookHandlerService(
    prisma,
    stub(stripe),
    undefined, // splits
    v1,
    undefined, // refundDispute
    undefined, // fanout
    undefined, // payoutRouting
    v2,
  );
  const lockGuard = new DunningLockoutGuard(prisma);
  const entitlementGuard = new ClientEntitlementGuard(prisma, new Reflector());

  // ── Seed: coach, client, paid monthly package, card on file ──
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
    default_card_last4: '0341',
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
  });
  // Another tenant's open blocker — must never be touched by client-1's recovery.
  fake.seed('notification', {
    id: 'n-other',
    user_id: 'client-2',
    kind: NotificationKind.DUNNING_BLOCKER,
    body: 'other',
    read_at: null,
  });

  return {
    fake,
    handler,
    v2,
    lockGuard,
    entitlementGuard,
    stripe,
    push,
    email,
    coachAlert,
    lockoutEntered,
    stripeSubStatus,
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

async function failAttempt(w: World, attempt: number) {
  await w.handler.handle(fixture('invoice.payment_failed', { attempt_count: attempt }));
  await flush();
}

async function pastDueResync(w: World) {
  await w.handler.handle(
    fixture('customer.subscription.updated.past_due', {
      current_period_start: sec(at(0)),
      current_period_end: sec(at(30 * DAY)),
    }),
  );
}

function stateRow(w: World) {
  return w.fake.find('dunningState', { purchase_id: 'purchase-1' });
}

function purchaseRow(w: World) {
  return w.fake.find('clientPurchase', { id: 'purchase-1' });
}

describe('Smart Dunning v2 end-to-end lifecycle (Stripe fixtures, fake clock)', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  let w: World;

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
    w = buildWorld();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
  });

  it('A. fail Day 0 -> Stripe retry Day 1 fails -> pays on the Day 3 retry -> recovered, never locked', async () => {
    // Day 0 — Stripe moves the subscription to past_due and the charge fails.
    await pastDueResync(w);
    await failAttempt(w, 1);
    expect(stateRow(w)).toMatchObject({ status: 'active', step_index: 0 });
    expect((stateRow(w)?.entered_at as Date).toISOString()).toBe(T0.toISOString());
    expect(w.push).toHaveBeenCalledTimes(1); // Day 0: push only
    expect(w.email).not.toHaveBeenCalled();
    // Days 0-9: full access (past_due under v2 still entitles; F7).
    expect(await entitlementVerdict(w)).toBe('allowed');
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    const status0 = await w.v2.getClientStatus('client-1');
    expect(status0).toMatchObject({
      enabled: true,
      state: 'past_due',
      amount_cents: 15000,
      currency: 'usd',
      day: 0,
      coach_name: 'Morgan Coach',
      card_last4: '0341',
      lockout_at: at(10 * DAY).toISOString(),
    });

    // Day 1 — Stripe's first scheduled retry fails.
    jest.setSystemTime(at(DAY + HOUR));
    await failAttempt(w, 2);
    expect(stateRow(w)?.step_index).toBe(1);
    expect(w.push).toHaveBeenCalledTimes(2);
    expect(w.email).toHaveBeenCalledTimes(1);
    expect(w.email.mock.calls[0][0]).toMatchObject({ to: 'client@tgp.invalid' });
    // The hourly sweep in the same hour sends nothing new (step already claimed).
    await w.v2.runSweep(at(DAY + 2 * HOUR));
    expect(w.push).toHaveBeenCalledTimes(2);

    // Day 3 — Stripe's second retry succeeds.
    jest.setSystemTime(at(3 * DAY + HOUR));
    w.stripeSubStatus.value = 'active';
    await w.handler.handle(
      fixture('invoice.paid', { status_transitions: { paid_at: sec(at(3 * DAY + HOUR)) } }),
    );
    await flush();
    expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
    expect(purchaseRow(w)).toMatchObject({ status: 'active', entitlement_active: true });
    expect((await w.v2.getClientStatus('client-1')).state).toBe('none');

    // Day 10+ — nothing to lock; the sweep is quiet.
    const out = await w.v2.runSweep(at(11 * DAY));
    expect(out).toEqual({ locked: 0, advanced: 0, skipped: 0 });
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');

    // Our code never charged and never cancelled: only reads hit Stripe.
    expect(w.stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it('B. fail through Day 10 -> locked (calm 403 + reachable recovery surfaces) -> pays -> unlocked at once', async () => {
    await pastDueResync(w);
    await failAttempt(w, 1); // Day 0
    jest.setSystemTime(at(DAY + HOUR));
    await failAttempt(w, 2); // Day 1
    jest.setSystemTime(at(3 * DAY + HOUR));
    await failAttempt(w, 3); // Day 3 — in-app blocker
    expect(stateRow(w)?.step_index).toBe(2);
    expect(
      w.fake
        .rows('notification')
        .filter((n) => n.user_id === 'client-1' && n.kind === NotificationKind.DUNNING_BLOCKER),
    ).toHaveLength(1);
    expect(w.coachAlert).not.toHaveBeenCalled();
    jest.setSystemTime(at(7 * DAY + HOUR));
    await failAttempt(w, 4); // Day 7 — final notice + coach on all channels
    expect(stateRow(w)?.step_index).toBe(3);
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
    expect(w.coachAlert.mock.calls[0][0]).toMatchObject({
      coachId: 'coach-1',
      clientUserId: 'client-1',
    });

    // Day 9, 23:00 after T0 — still full access.
    await w.v2.runSweep(at(10 * DAY - HOUR));
    expect(stateRow(w)?.locked_out_at).toBeNull();
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');

    // Day 10 — the hourly sweep (minute 7) locks, after Stripe confirms unpaid.
    const lockAt = at(10 * DAY + 7 * 60 * 1000);
    jest.setSystemTime(lockAt);
    // Two machines run the same tick (F9): exactly one lock, one telemetry event.
    const [s1, s2] = await Promise.all([w.v2.runSweep(lockAt), w.v2.runSweep(lockAt)]);
    expect(s1.locked + s2.locked).toBe(1);
    expect(w.lockoutEntered).toHaveBeenCalledTimes(1);
    expect(stateRow(w)?.locked_out_at).toEqual(lockAt);
    expect(purchaseRow(w)?.entitlement_active).toBe(false);

    // What is blocked and what stays reachable.
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');
    expect(await lockVerdict(w, '/api/community/feed')).toBe('LOCKED_DUNNING');
    expect(await lockVerdict(w, '/api/messages/voice-upload')).toBe('LOCKED_DUNNING');
    for (const reachable of [
      '/api/v1/checkout/billing-portal', // Update card (Stripe portal)
      '/api/v1/checkout/dunning', // lockout screen status
      '/api/v1/me/data-export/request', // data export
      '/api/me/delete-account', // account deletion
      '/api/messages', // contact the coach
      '/api/messages/unread-count',
      '/api/auth/me', // stay signed in
      '/api/healthz',
    ]) {
      expect(await lockVerdict(w, reachable)).toBe('allowed');
    }
    expect(await w.v2.getClientStatus('client-1')).toMatchObject({
      state: 'locked',
      amount_cents: 15000,
      locked_at: lockAt.toISOString(),
    });

    // F6: a later customer.subscription.updated (still past_due) re-derives
    // entitlement_active=true; the lockout must hold anyway.
    await pastDueResync(w);
    expect(purchaseRow(w)?.entitlement_active).toBe(true);
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');

    // The client updates the card in the portal; Stripe pays the open invoice.
    jest.setSystemTime(at(10 * DAY + 3 * HOUR));
    w.stripeSubStatus.value = 'active';
    await w.handler.handle(fixture('invoice.paid'));
    await flush();
    expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
    expect(purchaseRow(w)).toMatchObject({ status: 'active', entitlement_active: true });
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    expect(await entitlementVerdict(w)).toBe('allowed');
    // F4: only client-1's blockers are dismissed.
    const blockers = w.fake
      .rows('notification')
      .filter((n) => n.kind === NotificationKind.DUNNING_BLOCKER);
    expect(blockers.find((n) => n.user_id === 'client-1')?.read_at).toBeInstanceOf(Date);
    expect(blockers.find((n) => n.id === 'n-other')?.read_at).toBeNull();
    // A redelivered invoice.paid is a no-op.
    await w.handler.handle(fixture('invoice.paid'));
    expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
    expect(w.stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it('C. voluntary cancel -> access through the paid period -> then off; never routed into dunning', async () => {
    const periodEnd = at(20 * DAY);
    await w.handler.handle(
      fixture('customer.subscription.updated.cancel_at_period_end', {
        current_period_start: sec(at(-10 * DAY)),
        current_period_end: sec(periodEnd),
        cancel_at: sec(periodEnd),
        canceled_at: sec(T0),
      }),
    );
    expect(purchaseRow(w)).toMatchObject({ status: 'active', entitlement_active: true });
    expect(stateRow(w)).toBeUndefined();

    // Mid-period: full access, no lockout, no notices, sweep idle.
    jest.setSystemTime(at(15 * DAY));
    expect(await entitlementVerdict(w)).toBe('allowed');
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    expect(await w.v2.runSweep(at(15 * DAY))).toEqual({ locked: 0, advanced: 0, skipped: 0 });
    expect((await w.v2.getClientStatus('client-1')).state).toBe('none');

    // Period end: Stripe deletes the subscription. Access ends (paywall),
    // and it is NOT a dunning lockout.
    jest.setSystemTime(at(20 * DAY + HOUR));
    await w.handler.handle(
      fixture('customer.subscription.deleted', {
        canceled_at: sec(periodEnd),
        ended_at: sec(periodEnd),
        current_period_end: sec(periodEnd),
      }),
    );
    expect(purchaseRow(w)).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(await entitlementVerdict(w)).toBe(402);
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    expect(stateRow(w)).toBeUndefined();
    expect(w.push).not.toHaveBeenCalled();
    expect(w.email).not.toHaveBeenCalled();
  });

  it('D. comp / invite-code client: never claimed, never notified, never locked', async () => {
    w.fake.seed('user', {
      id: 'comp-1',
      name: 'Comp Client',
      email: 'comp@tgp.invalid',
      role: 'student',
    });
    w.fake.seed('clientPurchase', {
      id: 'purchase-comp',
      client_user_id: 'comp-1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      status: 'active',
      entitlement_active: true,
      billing_type: 'one_time',
      amount_cents: 0,
      currency: 'usd',
      stripe_subscription_id: null,
      access_expires_at: null,
    });
    // Even a stray active DunningState on the grant is inert.
    w.fake.seed('dunningState', {
      id: 'ds-comp',
      purchase_id: 'purchase-comp',
      status: 'active',
      step_index: -1,
      entered_at: at(-30 * DAY),
      locked_out_at: null,
      reversal_count: 0,
    });
    // An invoice event for an unknown subscription is not claimed.
    const res = await w.handler.handle(
      fixture('invoice.payment_failed', { subscription: 'sub_unknown_comp' }),
    );
    expect(res.claimed).toBe(false);
    expect(await w.v2.recordPaymentFailed('purchase-comp')).toBeNull();
    const sweep = await w.v2.runSweep(at(40 * DAY));
    expect(sweep.locked).toBe(0);
    expect(w.fake.find('dunningState', { id: 'ds-comp' })).toMatchObject({
      step_index: -1,
      locked_out_at: null,
    });
    const comp = { id: 'comp-1', role: 'student' };
    await expect(w.lockGuard.canActivate(ctxFor('/api/v1/workouts', comp))).resolves.toBe(true);
    await expect(w.entitlementGuard.canActivate(ctxFor('/api/v1/workouts', comp))).resolves.toBe(
      true,
    );
    expect((await w.v2.getClientStatus('comp-1')).state).toBe('none');
    expect(w.push).not.toHaveBeenCalled();
    expect(
      DunningV2Service.isEligiblePurchase({
        amount_cents: 0,
        billing_type: 'recurring',
        stripe_subscription_id: 'sub_x',
      }),
    ).toBe(false);
  });

  it('D2. a client locked on a paid package but holding a comp grant keeps access', async () => {
    await pastDueResync(w);
    await failAttempt(w, 1);
    w.fake.seed('clientPurchase', {
      id: 'purchase-comp-2',
      client_user_id: 'client-1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      status: 'paid',
      entitlement_active: true,
      billing_type: 'one_time',
      amount_cents: 0,
      currency: 'usd',
      stripe_subscription_id: null,
      access_expires_at: null,
    });
    await w.v2.runSweep(at(10 * DAY + HOUR));
    expect(stateRow(w)?.locked_out_at).toBeInstanceOf(Date);
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
  });

  it('F3: invoice.paid inside the caller tx joins it (no second transaction / connection)', async () => {
    await pastDueResync(w);
    await failAttempt(w, 1);
    await w.v2.runSweep(at(10 * DAY + HOUR));
    expect(stateRow(w)?.locked_out_at).toBeInstanceOf(Date);
    const before = w.fake.transactionCalls;
    const writesBefore = w.fake.writes.length;
    const tx = w.fake.client(true);
    await w.handler.handle(fixture('invoice.paid'), tx, {
      invoiceSubscription: stub({
        id: 'sub_dv2_client',
        status: 'active',
        current_period_end: sec(at(40 * DAY)),
      }),
    });
    expect(w.fake.transactionCalls).toBe(before);
    const purchaseWrites = w.fake.writes
      .slice(writesBefore)
      .filter((x) => x.model === 'clientPurchase');
    expect(purchaseWrites.length).toBeGreaterThan(0);
    expect(purchaseWrites.every((x) => x.viaTx)).toBe(true);
    expect(stateRow(w)?.locked_out_at).toBeNull();
  });

  it('F5: a skipped renewal resync (outer tx, no prefetch) still closes dunning and unlocks', async () => {
    await pastDueResync(w);
    await failAttempt(w, 1);
    await w.v2.runSweep(at(10 * DAY + HOUR));
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('LOCKED_DUNNING');
    await w.handler.handle(fixture('invoice.paid'), w.fake.client(true), undefined);
    expect(stateRow(w)).toMatchObject({ status: 'resolved', locked_out_at: null });
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
  });

  it('never locks on uncertainty: Stripe says paid, or Stripe is unreachable', async () => {
    await pastDueResync(w);
    await failAttempt(w, 1);
    w.stripeSubStatus.value = 'active';
    expect((await w.v2.runSweep(at(10 * DAY + HOUR))).locked).toBe(0);
    w.stripe.retrieveSubscription.mockRejectedValueOnce(new Error('stripe 503'));
    expect((await w.v2.runSweep(at(10 * DAY + 2 * HOUR))).locked).toBe(0);
    expect(stateRow(w)?.locked_out_at).toBeNull();
  });

  it('F11: a refund never opens a dunning cycle; a dispute opens the compressed one', async () => {
    await pastDueResync(w);
    await failAttempt(w, 1);
    w.stripeSubStatus.value = 'active';
    jest.setSystemTime(at(2 * DAY));
    await w.handler.handle(fixture('invoice.paid'));
    expect(stateRow(w)?.status).toBe('resolved');
    w.fake.seed('connectTransfer', {
      id: 'tr-1',
      purchase_id: 'purchase-1',
      source_stripe_charge_id: 'ch_dv2_retry_paid',
    });

    jest.setSystemTime(at(5 * DAY));
    await w.handler.handle(fixture('charge.refunded', { created: sec(at(5 * DAY)) }));
    await flush();
    expect(stateRow(w)?.status).toBe('resolved');

    await w.handler.handle(fixture('charge.dispute.created', { created: sec(at(5 * DAY)) }));
    await flush();
    expect(stateRow(w)).toMatchObject({ status: 'active', step_index: 2, reversal_count: 1 });
    // Compressed: coach at +4 days, lock at +7 days from the dispute.
    const status = await w.v2.getClientStatus('client-1');
    expect(status.lockout_at).toBe(at(12 * DAY).toISOString());
  });

  it('flag OFF: v2 is inert end to end (no claim, no notice, no lock, past_due paywalled as before)', async () => {
    delete process.env['FEATURE_DUNNING_V2'];
    await pastDueResync(w);
    await failAttempt(w, 1);
    expect(stateRow(w)?.step_index).toBe(-1);
    expect(w.push).not.toHaveBeenCalled();
    expect(await w.v2.runSweep(at(11 * DAY))).toEqual({ locked: 0, advanced: 0, skipped: 0 });
    expect(await lockVerdict(w, '/api/v1/workouts')).toBe('allowed');
    expect(await entitlementVerdict(w)).toBe(402);
    expect((await w.v2.getClientStatus('client-1')).enabled).toBe(false);
  });
});
