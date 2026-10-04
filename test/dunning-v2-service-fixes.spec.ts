import { Logger } from '@nestjs/common';
import {
  DunningV2Service,
  dunningCycleKey,
  formatMoney,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// B-D12-116 fix round on #688 (D2); each case failed at 6627044c. Synthetic
// ids and sentinels only (several cases are the auditors' probes).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-04T02:30:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);
const SECRET = 'person@tgp.invalid token=SYNTHETIC_SECRET body=SYNTHETIC_BODY';

const telemetry = () => ({
  lockoutEntered: jest.fn(),
  lockoutExited: jest.fn(),
  recovered: jest.fn(),
  reversalDetected: jest.fn(),
  attemptFailed: jest.fn(),
  notifySent: jest.fn(),
  blockerShown: jest.fn(),
  coachNotified: jest.fn(),
});

function seed(fake: FakePrisma, id = 'p1', step = 3, over: Record<string, unknown> = {}) {
  fake.seed('clientPurchase', {
    id,
    client_user_id: 'client-a',
    coach_user_id: 'coach-a',
    status: 'past_due',
    entitlement_active: true,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: `sub-${id}`,
  });
  fake.seed('dunningState', {
    id: `ds-${id}`,
    purchase_id: id,
    status: 'active',
    step_index: step,
    entered_at: T0,
    locked_out_at: null,
    client_canceled_at: null,
    last_failure_reason: 'insufficient_funds',
    last_failed_amount_cents: 15000,
    ...over,
  });
}

const service = (fake: FakePrisma, stripe?: unknown, dispatcher?: unknown, t = telemetry()) =>
  new DunningV2Service(fake.client(), stub(t), stub(dispatcher), stub(stripe));
const pastDue = { retrieveSubscription: async () => ({ status: 'past_due' }) };

describe('dunning v2 service fix round (B-D12-116)', () => {
  const prior = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (prior === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prior;
  });

  describe('B-688-1 (Sol): the Day-10 lock is fenced to the cycle and the purchase it read', () => {
    it('control: an ordinary Day-10 cycle locks', async () => {
      const fake = new FakePrisma();
      seed(fake);
      expect((await service(fake, pastDue).runSweep(at(10))).locked).toBe(1);
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    });

    it('a cycle resolved and reopened during the Stripe check is not locked (ABA)', async () => {
      const fake = new FakePrisma();
      seed(fake);
      const now = at(11);
      const stripe = {
        retrieveSubscription: jest.fn(async () => {
          const db = fake.client();
          await db.dunningState.update({
            where: { id: 'ds-p1' },
            data: { status: 'resolved', resolved_at: now },
          });
          await db.dunningState.update({
            where: { id: 'ds-p1' },
            data: { status: 'active', entered_at: now, step_index: 0, resolved_at: null },
          });
          return { status: 'past_due' };
        }),
      };
      expect((await service(fake, stripe).runSweep(now)).locked).toBe(0);
      expect(fake.find('dunningState', { id: 'ds-p1' })?.locked_out_at).toBeNull();
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
    });

    it('a purchase paid during the Stripe check is not locked', async () => {
      const fake = new FakePrisma();
      seed(fake);
      const stripe = {
        retrieveSubscription: jest.fn(async () => {
          fake.find('clientPurchase', { id: 'p1' })!.status = 'active';
          return { status: 'past_due' };
        }),
      };
      expect((await service(fake, stripe).runSweep(at(11))).locked).toBe(0);
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
    });
  });

  describe('B-688-2 (Sol): the sweep reaches every due cycle', () => {
    it('cycles after the first 500 receive their due notices', async () => {
      const fake = new FakePrisma();
      for (let i = 0; i < 501; i++) seed(fake, `p${i}`, 0);
      const svc = service(fake);
      expect((await svc.runSweep(at(1))).advanced).toBe(500);
      expect((await svc.runSweep(at(1.1))).advanced).toBe(1);
      expect(fake.find('dunningState', { id: 'ds-p500' })?.step_index).toBe(1);
    });

    it('a full page of lock-due rows that keep skipping does not starve a due cycle', async () => {
      const fake = new FakePrisma();
      // Day 10 passed, but the purchase is not past_due: skipped every tick.
      for (const id of ['s1', 's2']) {
        seed(fake, id);
        fake.find('clientPurchase', { id })!.status = 'active';
      }
      seed(fake, 'due', 0, { entered_at: at(9) });
      const svc = service(fake, pastDue);
      await svc.runSweep(at(11), 2);
      await svc.runSweep(at(11.05), 2);
      expect(fake.find('dunningState', { id: 'ds-due' })?.step_index).toBe(1);
    });
  });

  describe('B-688-3 (Sol): a failed coach delivery gets a failed receipt', () => {
    it('real dispatcher + real CoachAlertEmitter + outbox', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const notifications = {
        createNotification: jest.fn(async () => {
          throw new Error('synthetic DB failure');
        }),
        pushToCoach: jest.fn(async () => false),
      };
      const t = telemetry();
      const dispatcher = new DunningV2Dispatcher(
        new DunningEscalationClassifier(),
        new DunningV2Renderer(),
        stub(t),
        stub(notifications),
        undefined,
        new CoachAlertEmitter(stub(notifications)),
      );
      const fake = new FakePrisma();
      seed(fake);
      fake.seed('user', { id: 'client-a', name: 'Synthetic Client' });
      fake.seed('user', { id: 'coach-a', name: 'Synthetic Coach' });
      const cycleKey = dunningCycleKey(T0);
      const id = `ds-p1:${cycleKey}:3:coach_alert`;
      fake.seed('dunningNoticeDelivery', {
        id,
        dunning_state_id: 'ds-p1',
        cycle_key: cycleKey,
        step_index: 3,
        channel: 'coach_alert',
        status: 'pending',
        attempts: 0,
        claim_token: null,
        key_attempt: null,
        next_attempt_at: at(1),
      });
      await service(fake, undefined, dispatcher, t).dispatchClaim(
        {
          dunningStateId: 'ds-p1',
          purchaseId: 'p1',
          cycleKey,
          stepIndex: 3,
          isLateReversalCycle: false,
        },
        T0,
      );
      expect(fake.find('dunningNoticeDelivery', { id })?.status).toBe('failed');
      expect(t.coachNotified).not.toHaveBeenCalled();
    });
  });

  describe('B-688-4 (Sol): logs carry codes, never provider or exception text', () => {
    it('a Stripe check failure and a dispatch failure', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fake = new FakePrisma();
      seed(fake);
      seed(fake, 'p2', 0, { entered_at: at(9) });
      const boom = async () => {
        throw new Error(SECRET);
      };
      const dispatcher = { dispatchStepDetailed: jest.fn(boom) };
      await service(fake, { retrieveSubscription: boom }, dispatcher).runSweep(at(11));
      expect(warn).toHaveBeenCalled();
      const seen = JSON.stringify(warn.mock.calls);
      expect(seen).not.toContain('SYNTHETIC_SECRET');
      expect(seen).not.toContain('person@tgp.invalid');
    });
  });

  describe('B-688-5 (Sol) / B-688-1 (Opus): a dispute closed lost keeps protecting the cycle', () => {
    async function lostDuringPaymentCycle(locked: boolean) {
      const fake = new FakePrisma();
      seed(fake, 'p1', 3, locked ? { locked_out_at: at(10) } : {});
      if (locked) fake.find('clientPurchase', { id: 'p1' })!.entitlement_active = false;
      const svc = service(fake);
      const opening = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: T0,
        disputeId: 'dp-lost',
        chargeId: 'ch-lost',
        now: at(1),
      });
      expect(opening.reason).toBe('cycle_already_active');
      fake.seed('connectTransfer', {
        id: 'tr1',
        source_stripe_charge_id: 'ch-lost',
        purchase_id: 'p1',
      });
      await svc.onDisputeClosed({
        chargeId: 'ch-lost',
        disputeId: 'dp-lost',
        status: 'lost',
        now: at(2),
      });
      return { fake, svc };
    }

    it('isDisputeCycleOpen stays true and the cycle becomes the dispute cycle', async () => {
      const { fake, svc } = await lostDuringPaymentCycle(false);
      expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
      expect(fake.find('dunningState', { id: 'ds-p1' })?.last_failure_reason).toBe(
        'charge_disputed',
      );
    });

    it('a renewal payment does not lift the Day-10 lock after the loss', async () => {
      const { fake, svc } = await lostDuringPaymentCycle(true);
      expect(await svc.applyImmediateClear('p1', 'retry')).toEqual({ liftedLockout: false });
      expect(fake.find('dunningState', { id: 'ds-p1' })?.locked_out_at).toEqual(at(10));
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    });

    it('control: a won dispute, or a loss closed before this cycle began, does not block', async () => {
      const fake = new FakePrisma();
      seed(fake);
      seed(fake, 'p2');
      fake.seed('dunningDisputeObligation', {
        stripe_dispute_id: 'dp-won',
        purchase_id: 'p1',
        stripe_charge_id: 'ch-won',
        status: 'won',
        closed_at: at(1),
      });
      fake.seed('dunningDisputeObligation', {
        stripe_dispute_id: 'dp-old',
        purchase_id: 'p2',
        stripe_charge_id: 'ch-old',
        status: 'lost',
        closed_at: at(-30),
      });
      const svc = service(fake);
      expect(await svc.isDisputeCycleOpen('p1')).toBe(false);
      expect(await svc.isDisputeCycleOpen('p2')).toBe(false);
    });
  });

  it('C-688-3 (Opus): a decline racing the dispute marker never replaces it', async () => {
    const fake = new FakePrisma();
    seed(fake, 'p1', 1, { last_failure_reason: 'card_declined', failure_count: 1 });
    const db = fake.client();
    const read = db.dunningState.findUnique;
    db.dunningState.findUnique = jest.fn(async (a: unknown) => {
      const row = await read(a);
      // The dispute path marks the cycle right after the v1 read.
      fake.find('dunningState', { id: 'ds-p1' })!.last_failure_reason = 'charge_disputed';
      return row;
    });
    const write = db.dunningState.update;
    db.dunningState.update = jest.fn(async (a: unknown) =>
      write(a).catch((e: Error) => {
        throw Object.assign(e, { code: 'P2025' }); // as Prisma reports a missed where
      }),
    );
    const purchase = stub(fake.find('clientPurchase', { id: 'p1' }));
    await new DunningService(db, stub({})).recordFailure({
      purchase,
      stripe_invoice_id: 'in_2',
      amount_due_cents: 15000,
      attempt_number: 2,
      reason: 'insufficient_funds',
    });
    expect(fake.find('dunningState', { id: 'ds-p1' })).toMatchObject({
      last_failure_reason: 'charge_disputed',
      failure_count: 2,
    });
  });

  it('C-688-5 (Opus): zero-decimal currencies are not divided by 100', () => {
    expect(formatMoney(1200, 'jpy')).toBe('1,200 JPY');
    expect(formatMoney(15000, 'usd')).toBe('$150.00');
  });
});
