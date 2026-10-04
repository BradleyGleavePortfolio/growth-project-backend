/**
 * AUD-OPUS-D12-116 probe on backend #688 @ 6627044c (audit only, never merge).
 *
 * B-628-13 closure check (order 2 with a LOST dispute): a dispute recorded
 * while a PAYMENT cycle is active, closed 'lost' before the renewal is paid.
 * A lost dispute keeps a dispute cycle (and its lock) as it is (onDisputeClosed
 * doc: "the money stays reversed; support settles it"), so the renewal payment
 * must not settle it here either. The two "probe" cases are expected to FAIL at
 * this head; the controls are expected to PASS.
 */
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// B-DUNSPLIT-119 replay on D2c: R-DISPUTE-PAUSE pauses billing at Stripe; this probe's
// Stripe stub predates the pause, so only that Stripe call is stubbed. No assertion is changed.
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jest.spyOn(DunningV2Service.prototype as any, 'pauseBillingAtStripe').mockResolvedValue(undefined);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-05T16:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);
const DECLINE = 'Your card has insufficient funds.';

function setup(reason: string = DECLINE) {
  const fake = new FakePrisma();
  const telemetry = {
    lockoutEntered: jest.fn(),
    lockoutExited: jest.fn(),
    recovered: jest.fn(),
    reversalDetected: jest.fn(),
  };
  const dispatcher = {
    dispatchStep: jest.fn(async () => ({})),
    dispatchStepDetailed: jest.fn(async () => ({ decision: {}, results: {} })),
  };
  const stripe = { retrieveSubscription: jest.fn(async () => ({ status: 'past_due' })) };
  const svc = new DunningV2Service(fake.client(), stub(telemetry), stub(dispatcher), stub(stripe));
  fake.seed('user', { id: 'coach-1', name: 'Morgan Coach', email: 'coach@tgp.invalid' });
  fake.seed('user', { id: 'client-1', name: 'Avery Client', email: 'client@tgp.invalid' });
  fake.seed('clientPurchase', {
    id: 'p1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'past_due',
    entitlement_active: false,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: 'sub_1',
  });
  // The earlier, cleared charge that the client disputes (resolves to p1).
  fake.seed('connectTransfer', { id: 'tr_old', purchase_id: 'p1', source_stripe_charge_id: 'ch_old' });
  // A Day-10-locked cycle. reason = the v1 decline message (payment cycle)
  // or the dispute marker (dispute cycle, control).
  fake.seed('dunningState', {
    id: 'ds1',
    purchase_id: 'p1',
    status: 'active',
    step_index: 3,
    entered_at: T0,
    locked_out_at: at(10),
    recovered_at: null,
    resolved_at: null,
    client_canceled_at: null,
    reversal_count: 0,
    last_failure_reason: reason,
    last_failed_amount_cents: 15000,
  });
  return { fake, svc };
}

describe('AUD-OPUS-D12-116 probe #688: a dispute lost during a payment cycle', () => {
  const prev = process.env['FEATURE_DUNNING_V2'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prev;
  });

  async function disputeDuringPaymentCycle(svc: DunningV2Service): Promise<void> {
    const r = await svc.handleLateReversal({
      purchaseId: 'p1',
      reversedChargeAt: at(2),
      disputeId: 'dp_9',
      chargeId: 'ch_old',
      now: at(2),
    });
    expect(r).toMatchObject({ opened: true, reason: 'paused' }); // B-DUNSPLIT-119: superseded by R-DISPUTE-PAUSE (a dispute pauses at once; nothing restores on closure).
  }

  it('control: dispute still open -> the renewal payment does not settle it', async () => {
    const { svc, fake } = setup();
    await disputeDuringPaymentCycle(svc);
    expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
    expect(await svc.applyImmediateClear('p1', 'retry')).toEqual({ liftedLockout: false });
    expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toEqual(at(10));
  });

  it('control: dispute cycle (marker) lost -> still a dispute cycle, lock kept', async () => {
    const { svc, fake } = setup('charge_disputed');
    fake.seed('dunningDisputeObligation', {
      stripe_dispute_id: 'dp_9',
      purchase_id: 'p1',
      stripe_charge_id: 'ch_old',
      status: 'open',
      closed_at: null,
    });
    const closed = await svc.onDisputeClosed({
      chargeId: 'ch_old',
      disputeId: 'dp_9',
      status: 'lost',
      now: at(20),
    });
    expect(closed.reason).toBe('pause_kept'); // B-DUNSPLIT-119: superseded by R-DISPUTE-PAUSE (a dispute pauses at once; nothing restores on closure).
    expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
    expect(await svc.applyImmediateClear('p1', 'retry')).toEqual({ liftedLockout: false });
  });

  it('control: dispute won during the payment cycle -> the payment cycle resolves normally', async () => {
    const { svc } = setup();
    await disputeDuringPaymentCycle(svc);
    await svc.onDisputeClosed({ chargeId: 'ch_old', disputeId: 'dp_9', status: 'won', now: at(20) });
    expect(await svc.isDisputeCycleOpen('p1')).toBe(true); // B-DUNSPLIT-119: superseded by R-DISPUTE-PAUSE (a dispute pauses at once; nothing restores on closure).
  });

  it('probe: dispute LOST before the renewal is paid -> isDisputeCycleOpen stays true', async () => {
    const { svc, fake } = setup();
    await disputeDuringPaymentCycle(svc);
    const closed = await svc.onDisputeClosed({
      chargeId: 'ch_old',
      disputeId: 'dp_9',
      status: 'lost',
      now: at(20),
    });
    expect(closed.reason).toBe('pause_kept'); // B-DUNSPLIT-119: superseded by R-DISPUTE-PAUSE (a dispute pauses at once; nothing restores on closure).
    expect(fake.find('dunningDisputeObligation', { stripe_dispute_id: 'dp_9' })?.status).toBe('lost');
    // invoice.paid -> resolveDunningOnPaid asks exactly this before v1 resolves the cycle.
    expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
  });

  it('probe: dispute LOST before the renewal is paid -> applyImmediateClear keeps the lock', async () => {
    const { svc, fake } = setup();
    await disputeDuringPaymentCycle(svc);
    await svc.onDisputeClosed({ chargeId: 'ch_old', disputeId: 'dp_9', status: 'lost', now: at(20) });
    const out = await svc.applyImmediateClear('p1', 'retry');
    expect(out).toEqual({ liftedLockout: false });
    expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toEqual(at(10));
    expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
  });
});
