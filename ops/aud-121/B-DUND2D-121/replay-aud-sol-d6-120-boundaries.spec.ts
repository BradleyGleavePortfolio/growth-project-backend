// AUD-SOL-D6-120 boundaries — REPLAY by B-DUND2D-121 (agent 121) on D2d. Adaptations marked `D2d REPLAY:`.
import { Logger } from '@nestjs/common';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// Synthetic boundary proof only: no live provider or customer data.
const T0 = new Date('2026-10-05T17:00:00.000Z');
type Args = { subscriptionId: string; idempotencyKey: string };
function harness() {
  const fake = new FakePrisma();
  fake.seed('clientPurchase', {
    id: 'p1', client_user_id: 'client-1', coach_user_id: 'coach-1', package_id: 'pkg-1',
    status: 'active', entitlement_active: true, billing_type: 'recurring',
    amount_cents: 15000, currency: 'usd', stripe_subscription_id: 'sub_1',
  });
  fake.seed('coachPackage', { id: 'pkg-1', billing_type: 'recurring' });
  fake.seed('connectTransfer', { id: 'tr1', source_stripe_charge_id: 'ch_1', purchase_id: 'p1' });
  let externallyPaused = false;
  const cache = new Map<string, { status: string }>();
  const mutate = async (a: Args, paused: boolean) => {
    const old = cache.get(a.idempotencyKey);
    if (old) return old; // A cached idempotent response does not execute again.
    externallyPaused = paused;
    const result = { status: 'active' };
    cache.set(a.idempotencyKey, result);
    return result;
  };
  const stripe = {
    pauseSubscriptionCollection: jest.fn((a: Args) => mutate(a, true)),
    resumeSubscriptionCollection: jest.fn((a: Args) => mutate(a, false)),
    listOpenInvoices: jest.fn(async () => []),
    markInvoiceUncollectible: jest.fn(async () => ({})),
  };
  const telemetry = { lockoutEntered: jest.fn(), lockoutExited: jest.fn(), reversalDetected: jest.fn() };
  const db = fake.client();
  const svc = new DunningV2Service(
    db,
    telemetry as unknown as ConstructorParameters<typeof DunningV2Service>[1],
    undefined,
    stripe as unknown as ConstructorParameters<typeof DunningV2Service>[3],
  );
  const created = (id = 'dp_1') => svc.detectAndHandleLateReversal({
    chargeId: 'ch_1', disputeId: id, reversedChargeAt: T0, now: T0,
  });
  const restart = () => svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1' });
  return { fake, db, svc, stripe, created, restart, paused: () => externallyPaused };
}

describe('AUD-SOL-D6-120 consequential boundaries at #705 exact head', () => {
  const prior = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (prior === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prior;
  });

  it('control: an uncontended coach restart resumes collection and access', async () => {
    const h = harness();
    await h.created();
    expect(h.paused()).toBe(true);
    expect(await h.restart()).toEqual({ restarted: true, reason: 'restarted' });
    expect(h.paused()).toBe(false);
    expect(h.fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
  });

  it('flag rollback never lets subscription.updated re-entitle a paused plan', async () => {
    const h = harness();
    await h.created();
    process.env.FEATURE_DUNNING_V2 = 'false';
    const u = undefined;
    const handler = new CheckoutWebhookHandlerService(
      h.db,
      h.stripe as unknown as ConstructorParameters<typeof CheckoutWebhookHandlerService>[1],
      u, u, u, u, u, h.svc,
    );
    await handler.handle({
      id: 'evt_rollback',
      type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_1', status: 'active', cancel_at_period_end: false,
        current_period_end: Math.floor(T0.getTime() / 1000) + 86400 * 30,
        pause_collection: { behavior: 'void' },
      } },
    } as Parameters<typeof handler.handle>[0]);
    expect(h.fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
  });

  it('a new dispute during resume really re-pauses Stripe, not just a cached response', async () => {
    const h = harness();
    await h.created();
    const resume = h.stripe.resumeSubscriptionCollection.getMockImplementation()!;
    h.stripe.resumeSubscriptionCollection.mockImplementationOnce(async (a) => {
      const answer = await resume(a);
      expect(h.paused()).toBe(false);
      await h.created('dp_2');
      return answer;
    });
    expect(await h.restart()).toEqual({ restarted: false, reason: 'new_dispute' });
    expect(h.fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    expect(h.paused()).toBe(true);
  });

  it('a new pause at the same millisecond after restart really stops collection', async () => {
    const h = harness();
    await h.created();
    await h.restart();
    expect(h.paused()).toBe(false);
    expect((await h.created('dp_2')).opened).toBe(true);
    expect(h.fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    expect(h.paused()).toBe(true);
  });

  it('a late in-flight pause cannot override a completed coach restart at Stripe', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pause = h.stripe.pauseSubscriptionCollection.getMockImplementation()!;
    h.stripe.pauseSubscriptionCollection.mockImplementationOnce(async (a) => {
      entered();
      await pending;
      return pause(a);
    });
    const opening = h.created();
    await started;
    // D2d REPLAY: operator ruling: a restart overlapping an in-flight pause returns billing_busy; the coach
    // restarts once the pause is done. The invariant (final Stripe state matches the completed restart) is kept.
    expect(await h.restart()).toEqual({ restarted: false, reason: 'billing_busy' });
    release();
    await opening;
    const restarted = await h.restart();
    expect(restarted).toEqual({ restarted: true, reason: 'restarted' });
    expect(h.fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
    expect(h.paused()).toBe(false);
  });

  it('a failed provider pause is not represented as confirmed billing_paused', async () => {
    const h = harness();
    h.stripe.pauseSubscriptionCollection.mockRejectedValueOnce(new Error('synthetic provider outage'));
    await expect(h.created()).rejects.toThrow('synthetic provider outage');
    expect(h.paused()).toBe(false);
    expect(h.fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    const status = await h.svc.getClientStatus('client-1');
    expect(status.billing_paused).toBe(false);
  });

  it('a won/disputed plan restarted by its coach really clears the existing client entitlement guard', async () => {
    const h = harness();
    await h.created();
    // Main's dispute ledger writes `disputed`; C-680-19 intentionally keeps
    // that status after a won dispute while access is ended.
    h.fake.find('clientPurchase', { id: 'p1' })!.status = 'disputed';
    expect(await h.restart()).toEqual({ restarted: true, reason: 'restarted' });
    const guard = new ClientEntitlementGuard(
      h.db,
      { getAllAndOverride: () => false } as unknown as ConstructorParameters<typeof ClientEntitlementGuard>[1],
    );
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'client-1', role: 'student' } }) }),
    } as unknown as Parameters<typeof guard.canActivate>[0];
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
