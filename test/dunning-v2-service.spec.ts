import {
  DunningV2Service,
  addDays,
  formatLockoutDate,
  formatMoney,
  DUNNING_V2_REVERSAL_REASON,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import {
  DUNNING_V2_DAY_MS,
  DUNNING_V2_REVERSAL_ENTRY_STEP,
  dunningV2LockoutAt,
  dunningV2StepForElapsed,
} from '../src/checkout/dunning-v2/dunning-v2.cadence';
import * as copy from '../src/checkout/dunning-v2/dunning-v2.copy';
import { NotificationKind } from '../src/notifications/notification-kind';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// S-DUNNING rewrite of the DunningV2Service unit spec. The service now drives
// the whole v2 cycle (claim Day 0, time-driven Day 1/3/7 steps, Day-10 lock,
// immediate clear), so the spec runs against the shared in-memory FakePrisma.
// The end-to-end lifecycle (webhook -> v1 -> v2 -> guards) lives in
// test/dunning-v2-e2e-lifecycle.spec.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-05T16:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);

function makeTelemetry() {
  return {
    lockoutEntered: jest.fn(),
    lockoutExited: jest.fn(),
    recovered: jest.fn(),
    reversalDetected: jest.fn(),
  };
}

function setup(opts: { stripeStatus?: string; stripeThrows?: boolean } = {}) {
  const fake = new FakePrisma();
  const telemetry = makeTelemetry();
  const dispatcher = { dispatchStep: jest.fn(async () => ({})) };
  const stripe = {
    retrieveSubscription: jest.fn(async () => {
      if (opts.stripeThrows) throw new Error('stripe unreachable');
      return { status: opts.stripeStatus ?? 'past_due' };
    }),
  };
  const svc = new DunningV2Service(fake.client(), stub(telemetry), stub(dispatcher), stub(stripe));
  fake.seed('user', { id: 'coach-1', name: 'Morgan Coach', email: 'coach@tgp.invalid' });
  fake.seed('user', { id: 'client-1', name: 'Avery Client', email: 'client@tgp.invalid' });
  fake.seed('clientPurchase', {
    id: 'p1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'past_due',
    entitlement_active: true,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: 'sub_1',
  });
  return { fake, svc, telemetry, dispatcher, stripe };
}

function seedState(fake: FakePrisma, over: Record<string, unknown> = {}) {
  return fake.seed('dunningState', {
    id: 'ds1',
    purchase_id: 'p1',
    status: 'active',
    step_index: -1,
    entered_at: T0,
    locked_out_at: null,
    recovered_at: null,
    resolved_at: null,
    reversal_count: 0,
    last_failure_reason: null,
    last_failed_amount_cents: 15000,
    ...over,
  });
}

describe('DunningV2Service', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
  });

  describe('pure helpers', () => {
    it('deriveState maps the v1 columns onto the v2 vocabulary', () => {
      expect(DunningV2Service.deriveState(null)).toBe('INACTIVE');
      expect(
        DunningV2Service.deriveState({ status: 'active', locked_out_at: null, recovered_at: null }),
      ).toBe('ACTIVE');
      expect(
        DunningV2Service.deriveState({ status: 'active', locked_out_at: T0, recovered_at: null }),
      ).toBe('LOCKED');
      expect(
        DunningV2Service.deriveState({ status: 'resolved', locked_out_at: null, recovered_at: T0 }),
      ).toBe('RECOVERED');
      expect(
        DunningV2Service.deriveState({
          status: 'abandoned',
          locked_out_at: null,
          recovered_at: null,
        }),
      ).toBe('INACTIVE');
    });

    it('stepForElapsed follows Days 0/1/3/7 and the lock lands on Day 10', () => {
      expect(dunningV2StepForElapsed(0)).toBe(0);
      expect(dunningV2StepForElapsed(DUNNING_V2_DAY_MS - 1)).toBe(0);
      expect(dunningV2StepForElapsed(DUNNING_V2_DAY_MS)).toBe(1);
      expect(dunningV2StepForElapsed(3 * DUNNING_V2_DAY_MS - 1)).toBe(1);
      expect(dunningV2StepForElapsed(3 * DUNNING_V2_DAY_MS)).toBe(2);
      expect(dunningV2StepForElapsed(7 * DUNNING_V2_DAY_MS)).toBe(3);
      expect(dunningV2StepForElapsed(30 * DUNNING_V2_DAY_MS)).toBe(3);
      expect(dunningV2LockoutAt(T0).toISOString()).toBe('2026-10-15T16:00:00.000Z');
    });

    it('eligibility: only paid recurring Stripe subscriptions (comp / invite-code / one-time never)', () => {
      const ok = {
        amount_cents: 15000,
        billing_type: 'recurring',
        stripe_subscription_id: 'sub_1',
      };
      expect(DunningV2Service.isEligiblePurchase(ok)).toBe(true);
      expect(DunningV2Service.isEligiblePurchase({ ...ok, amount_cents: 0 })).toBe(false);
      expect(DunningV2Service.isEligiblePurchase({ ...ok, stripe_subscription_id: null })).toBe(
        false,
      );
      expect(DunningV2Service.isEligiblePurchase({ ...ok, billing_type: 'one_time' })).toBe(false);
      expect(DunningV2Service.isEligiblePurchase(stub({ ...ok, source: 'invite_code' }))).toBe(
        false,
      );
    });

    it('formats money and the lockout date in the client time zone', () => {
      expect(formatMoney(15000, 'usd')).toBe('$150.00');
      expect(formatMoney(999, 'eur')).toBe('9.99 EUR');
      // 2026-10-15T03:00Z is still October 14 in Los Angeles.
      const d = new Date('2026-10-15T03:00:00.000Z');
      expect(formatLockoutDate(d, 'America/Los_Angeles')).toBe('Wednesday, October 14');
      expect(formatLockoutDate(d, 'Europe/London')).toBe('Thursday, October 15');
      expect(formatLockoutDate(d, 'Not/A_Zone')).toBe('Wednesday, October 14');
      expect(addDays(T0, -3).toISOString()).toBe('2026-10-02T16:00:00.000Z');
    });

    it('no shipped dunning copy contains an exclamation mark', () => {
      const strings: string[] = [];
      const walk = (v: unknown) => {
        if (typeof v === 'string') strings.push(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(copy);
      expect(strings.length).toBeGreaterThan(20);
      expect(strings.filter((s) => s.includes('!'))).toEqual([]);
    });
  });

  describe('flag OFF', () => {
    it('every entry point is a no-op that reads nothing', async () => {
      delete process.env['FEATURE_DUNNING_V2'];
      const { fake, svc, dispatcher } = setup();
      seedState(fake);
      expect(await svc.recordPaymentFailed('p1', T0)).toBeNull();
      expect(await svc.runSweep(at(20))).toEqual({ locked: 0, advanced: 0, skipped: 0 });
      expect(await svc.applyImmediateClear('p1')).toEqual({ liftedLockout: false });
      expect(
        (await svc.handleLateReversal({ purchaseId: 'p1', reversedChargeAt: T0 })).opened,
      ).toBe(false);
      expect((await svc.getClientStatus('client-1')).enabled).toBe(false);
      expect(dispatcher.dispatchStep).not.toHaveBeenCalled();
      expect(fake.writes).toHaveLength(0);
    });
  });

  describe('recordPaymentFailed + advance (step claims)', () => {
    it('claims Day 0 for a fresh v1 cycle and stamps entered_at', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: -1, entered_at: at(-40) }); // stale anchor from an earlier cycle
      const claim = await svc.recordPaymentFailed('p1', T0);
      expect(claim).toMatchObject({ stepIndex: 0, isLateReversalCycle: false });
      expect(fake.find('dunningState', { id: 'ds1' })).toMatchObject({
        step_index: 0,
        entered_at: T0,
      });
    });

    it('a duplicate webhook for the same step claims nothing (no double notice)', async () => {
      const { fake, svc } = setup();
      seedState(fake);
      expect(await svc.recordPaymentFailed('p1', T0)).not.toBeNull();
      expect(await svc.recordPaymentFailed('p1', new Date(T0.getTime() + 60_000))).toBeNull();
    });

    it('advances by elapsed time and jumps straight to the newest step (no burst)', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: 0 });
      const claim = await svc.recordPaymentFailed('p1', at(8));
      expect(claim?.stepIndex).toBe(3);
      expect(fake.find('dunningState', { id: 'ds1' })?.step_index).toBe(3);
      expect(await svc.recordPaymentFailed('p1', at(9))).toBeNull();
    });

    it('two racing claims for one step: exactly one wins', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: 0 });
      const row = fake.find('dunningState', { id: 'ds1' });
      const [a, b] = await Promise.all([
        svc.advance(stub(row), at(1)),
        svc.advance(stub(row), at(1)),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it('ineligible purchases (comp grant) are never claimed', async () => {
      const { fake, svc } = setup();
      fake.find('clientPurchase', { id: 'p1' })!.amount_cents = 0;
      seedState(fake);
      expect(await svc.recordPaymentFailed('p1', T0)).toBeNull();
      expect(fake.find('dunningState', { id: 'ds1' })?.step_index).toBe(-1);
    });

    it('a dispute cycle keeps the late-reversal copy on later steps', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: 2, last_failure_reason: DUNNING_V2_REVERSAL_REASON });
      expect(
        (await svc.advance(stub(fake.find('dunningState', { id: 'ds1' })), at(7)))
          ?.isLateReversalCycle,
      ).toBe(true);
    });
  });

  describe('runSweep (hourly: advance + Day-10 lock)', () => {
    it('sends the due step from the sweep when Stripe sent no webhook (hard decline)', async () => {
      const { fake, svc, dispatcher } = setup();
      seedState(fake, { step_index: 0 });
      const out = await svc.runSweep(at(3));
      expect(out.advanced).toBe(1);
      expect(dispatcher.dispatchStep).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatchStep.mock.calls[0]).toEqual([
        expect.objectContaining({
          stepIndex: 2,
          clientUserId: 'client-1',
          coachUserId: 'coach-1',
          clientEmail: 'client@tgp.invalid',
          tokens: expect.objectContaining({
            amount: '$150.00',
            firstName: 'Avery',
            coachName: 'Morgan Coach',
          }),
        }),
      ]);
    });

    it('does not lock before Day 10, locks at Day 10, and only once', async () => {
      const { fake, svc, telemetry } = setup();
      seedState(fake, { step_index: 3 });
      expect((await svc.runSweep(new Date(at(10).getTime() - 1))).locked).toBe(0);
      expect((await svc.runSweep(at(10))).locked).toBe(1);
      expect((await svc.runSweep(at(10.1))).locked).toBe(0);
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toEqual(at(10));
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
      expect(telemetry.lockoutEntered).toHaveBeenCalledTimes(1);
    });

    it('never sweeps an UNCLAIMED cycle (step -1) even with a stale entered_at (flip safety)', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: -1, entered_at: at(-60) });
      expect(await svc.runSweep(T0)).toEqual({ locked: 0, advanced: 0, skipped: 0 });
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toBeNull();
    });

    it.each([
      ['purchase no longer past_due', { purchaseStatus: 'active' }],
      ['Stripe reports the subscription paid', { stripeStatus: 'active' }],
      ['Stripe reports the subscription canceled', { stripeStatus: 'canceled' }],
      ['Stripe is unreachable', { stripeThrows: true }],
    ])('skips the lock when %s (positive evidence only)', async (_label, o) => {
      const opts = o as { purchaseStatus?: string; stripeStatus?: string; stripeThrows?: boolean };
      const { fake, svc } = setup(opts);
      if (opts.purchaseStatus)
        fake.find('clientPurchase', { id: 'p1' })!.status = opts.purchaseStatus;
      seedState(fake, { step_index: 3 });
      const out = await svc.runSweep(at(11));
      expect(out.locked).toBe(0);
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toBeNull();
    });
  });

  describe('applyImmediateClear', () => {
    it('lifts a lock, restores entitlement, dismisses only THIS client blockers, revokes tokens', async () => {
      const { fake, svc, telemetry } = setup();
      seedState(fake, { step_index: 3, locked_out_at: at(10) });
      fake.find('clientPurchase', { id: 'p1' })!.entitlement_active = false;
      fake.seed('notification', {
        id: 'mine',
        user_id: 'client-1',
        kind: NotificationKind.DUNNING_BLOCKER,
        read_at: null,
      });
      fake.seed('notification', {
        id: 'theirs',
        user_id: 'client-9',
        kind: NotificationKind.DUNNING_BLOCKER,
        read_at: null,
      });
      fake.seed('dunningAttempt', { id: 'a1', dunning_state_id: 'ds1' });
      fake.seed('paymentRecoveryToken', { id: 't1', dunning_attempt_id: 'a1', used_at: null });
      expect(await svc.applyImmediateClear('p1', 'card_update')).toEqual({ liftedLockout: true });
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toBeNull();
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
      expect(fake.find('notification', { id: 'mine' })?.read_at).toBeInstanceOf(Date);
      expect(fake.find('notification', { id: 'theirs' })?.read_at).toBeNull();
      expect(fake.find('paymentRecoveryToken', { id: 't1' })?.used_at).toBeInstanceOf(Date);
      expect(telemetry.lockoutExited).toHaveBeenCalledTimes(1);
    });

    it('does NOT turn entitlement on when the purchase was not locked', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: 1 });
      fake.find('clientPurchase', { id: 'p1' })!.entitlement_active = false;
      expect(await svc.applyImmediateClear('p1')).toEqual({ liftedLockout: false });
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    });

    it('joins the caller transaction when one is passed (no second transaction)', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: 3, locked_out_at: at(10) });
      await svc.applyImmediateClear('p1', 'retry', fake.client(true));
      expect(fake.transactionCalls).toBe(0);
      expect(fake.writes.filter((w) => w.model === 'clientPurchase').every((w) => w.viaTx)).toBe(
        true,
      );
    });

    it('is idempotent', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: 3, locked_out_at: at(10) });
      expect((await svc.applyImmediateClear('p1')).liftedLockout).toBe(true);
      expect((await svc.applyImmediateClear('p1')).liftedLockout).toBe(false);
    });
  });

  describe('handleLateReversal (dispute on a cleared payment)', () => {
    it('opens a compressed cycle: Step 2 now, coach in 4 days, lock in 7 days', async () => {
      const { fake, svc, dispatcher } = setup();
      seedState(fake, {
        status: 'resolved',
        step_index: 1,
        resolved_at: at(-5),
        recovered_at: at(-5),
      });
      const res = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: at(-1),
        now: T0,
      });
      expect(res.opened).toBe(true);
      const row = fake.find('dunningState', { id: 'ds1' });
      expect(row).toMatchObject({
        status: 'active',
        step_index: DUNNING_V2_REVERSAL_ENTRY_STEP,
        reversal_count: 1,
        last_failure_reason: DUNNING_V2_REVERSAL_REASON,
      });
      expect(dunningV2LockoutAt(row?.entered_at as Date)).toEqual(at(7));
      expect(dunningV2StepForElapsed(at(4).getTime() - (row?.entered_at as Date).getTime())).toBe(
        3,
      );
      expect(dispatcher.dispatchStep).toHaveBeenCalledWith(
        expect.objectContaining({ stepIndex: 2, isLateReversalCycle: true }),
      );
    });

    it('refuses while a cycle is active, and for a charge disputed before it cleared', async () => {
      const a = setup();
      seedState(a.fake, { status: 'active', step_index: 1 });
      expect(
        (await a.svc.handleLateReversal({ purchaseId: 'p1', reversedChargeAt: T0 })).reason,
      ).toBe('cycle_already_active');
      const b = setup();
      seedState(b.fake, { status: 'resolved', resolved_at: T0 });
      expect(
        (await b.svc.handleLateReversal({ purchaseId: 'p1', reversedChargeAt: at(-2) })).reason,
      ).toBe('not_a_cleared_payment_reversal');
    });
  });

  describe('getClientStatus', () => {
    it('reports past_due with amount, dates and coach; locked once locked; scoped to the caller', async () => {
      const { fake, svc } = setup();
      seedState(fake, { step_index: 1 });
      fake.seed('connectCustomer', {
        id: 'cc',
        client_user_id: 'client-1',
        default_card_last4: '0341',
      });
      const s = await svc.getClientStatus('client-1');
      expect(s).toMatchObject({
        enabled: true,
        state: 'past_due',
        purchase_id: 'p1',
        amount_cents: 15000,
        failed_at: T0.toISOString(),
        lockout_at: at(10).toISOString(),
        coach_name: 'Morgan Coach',
        card_last4: '0341',
        update_payment_route: '/v1/checkout/payment-method/setup-intent',
        update_card_url: 'https://app.trygrowthproject.com/billing/update-card',
        cancel_route: '/v1/checkout/subscriptions/p1/cancel',
      });
      fake.find('dunningState', { id: 'ds1' })!.locked_out_at = at(10);
      expect((await svc.getClientStatus('client-1')).state).toBe('locked');
      expect((await svc.getClientStatus('someone-else')).state).toBe('none');
    });
  });
});
