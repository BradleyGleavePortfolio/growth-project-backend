import { Logger } from '@nestjs/common';
import { DunningV2Service, dunningCycleKey } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { DunningV2Dispatcher, DispatchContext } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// Synthetic IDs/diagnostics only; no live provider or user data.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-04T02:30:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);

function telemetry() {
  return {
    lockoutEntered: jest.fn(), lockoutExited: jest.fn(), recovered: jest.fn(),
    reversalDetected: jest.fn(), attemptFailed: jest.fn(), notifySent: jest.fn(),
    blockerShown: jest.fn(), coachNotified: jest.fn(),
  };
}

function seed(fake: FakePrisma, id = 'p1', step = 3) {
  fake.seed('clientPurchase', {
    id, client_user_id: 'client-a', coach_user_id: 'coach-a',
    status: 'past_due', entitlement_active: true, billing_type: 'recurring',
    amount_cents: 15000, currency: 'usd', stripe_subscription_id: `sub-${id}`,
  });
  fake.seed('dunningState', {
    id: `ds-${id}`, purchase_id: id, status: 'active', step_index: step,
    entered_at: T0, locked_out_at: null, client_canceled_at: null,
    last_failure_reason: 'insufficient_funds', last_failed_amount_cents: 15000,
  });
}

function context(): DispatchContext {
  return {
    dunningStateId: 'ds-p1', cycleKey: dunningCycleKey(T0), stepIndex: 3,
    isLateReversalCycle: false, clientUserId: 'client-a', coachUserId: 'coach-a',
    clientEmail: null, coachEmail: null,
    tokens: { firstName: 'Synthetic', clientName: 'Synthetic Client', coachName: 'Synthetic Coach',
      amount: '$150.00', lockoutDate: 'October 14' },
    dunningDetailDeeplink: 'tgp://coach/clients/client-a',
  };
}

describe('AUD-SOL-D12-116 D2 acceptance probes', () => {
  const priorFlag = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => { process.env.FEATURE_DUNNING_V2 = 'true'; });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(() => {
    if (priorFlag === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = priorFlag;
  });

  it('control: ordinary Day-10 lock succeeds', async () => {
    const fake = new FakePrisma();
    seed(fake);
    const svc = new DunningV2Service(fake.client(), stub(telemetry()), undefined,
      stub({ retrieveSubscription: async () => ({ status: 'past_due' }) }));
    expect((await svc.runSweep(at(10))).locked).toBe(1);
  });

  it('a stale sweep cannot lock a new Day-0 cycle after awaiting Stripe', async () => {
    const fake = new FakePrisma();
    seed(fake);
    const now = at(11);
    const stripe = {
      retrieveSubscription: jest.fn(async () => {
        // A resolved cycle reopened by a later failed renewal, with the same row ID.
        await fake.client().dunningState.update({
          where: { id: 'ds-p1' },
          data: { status: 'resolved', resolved_at: now, locked_out_at: null },
        });
        await fake.client().dunningState.update({
          where: { id: 'ds-p1' },
          data: { status: 'active', entered_at: now, step_index: 0, resolved_at: null },
        });
        return { status: 'past_due' };
      }),
    };
    const svc = new DunningV2Service(fake.client(), stub(telemetry()), undefined, stub(stripe));
    const out = await svc.runSweep(now);
    expect(fake.find('dunningState', { id: 'ds-p1' })?.entered_at).toEqual(now);
    expect(out.locked).toBe(0);
    expect(fake.find('dunningState', { id: 'ds-p1' })?.locked_out_at).toBeNull();
    expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
  });

  it('cycles after the first 500 must eventually receive their due notices', async () => {
    const fake = new FakePrisma();
    for (let i = 0; i < 501; i++) seed(fake, `p${i}`, 0);
    const svc = new DunningV2Service(fake.client(), stub(telemetry()));
    expect((await svc.runSweep(at(1))).advanced).toBe(500);
    await svc.runSweep(at(1.1));
    await svc.runSweep(at(3));
    expect(fake.find('dunningState', { id: 'ds-p500' })?.step_index).toBeGreaterThanOrEqual(1);
  });

  it('failed real CoachAlertEmitter delivery must not get a sent receipt', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const notifications = { createNotification: jest.fn(async () => { throw new Error('synthetic DB failure'); }),
      pushToCoach: jest.fn(async () => false) };
    const t = telemetry();
    const emitter = new CoachAlertEmitter(stub(notifications));
    const dispatcher = new DunningV2Dispatcher(new DunningEscalationClassifier(),
      new DunningV2Renderer(), stub(t), stub(notifications), undefined, emitter);
    const fake = new FakePrisma();
    seed(fake, 'p1', 3);
    fake.seed('user', { id: 'client-a', name: 'Synthetic Client' });
    fake.seed('user', { id: 'coach-a', name: 'Synthetic Coach' });
    const deliveryId = `ds-p1:${dunningCycleKey(T0)}:3:coach_alert`;
    fake.seed('dunningNoticeDelivery', {
      id: deliveryId, dunning_state_id: 'ds-p1', cycle_key: dunningCycleKey(T0),
      step_index: 3, channel: 'coach_alert', status: 'pending', attempts: 0,
      claim_token: null, key_attempt: null, next_attempt_at: at(1),
    });
    const svc = new DunningV2Service(fake.client(), stub(t), dispatcher);
    await svc.dispatchClaim({
      dunningStateId: 'ds-p1', purchaseId: 'p1', cycleKey: dunningCycleKey(T0),
      stepIndex: 3, isLateReversalCycle: false,
    }, T0);
    expect(notifications.createNotification).toHaveBeenCalled();
    expect(fake.find('dunningNoticeDelivery', { id: deliveryId })?.status).toBe('failed');
    expect(t.coachNotified).not.toHaveBeenCalled();
  });

  it('raw diagnostic text must not cross the new sweep log boundary', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const secret = 'synthetic-person@tgp.invalid token=SYNTHETIC_SECRET message=SYNTHETIC_BODY';
    const fake = new FakePrisma();
    seed(fake);
    const svc = new DunningV2Service(fake.client(), stub(telemetry()), undefined,
      stub({ retrieveSubscription: async () => { throw new Error(secret); } }));
    await svc.runSweep(at(11));
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it('a recorded lost dispute during a payment cycle still blocks payment-only recovery', async () => {
    const fake = new FakePrisma();
    seed(fake);
    const svc = new DunningV2Service(fake.client(), stub(telemetry()));
    const opening = await svc.handleLateReversal({
      purchaseId: 'p1', reversedChargeAt: T0, disputeId: 'dp-lost', chargeId: 'ch-lost', now: T0,
    });
    expect(opening.reason).toBe('cycle_already_active');
    fake.seed('connectTransfer', { id: 'tr1', source_stripe_charge_id: 'ch-lost', purchase_id: 'p1' });
    await svc.onDisputeClosed({
      chargeId: 'ch-lost', disputeId: 'dp-lost', status: 'lost', now: at(1),
    });
    expect(fake.find('dunningDisputeObligation', { stripe_dispute_id: 'dp-lost' })?.status).toBe('lost');
    expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
  });

  it('control: a won recorded dispute need not keep a payment cycle open', async () => {
    const fake = new FakePrisma();
    seed(fake);
    fake.seed('dunningDisputeObligation', {
      stripe_dispute_id: 'dp-won', purchase_id: 'p1', stripe_charge_id: 'ch-won', status: 'won',
    });
    const svc = new DunningV2Service(fake.client(), stub(telemetry()));
    expect(await svc.isDisputeCycleOpen('p1')).toBe(false);
  });

  it('control: successful coach delivery reports sent', async () => {
    const notifications = { createNotification: jest.fn(async () => ({ id: 'n1' })),
      pushToCoach: jest.fn(async () => true) };
    const dispatcher = new DunningV2Dispatcher(new DunningEscalationClassifier(),
      new DunningV2Renderer(), stub(telemetry()), stub(notifications), undefined,
      new CoachAlertEmitter(stub(notifications)));
    expect((await dispatcher.dispatchStepDetailed(context(), undefined, { channels: ['coach_alert'] }))
      .results.coach_alert?.status).toBe('sent');
  });
});
