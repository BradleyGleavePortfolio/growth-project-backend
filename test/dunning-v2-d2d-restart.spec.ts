import { Logger } from '@nestjs/common';
import {
  DunningV2Service,
  DUNNING_V2_REVERSAL_REASON,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// D2d (B-DUND2D-121): the remaining #705 fixes. R-DISPUTE-PAUSE: a dispute
// pauses billing and ends access; only the plan's coach restarts it. Stripe
// is modelled with its documented idempotency semantics: a key seen before
// replays the first response and applies nothing. Synthetic ids only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-05T17:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);
// Far ahead of any CI run, so the real guard's `access_expires_at > now` holds.
const PERIOD_END = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000);

function idempotentStripe() {
  const cache = new Map<string, unknown>();
  const st = { paused: false, real: [] as string[], keys: [] as string[] };
  const once = <T>(op: string, key: string, apply: () => T): T => {
    st.keys.push(key);
    if (cache.has(key)) return cache.get(key) as T;
    st.real.push(op);
    const v = apply();
    cache.set(key, v);
    return v;
  };
  return {
    st,
    pauseSubscriptionCollection: jest.fn(async (a: { idempotencyKey: string }) =>
      once('pause', a.idempotencyKey, () => {
        st.paused = true;
        return { status: 'active', current_period_end: PERIOD_END };
      }),
    ),
    resumeSubscriptionCollection: jest.fn(async (a: { idempotencyKey: string }) =>
      once('resume', a.idempotencyKey, () => {
        st.paused = false;
        return { status: 'active', current_period_end: PERIOD_END };
      }),
    ),
    listOpenInvoices: jest.fn(async () => []),
    markInvoiceUncollectible: jest.fn(async () => ({})),
    retrieveSubscription: jest.fn(async () => ({ status: 'active' })),
  };
}

function harness() {
  const fake = new FakePrisma();
  fake.seed('user', { id: 'coach-1', name: 'Morgan Coach', email: 'coach@tgp.invalid' });
  fake.seed('user', { id: 'client-1', name: 'Avery Client', email: 'client@tgp.invalid' });
  fake.seed('clientPurchase', {
    id: 'p1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'active',
    entitlement_active: true,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: 'sub_1',
    access_expires_at: null,
  });
  fake.seed('connectTransfer', { id: 'tr1', source_stripe_charge_id: 'ch_1', purchase_id: 'p1' });
  const stripe = idempotentStripe();
  const dispatcher = {
    dispatchStep: jest.fn(async () => ({})),
    dispatchStepDetailed: jest.fn(
      async (_ctx: unknown, _u: unknown, o: { channels: string[] }) => ({
        decision: {},
        results: Object.fromEntries(o.channels.map((c) => [c, { status: 'sent' }])),
      }),
    ),
  };
  const telemetry = {
    lockoutEntered: jest.fn(),
    lockoutExited: jest.fn(),
    recovered: jest.fn(),
    reversalDetected: jest.fn(),
  };
  const db = fake.client();
  const svc = new DunningV2Service(db, stub(telemetry), stub(dispatcher), stub(stripe));
  const purchase = () => fake.find('clientPurchase', { id: 'p1' })!;
  const ds = () => fake.find('dunningState', { purchase_id: 'p1' });
  const created = (disputeId = 'dp_1', now = T0) =>
    svc.detectAndHandleLateReversal({ chargeId: 'ch_1', disputeId, reversedChargeAt: now, now });
  const restart = (now = at(0.1)) =>
    svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1', now });
  const dbPaused = () =>
    ds()?.status === 'active' &&
    ds()?.last_failure_reason === DUNNING_V2_REVERSAL_REASON &&
    purchase().entitlement_active === false;
  return { fake, db, svc, stripe, dispatcher, purchase, ds, created, restart, dbPaused };
}

describe('D2d: dispute pause effects and the coach restart (#705 fixes)', () => {
  const prior = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (prior === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prior;
  });

  describe('Opus B-705-1 / Sol B-705-2: every exit that keeps the plan paused leaves Stripe paused', () => {
    it('a new dispute while the restart resumes: plan paused, Stripe paused by a real request', async () => {
      const h = harness();
      await h.created();
      const real = h.stripe.resumeSubscriptionCollection.getMockImplementation()!;
      h.stripe.resumeSubscriptionCollection.mockImplementationOnce(async (a) => {
        const out = await real(a);
        await h.created('dp_2', at(0.05));
        return out;
      });
      expect(await h.restart()).toEqual({ restarted: false, reason: 'new_dispute' });
      expect(h.dbPaused()).toBe(true);
      expect(h.stripe.st.real).toEqual(['pause', 'resume', 'pause']);
      expect(h.stripe.st.paused).toBe(true);
      expect(h.ds()?.billing_paused_at).toBeInstanceOf(Date);
    });

    it('the restart transaction fails after Stripe resumed: Stripe is paused again', async () => {
      const h = harness();
      await h.created();
      const run = h.db.$transaction;
      let n = 0;
      h.db.$transaction = async (fn: unknown) => {
        n += 1;
        // 1: clear the confirmation, 2: the restart commit (fails), 3: re-pause stamp.
        if (n === 2) throw Object.assign(new Error('synthetic tx failure'), { code: 'P2034' });
        return run(fn);
      };
      await expect(h.restart()).rejects.toThrow('synthetic tx failure');
      expect(h.dbPaused()).toBe(true);
      expect(h.stripe.st.real).toEqual(['pause', 'resume', 'pause']);
      expect(h.stripe.st.paused).toBe(true);
      expect(h.ds()?.billing_paused_at).toBeInstanceOf(Date);
    });

    it('a failed Stripe resume re-pauses under its own key; the plan stays paused', async () => {
      const h = harness();
      await h.created();
      h.stripe.resumeSubscriptionCollection.mockRejectedValueOnce(new Error('stripe down'));
      expect(await h.restart()).toEqual({ restarted: false, reason: 'billing_resume_failed' });
      expect(h.dbPaused()).toBe(true);
      expect(h.stripe.st.paused).toBe(true);
      const pauseKeys = h.stripe.pauseSubscriptionCollection.mock.calls.map(
        (c) => stub(c[0]).idempotencyKey,
      );
      expect(new Set(pauseKeys).size).toBe(pauseKeys.length);
    });

    it('a double tap: the second restart is billing_busy and never touches Stripe', async () => {
      const h = harness();
      await h.created();
      const real = h.stripe.resumeSubscriptionCollection.getMockImplementation()!;
      let second: Promise<{ restarted: boolean; reason: string }> | null = null;
      h.stripe.resumeSubscriptionCollection.mockImplementationOnce(async (a) => {
        second = h.restart(at(3));
        await second;
        return real(a);
      });
      expect(await h.restart(at(3))).toEqual({ restarted: true, reason: 'restarted' });
      expect(await second).toEqual({ restarted: false, reason: 'billing_busy' });
      expect(await h.restart(at(3))).toEqual({ restarted: false, reason: 'not_paused' });
      expect(h.stripe.resumeSubscriptionCollection).toHaveBeenCalledTimes(1);
      expect(h.stripe.st.paused).toBe(false);
      expect(h.purchase().entitlement_active).toBe(true);
    });

    it('a new pause at the same instant after a restart is a real Stripe pause', async () => {
      const h = harness();
      await h.created();
      expect((await h.restart(T0)).restarted).toBe(true);
      expect(h.stripe.st.paused).toBe(false);
      expect((await h.created('dp_2', T0)).opened).toBe(true);
      expect(h.stripe.st.real).toEqual(['pause', 'resume', 'pause']);
      expect(h.stripe.st.paused).toBe(true);
    });
  });

  describe('Sol B-705-3: pause and restart are serialized on the billing lease', () => {
    it('a restart while a pause is at Stripe returns billing_busy; a later restart wins cleanly', async () => {
      const h = harness();
      let release!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>((r) => (release = r));
      const started = new Promise<void>((r) => (entered = r));
      const pause = h.stripe.pauseSubscriptionCollection.getMockImplementation()!;
      h.stripe.pauseSubscriptionCollection.mockImplementationOnce(async (a) => {
        entered();
        await pending;
        return pause(a);
      });
      const opening = h.created();
      await started;
      expect(await h.restart()).toEqual({ restarted: false, reason: 'billing_busy' });
      expect(h.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
      release();
      await opening;
      expect(h.stripe.st.paused).toBe(true);
      expect(await h.restart()).toEqual({ restarted: true, reason: 'restarted' });
      expect(h.stripe.st.paused).toBe(false);
      expect(h.purchase().entitlement_active).toBe(true);
    });

    it('a pause that reaches the lease after a completed restart never pauses Stripe', async () => {
      const h = harness();
      await h.created();
      // The restart won the lease first and finished; the late pause re-reads.
      expect((await h.restart()).restarted).toBe(true);
      const late = await stub(h.svc).confirmDisputePause('p1', at(0.2));
      expect(late.result).toBe('not_paused');
      expect(h.stripe.st.paused).toBe(false);
      expect(h.purchase().entitlement_active).toBe(true);
    });

    it('a card payment or cancel holding the lease: the pause throws and the sweep re-asserts it', async () => {
      const h = harness();
      h.fake.seed('clientBillingLease', {
        purchase_id: 'p1',
        holder: 'paying:other',
        holder_until: new Date('2099-01-01T00:00:00.000Z'),
        fence: 4,
      });
      await expect(h.created()).rejects.toThrow('DUNNING_PAUSE_BILLING_BUSY');
      expect(h.dbPaused()).toBe(true);
      expect(h.stripe.st.paused).toBe(false);
      expect(h.dispatcher.dispatchStepDetailed).not.toHaveBeenCalled();
      const lease = h.fake.find('clientBillingLease', { purchase_id: 'p1' })!;
      lease.holder = null;
      lease.holder_until = null;
      await h.svc.runSweep(at(0.1));
      expect(h.stripe.st.paused).toBe(true);
      expect(h.ds()?.billing_paused_at).toBeInstanceOf(Date);
      expect(h.dispatcher.dispatchStepDetailed).toHaveBeenCalledTimes(1);
    });
  });

  describe('Sol B-705-4: billing_paused only once Stripe confirmed the pause', () => {
    it('a failed pause reads billing_paused false; the sweep re-asserts it, then true', async () => {
      const h = harness();
      h.stripe.pauseSubscriptionCollection.mockRejectedValueOnce(new Error('synthetic outage'));
      await expect(h.created()).rejects.toThrow('synthetic outage');
      expect(h.purchase().entitlement_active).toBe(false);
      expect((await h.svc.getClientStatus('client-1')).billing_paused).toBe(false);
      await h.svc.runSweep(at(0.1));
      expect(h.stripe.st.paused).toBe(true);
      const status = await h.svc.getClientStatus('client-1');
      expect(status).toMatchObject({ reason: 'dispute_paused', billing_paused: true });
      expect(h.dispatcher.dispatchStepDetailed).toHaveBeenCalledTimes(1);
      await h.svc.runSweep(at(0.2));
      expect(h.stripe.pauseSubscriptionCollection).toHaveBeenCalledTimes(2);
    });

    it('the sweep stays behind the flag', async () => {
      const h = harness();
      h.stripe.pauseSubscriptionCollection.mockRejectedValueOnce(new Error('synthetic outage'));
      await expect(h.created()).rejects.toThrow('synthetic outage');
      process.env.FEATURE_DUNNING_V2 = 'false';
      await h.svc.runSweep(at(0.1));
      expect(h.stripe.st.paused).toBe(false);
      expect(h.ds()?.billing_paused_at ?? null).toBeNull();
    });
  });

  describe('Sol B-705-5: a restarted plan passes the real entitlement guard', () => {
    it.each(['disputed', 'chargeback_lost'])(
      'status %s: the restart restores status and period from the resumed subscription',
      async (status) => {
        const h = harness();
        await h.created();
        h.purchase().status = status;
        h.purchase().access_expires_at = at(-40);
        expect(await h.restart()).toEqual({ restarted: true, reason: 'restarted' });
        expect(h.purchase()).toMatchObject({ status: 'active', entitlement_active: true });
        expect(h.purchase().access_expires_at).toEqual(
          new Date(PERIOD_END * 1000 + DUNNING_V2_DAY_MS),
        );
        const guard = new ClientEntitlementGuard(h.db, stub({ getAllAndOverride: () => false }));
        const context = stub({
          getHandler: () => ({}),
          getClass: () => ({}),
          switchToHttp: () => ({
            getRequest: () => ({ user: { id: 'client-1', role: 'student' } }),
          }),
        });
        await expect(guard.canActivate(context)).resolves.toBe(true);
      },
    );
  });

  describe('Opus B-705-2: no restart while the client holds another live plan for the package', () => {
    it('re-bought after the pause: the restart refuses before any Stripe call', async () => {
      const h = harness();
      await h.created();
      h.fake.seed('clientPurchase', {
        id: 'p2',
        client_user_id: 'client-1',
        coach_user_id: 'coach-1',
        package_id: 'pkg-1',
        status: 'active',
        entitlement_active: true,
        billing_type: 'recurring',
        amount_cents: 15000,
        currency: 'usd',
        stripe_subscription_id: 'sub_2',
      });
      expect(await h.restart(at(3))).toEqual({ restarted: false, reason: 'other_live_plan' });
      expect(h.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
      expect(h.dbPaused()).toBe(true);
      expect(h.stripe.st.paused).toBe(true);
    });

    it('a re-buy that becomes live while Stripe resumes: refused, Stripe paused again', async () => {
      const h = harness();
      await h.created();
      const real = h.stripe.resumeSubscriptionCollection.getMockImplementation()!;
      h.stripe.resumeSubscriptionCollection.mockImplementationOnce(async (a) => {
        const out = await real(a);
        h.fake.seed('clientPurchase', {
          id: 'p2',
          client_user_id: 'client-1',
          coach_user_id: 'coach-1',
          package_id: 'pkg-1',
          status: 'trialing',
          trial_started_at: at(0.05),
          entitlement_active: false,
          billing_type: 'recurring',
          amount_cents: 15000,
          currency: 'usd',
          stripe_subscription_id: 'sub_2',
        });
        return out;
      });
      expect(await h.restart()).toEqual({ restarted: false, reason: 'other_live_plan' });
      expect(h.dbPaused()).toBe(true);
      expect(h.stripe.st.paused).toBe(true);
    });

    it('control: a plan for another package does not block the restart', async () => {
      const h = harness();
      await h.created();
      h.fake.seed('clientPurchase', {
        id: 'p3',
        client_user_id: 'client-1',
        coach_user_id: 'coach-1',
        package_id: 'pkg-2',
        status: 'active',
        entitlement_active: true,
        billing_type: 'recurring',
        amount_cents: 9000,
        currency: 'usd',
        stripe_subscription_id: 'sub_3',
      });
      expect((await h.restart()).restarted).toBe(true);
    });
  });

  describe('Opus B-705-3 (operator ruling): a lost closure after a restart leaves access as the coach set it', () => {
    function refundHandler(h: ReturnType<typeof harness>) {
      const rd = new RefundDisputeHandlerService(
        h.db,
        stub({}),
        stub({}),
        stub({}),
        stub({}),
        stub({ createNotification: jest.fn(async () => ({})) }),
        undefined,
        undefined,
        stub({ purchaseIdForCharge: jest.fn(async () => 'p1') }),
        undefined,
      );
      // Stripe-backed reversals are out of scope here; that they run is asserted.
      const money = {
        ledger: jest.fn(async () => undefined),
        headCoach: jest.fn(async () => undefined),
      };
      stub(rd).applyLedgerReversal = money.ledger;
      stub(rd).applyHeadCoachReversal = money.headCoach;
      return { rd, money };
    }
    const disputeRow = (h: ReturnType<typeof harness>) =>
      h.fake.seed('chargeDispute', {
        id: 'cd1',
        purchase_id: 'p1',
        stripe_dispute_id: 'dp_1',
        stripe_charge_id: 'ch_1',
        amount_cents: 15000,
        currency: 'usd',
        status: 'needs_response',
        ledger_reversed: false,
        balance_transaction_id: null,
      });

    it('restart, then the same dispute closes lost: money reverses, access and billing agree', async () => {
      const h = harness();
      await h.created();
      expect((await h.restart(at(2))).restarted).toBe(true);
      disputeRow(h);
      const { rd, money } = refundHandler(h);
      await rd.handle({
        id: 'evt_lost',
        type: 'charge.dispute.closed',
        data: { object: { id: 'dp_1', charge: 'ch_1', status: 'lost' } },
      });
      expect(money.ledger).toHaveBeenCalledTimes(1);
      expect(h.fake.find('chargeDispute', { id: 'cd1' })?.ledger_reversed).toBe(true);
      expect(
        (
          await h.svc.onDisputeClosed({
            chargeId: 'ch_1',
            disputeId: 'dp_1',
            status: 'lost',
            closedAt: at(20),
          })
        ).reason,
      ).toBe('pause_kept');
      expect(h.purchase()).toMatchObject({ status: 'active', entitlement_active: true });
      expect(h.stripe.st.paused).toBe(false);
    });

    it('a redelivered opening of the restarted dispute does not mark the plan disputed', async () => {
      const h = harness();
      await h.created();
      expect((await h.restart(at(2))).restarted).toBe(true);
      const { rd } = refundHandler(h);
      await rd.handle({
        id: 'evt_created_again',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_1', charge: 'ch_1', status: 'needs_response', amount: 15000 } },
      });
      expect(h.purchase()).toMatchObject({ status: 'active', entitlement_active: true });
    });

    it('control: a lost dispute the coach never restarted still ends access', async () => {
      const h = harness();
      await h.created();
      disputeRow(h);
      const { rd } = refundHandler(h);
      await rd.handle({
        id: 'evt_lost',
        type: 'charge.dispute.closed',
        data: { object: { id: 'dp_1', charge: 'ch_1', status: 'lost' } },
      });
      expect(h.purchase()).toMatchObject({ status: 'chargeback_lost', entitlement_active: false });
    });

    it('control: a new dispute after the restart pauses again and its loss ends access', async () => {
      const h = harness();
      await h.created();
      expect((await h.restart(at(2))).restarted).toBe(true);
      expect((await h.created('dp_2', at(3))).reason).toBe('paused');
      h.fake.seed('chargeDispute', {
        id: 'cd2',
        purchase_id: 'p1',
        stripe_dispute_id: 'dp_2',
        stripe_charge_id: 'ch_1',
        amount_cents: 15000,
        currency: 'usd',
        status: 'needs_response',
        ledger_reversed: false,
        balance_transaction_id: null,
      });
      const { rd } = refundHandler(h);
      await rd.handle({
        id: 'evt_lost_2',
        type: 'charge.dispute.closed',
        data: { object: { id: 'dp_2', charge: 'ch_1', status: 'lost' } },
      });
      expect(h.purchase()).toMatchObject({ status: 'chargeback_lost', entitlement_active: false });
      expect(h.stripe.st.paused).toBe(true);
    });
  });

  describe('lock waiver (operator 13:2x, Opus L3 on m#353): the guard admits a waived lock', () => {
    const request = (path: string) =>
      stub({
        switchToHttp: () => ({
          getRequest: () => ({ method: 'GET', path, user: { id: 'client-1' } }),
        }),
      });
    const otherPlan = (h: ReturnType<typeof harness>) =>
      h.fake.seed('clientPurchase', {
        id: 'p3',
        client_user_id: 'client-1',
        coach_user_id: 'coach-1',
        package_id: 'pkg-2',
        status: 'active',
        entitlement_active: true,
        billing_type: 'recurring',
        amount_cents: 9000,
        currency: 'usd',
        stripe_subscription_id: 'sub_3',
      });

    it('a dispute-paused client with another live plan: status lock_waived and the guard admits', async () => {
      const h = harness();
      await h.created();
      otherPlan(h);
      expect((await h.svc.getClientStatus('client-1')).lock_waived).toBe(true);
      const guard = new DunningLockoutGuard(h.db);
      await expect(guard.canActivate(request('/api/workouts'))).resolves.toBe(true);
    });

    it('control: without other live access the paused client is refused', async () => {
      const h = harness();
      await h.created();
      const guard = new DunningLockoutGuard(h.db);
      await expect(guard.canActivate(request('/api/workouts'))).rejects.toMatchObject({
        status: 403,
      });
    });
  });
});
