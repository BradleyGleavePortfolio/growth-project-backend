import { Logger } from '@nestjs/common';
import {
  DunningV2Service,
  DUNNING_V2_REVERSAL_REASON,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { DunningService } from '../src/checkout/dunning.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// R-DISPUTE-PAUSE (owner 12:01 PDT 10-04, B-DUNSPLIT-119): a dispute on any
// charge of a recurring plan pauses all billing for that plan and ends access
// at once; nothing restores it when the dispute closes; only the plan's coach
// restarts it. One-time purchases are unchanged. Synthetic ids only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-04T19:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);
const PAUSE_CHANNELS = [
  'client_push',
  'client_email',
  'client_blocker',
  'coach_alert',
  'coach_push',
  'coach_email',
];

function harness(over: Record<string, unknown> = {}, state?: Record<string, unknown>) {
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
    ...over,
  });
  fake.seed('connectTransfer', { id: 'tr1', source_stripe_charge_id: 'ch_1', purchase_id: 'p1' });
  if (state) {
    fake.seed('dunningState', {
      id: 'ds1',
      purchase_id: 'p1',
      status: 'active',
      step_index: 2,
      entered_at: at(-3),
      locked_out_at: null,
      client_canceled_at: null,
      reversal_count: 0,
      last_failure_reason: 'insufficient_funds',
      ...state,
    });
  }
  const stripe = {
    pauseSubscriptionCollection: jest.fn(async (_a: unknown) => ({ status: 'active' })),
    resumeSubscriptionCollection: jest.fn(async (_a: unknown) => ({ status: 'active' })),
    listOpenInvoices: jest.fn(async (_s: string) => [{ id: 'in_open' }]),
    markInvoiceUncollectible: jest.fn(async (_a: unknown) => ({})),
    retrieveSubscription: jest.fn(async () => ({ status: 'active' })),
  };
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
  const closed = (status: string, disputeId = 'dp_1', closedAt = at(30)) =>
    svc.onDisputeClosed({ chargeId: 'ch_1', disputeId, status, closedAt });
  const paused = () =>
    ds()?.status === 'active' &&
    ds()?.last_failure_reason === DUNNING_V2_REVERSAL_REASON &&
    ds()?.locked_out_at != null &&
    purchase().entitlement_active === false;
  return { fake, db, svc, stripe, dispatcher, telemetry, purchase, ds, created, closed, paused };
}

describe('R-DISPUTE-PAUSE: a dispute pauses billing and ends access at once', () => {
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

  describe('entry: any charge of a recurring plan, whatever its dunning history', () => {
    it('a plan that never failed a renewal: locked now, entitlement off, Stripe paused', async () => {
      const h = harness();
      expect(await h.created()).toEqual({ opened: true, reason: 'paused' });
      expect(h.paused()).toBe(true);
      expect(h.ds()).toMatchObject({ locked_out_at: T0, entered_at: T0, step_index: 3 });
      expect(h.stripe.pauseSubscriptionCollection).toHaveBeenCalledWith({
        subscriptionId: 'sub_1',
        idempotencyKey: expect.stringContaining('dispute_pause:p1:'),
      });
      expect(h.stripe.markInvoiceUncollectible).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: 'in_open' }),
      );
      const status = await h.svc.getClientStatus('client-1');
      // Mobile contract: a locked dispute state with no lock date and no retry/card path.
      expect(status).toMatchObject({
        state: 'locked',
        kind: 'dispute',
        reason: 'dispute_paused',
        access_ended: true,
        billing_paused: true,
        restart_by: 'coach',
        locked_at: T0.toISOString(),
        lockout_at: null,
        amount_cents: null,
        update_payment_route: null,
        update_card_url: null,
        cancel_route: null,
      });
    });

    it('during a Day-3 payment cycle: paused at once, no lock date days away', async () => {
      const h = harness({ status: 'past_due' }, {});
      expect((await h.created()).reason).toBe('paused');
      expect(h.paused()).toBe(true);
      expect(h.ds()?.locked_out_at).toEqual(T0);
    });

    it('after a resolved cycle: paused', async () => {
      const h = harness({}, { status: 'resolved', resolved_at: at(-1), step_index: 3 });
      expect((await h.created()).reason).toBe('paused');
      expect(h.paused()).toBe(true);
    });

    it('client and coach are told once, after the Stripe pause, on every channel', async () => {
      const h = harness();
      const order: string[] = [];
      h.stripe.pauseSubscriptionCollection.mockImplementation(async () => {
        order.push('stripe');
        return { status: 'active' };
      });
      h.dispatcher.dispatchStepDetailed.mockImplementation(async (ctx, _u, o) => {
        order.push('notice');
        expect(ctx).toMatchObject({ stepIndex: 3, isLateReversalCycle: true });
        return {
          decision: {},
          results: Object.fromEntries(o.channels.map((c) => [c, { status: 'sent' }])),
        };
      });
      await h.created();
      expect(order).toEqual(['stripe', 'notice']);
      const rows = h.fake.rows('dunningNoticeDelivery');
      expect(rows.map((r) => r.channel).sort()).toEqual([...PAUSE_CHANNELS].sort());
      expect(rows.every((r) => r.status === 'sent')).toBe(true);
    });

    it('a refund (no dispute id) is never non-payment: nothing pauses', async () => {
      const h = harness();
      const out = await h.svc.handleLateReversal({ purchaseId: 'p1', reversedChargeAt: T0 });
      expect(out.reason).toBe('no_dispute_id');
      expect(h.ds()).toBeUndefined();
      expect(h.stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
    });
  });

  describe('one-time purchases, grants, canceled plans and deleted accounts', () => {
    it.each([
      [
        'one-time purchase',
        { billing_type: 'one_time', stripe_subscription_id: null, status: 'paid' },
      ],
      ['code / free grant', { amount_cents: 0, stripe_subscription_id: null }],
    ])('%s: unchanged (no pause, no notice, no Stripe call)', async (_n, over) => {
      const h = harness(over);
      expect((await h.created()).reason).toBe('not_eligible');
      expect(h.ds()).toBeUndefined();
      expect(h.purchase().entitlement_active).toBe(true);
      expect(h.stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
      expect(h.dispatcher.dispatchStepDetailed).not.toHaveBeenCalled();
      expect(await h.svc.getClientStatus('client-1')).toMatchObject({
        state: 'none',
        reason: null,
      });
    });

    it('a canceled plan: nothing to pause at Stripe, nothing restarts', async () => {
      const h = harness({ status: 'canceled', entitlement_active: false });
      expect((await h.created()).reason).toBe('plan_ended');
      expect(h.stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
    });

    it('a deleted account (purchase and transfer gone): a clean no-op', async () => {
      const h = harness();
      h.fake.store.clientPurchase.length = 0;
      h.fake.store.connectTransfer.length = 0;
      const e404 = new StripeConnectApiError('x', 404, 'resource_missing', null);
      Object.assign(h.stripe, { retrieveCharge: async () => Promise.reject(e404) });
      expect((await h.created()).reason).toBe('purchase_unresolved');
      expect(
        await h.svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1' }),
      ).toEqual({ restarted: false, reason: 'not_found' });
    });
  });

  describe('webhook order and redelivery', () => {
    it('a redelivered dispute.created re-asserts the Stripe pause and sends nothing twice', async () => {
      const h = harness();
      await h.created();
      expect(await h.created()).toEqual({ opened: false, reason: 'already_paused' });
      expect(h.stripe.pauseSubscriptionCollection).toHaveBeenCalledTimes(2);
      const keys = h.stripe.pauseSubscriptionCollection.mock.calls.map(
        (c) => stub(c[0]).idempotencyKey,
      );
      expect(keys[0]).toBe(keys[1]);
      expect(h.dispatcher.dispatchStepDetailed).toHaveBeenCalledTimes(1);
      expect(h.ds()?.reversal_count).toBe(1);
    });

    it.each(['won', 'lost', 'warning_closed', 'charge_refunded'])(
      'closed %s after the pause: nothing restores access or billing',
      async (status) => {
        const h = harness();
        await h.created();
        expect((await h.closed(status)).resolved).toBe(false);
        expect(h.paused()).toBe(true);
        expect(h.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
        expect(
          h.fake.find('dunningDisputeObligation', { stripe_dispute_id: 'dp_1' }),
        ).toMatchObject({
          status,
          closed_at: at(30),
        });
      },
    );

    it('closed (won) delivered before created: the closure pauses; created changes nothing', async () => {
      const h = harness();
      expect(await h.closed('won', 'dp_1', at(1))).toEqual({
        resolved: false,
        reason: 'paused_on_closure',
      });
      expect(h.paused()).toBe(true);
      expect((await h.created('dp_1', T0)).reason).toBe('already_paused');
      expect(h.paused()).toBe(true);
      expect(h.dispatcher.dispatchStepDetailed).toHaveBeenCalledTimes(1);
    });

    it('an inquiry pauses like a dispute (owner 09:43 10-05); warning_closed restores nothing', async () => {
      const h = harness();
      expect((await h.created('dp_inq')).reason).toBe('paused');
      await h.closed('warning_closed', 'dp_inq');
      expect(h.paused()).toBe(true);
      expect(h.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
      const first = harness();
      expect((await first.closed('warning_closed', 'dp_inq', at(1))).reason).toBe(
        'paused_on_closure',
      );
      expect(first.paused()).toBe(true);
    });

    it('invoice events after the pause never lift it (paid, card update, failed, sweep)', async () => {
      const h = harness({ status: 'past_due' }, {});
      await h.created();
      const v1 = new DunningService(h.db, stub({}));
      await v1.recordResolution('p1');
      for (const via of ['retry', 'card_update', 'manual'] as const) {
        expect(await h.svc.applyImmediateClear('p1', via)).toEqual({ liftedLockout: false });
      }
      await v1.recordFailure({
        purchase: stub(h.purchase()),
        stripe_invoice_id: 'in_2',
        amount_due_cents: 15000,
        attempt_number: 2,
        reason: 'card_declined',
      });
      expect(await h.svc.recordPaymentFailed('p1', at(1))).toBeNull();
      await h.svc.runSweep(at(12));
      expect(h.paused()).toBe(true);
      expect(await h.svc.isDisputePaused('p1')).toBe(true);
      expect(h.dispatcher.dispatchStepDetailed).toHaveBeenCalledTimes(1);
    });

    it('invoice.paid processed before the dispute: the dispute still pauses', async () => {
      const h = harness({ status: 'past_due' }, {});
      await new DunningService(h.db, stub({})).recordResolution('p1');
      expect(h.ds()?.status).toBe('resolved');
      expect((await h.created()).reason).toBe('paused');
      expect(h.paused()).toBe(true);
    });

    it('a failed Stripe pause throws (redelivered); access has ended; no notice before the pause', async () => {
      const h = harness();
      h.stripe.pauseSubscriptionCollection.mockRejectedValueOnce(new Error('stripe down'));
      await expect(h.created()).rejects.toThrow('stripe down');
      expect(h.paused()).toBe(true);
      expect(h.fake.rows('dunningNoticeDelivery')).toHaveLength(0);
      expect(h.dispatcher.dispatchStepDetailed).not.toHaveBeenCalled();
      expect((await h.created()).reason).toBe('already_paused');
      expect(h.dispatcher.dispatchStepDetailed).toHaveBeenCalledTimes(1);
    });

    it('an incomplete open-invoice list fails closed (redelivered, no notice)', async () => {
      const h = harness();
      h.stripe.listOpenInvoices.mockRejectedValueOnce(
        new StripeConnectApiError('x', 502, 'invoice_list_incomplete', 'api_error'),
      );
      await expect(h.created()).rejects.toThrow();
      expect(h.dispatcher.dispatchStepDetailed).not.toHaveBeenCalled();
    });
  });

  describe('concurrency', () => {
    it('two workers on the same dispute: one pause, one notice set', async () => {
      const h = harness();
      // The purchase row lock (FOR UPDATE) serializes the two transactions;
      // the fake has no locks, so model it with a mutex.
      const run = h.db.$transaction;
      let chain: Promise<unknown> = Promise.resolve();
      h.db.$transaction = (fn: unknown) => {
        const next = chain.then(() => run(fn));
        chain = next.catch(() => undefined);
        return next;
      };
      const out = await Promise.all([h.created(), h.created()]);
      expect(out.map((o) => o.reason).sort()).toEqual(['already_paused', 'paused']);
      expect(h.fake.rows('dunningState')).toHaveLength(1);
      expect(h.fake.rows('dunningNoticeDelivery')).toHaveLength(PAUSE_CHANNELS.length);
    });

    it('a pause committed while a clear waits on the locks keeps the plan paused', async () => {
      const h = harness(
        { status: 'past_due', entitlement_active: false },
        { locked_out_at: at(-1) },
      );
      const tx = h.fake.client(true);
      tx.$queryRaw = async (sql: TemplateStringsArray) => {
        if (sql.join('?').includes('"DunningState"')) await h.created();
        return [];
      };
      expect(await h.svc.applyImmediateClear('p1', 'card_update', tx)).toEqual({
        liftedLockout: false,
      });
      expect(h.paused()).toBe(true);
    });

    it('lock order: DunningState, then ClientPurchase (the dunning order)', async () => {
      const h = harness();
      const locks: string[] = [];
      const run = h.db.$transaction;
      h.db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
        run(async (tx: Record<string, unknown>) => {
          tx.$queryRaw = async (sql: TemplateStringsArray) => {
            locks.push(/FROM "(\w+)"/.exec(sql.join('?'))?.[1] ?? '');
            return [];
          };
          return fn(tx);
        });
      await h.created();
      expect(locks.slice(0, 2)).toEqual(['DunningState', 'ClientPurchase']);
    });
  });

  describe('coach restart (the only way back)', () => {
    it('the plan coach restarts: billing resumes at Stripe, then access returns', async () => {
      const h = harness();
      await h.created();
      h.fake.seed('notification', {
        id: 'n1',
        user_id: 'client-1',
        kind: 'dunning_blocker',
        read_at: null,
      });
      const out = await h.svc.restartAfterDisputePause({
        coachUserId: 'coach-1',
        purchaseId: 'p1',
        now: at(2),
      });
      expect(out).toEqual({ restarted: true, reason: 'restarted' });
      expect(h.stripe.resumeSubscriptionCollection).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'sub_1' }),
      );
      expect(h.ds()).toMatchObject({ status: 'resolved', locked_out_at: null });
      expect(h.purchase().entitlement_active).toBe(true);
      expect(await h.svc.isDisputePaused('p1')).toBe(false);
      expect(await h.svc.applyImmediateClear('p1', 'retry')).toEqual({ liftedLockout: false });
    });

    it('another coach or the client: not_found, nothing changes (tenant check)', async () => {
      const h = harness();
      await h.created();
      for (const coachUserId of ['coach-2', 'client-1']) {
        expect(await h.svc.restartAfterDisputePause({ coachUserId, purchaseId: 'p1' })).toEqual({
          restarted: false,
          reason: 'not_found',
        });
      }
      expect(h.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
      expect(h.paused()).toBe(true);
    });

    it('not paused, or a canceled plan: refused before any Stripe call', async () => {
      const a = harness({}, {});
      expect(
        (await a.svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1' })).reason,
      ).toBe('not_paused');
      const b = harness();
      await b.created();
      b.purchase().status = 'canceled';
      expect(
        (await b.svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1' })).reason,
      ).toBe('plan_ended');
      expect(a.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
      expect(b.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
    });

    it('a failed Stripe resume keeps the plan paused with a coded reason', async () => {
      const h = harness();
      await h.created();
      h.stripe.resumeSubscriptionCollection.mockRejectedValueOnce(new Error('stripe down'));
      expect(
        await h.svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1' }),
      ).toEqual({ restarted: false, reason: 'billing_resume_failed' });
      expect(h.paused()).toBe(true);
    });

    it('a new dispute recorded during the restart keeps the plan paused and re-pauses Stripe', async () => {
      const h = harness();
      await h.created();
      h.stripe.resumeSubscriptionCollection.mockImplementationOnce(async () => {
        await h.created('dp_2', at(1));
        return { status: 'active' };
      });
      expect(
        await h.svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1' }),
      ).toEqual({ restarted: false, reason: 'new_dispute' });
      expect(h.paused()).toBe(true);
      const last = Math.max(...h.stripe.pauseSubscriptionCollection.mock.invocationCallOrder);
      const resumed = h.stripe.resumeSubscriptionCollection.mock.invocationCallOrder[0];
      expect(last).toBeGreaterThan(resumed);
    });

    it('after a restart: the old dispute redelivered changes nothing; a new dispute pauses again', async () => {
      const h = harness();
      await h.created();
      await h.svc.restartAfterDisputePause({
        coachUserId: 'coach-1',
        purchaseId: 'p1',
        now: at(2),
      });
      expect((await h.created('dp_1', at(3))).reason).toBe('dispute_already_applied');
      expect((await h.closed('lost', 'dp_1', at(4))).reason).toBe('pause_kept');
      expect(h.purchase().entitlement_active).toBe(true);
      expect((await h.created('dp_9', at(5))).reason).toBe('paused');
      expect(h.paused()).toBe(true);
      expect(h.ds()?.reversal_count).toBe(2);
    });
  });

  describe('the pause is never read back by a webhook as a reason to restore access', () => {
    const handlerFor = (h: ReturnType<typeof harness>) => {
      h.fake.seed('coachPackage', { id: 'pkg-1', billing_type: 'recurring' });
      const u = undefined;
      return new CheckoutWebhookHandlerService(h.db, stub(h.stripe), u, u, u, u, u, h.svc);
    };
    const updated = (status: string) => ({
      id: `evt_${status}`,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status,
          current_period_end: Math.floor(at(30).getTime() / 1000),
          cancel_at_period_end: false,
          pause_collection: { behavior: 'void', resumes_at: null },
        },
      },
    });
    it.each(['active', 'past_due'])(
      'customer.subscription.updated (%s, pause_collection set) keeps access ended',
      async (status) => {
        const h = harness();
        await h.created();
        await handlerFor(h).handle(stub(updated(status)));
        expect(h.purchase()).toMatchObject({ status, entitlement_active: false });
        expect(h.paused()).toBe(true);
      },
    );
    it('control: the same update re-entitles once the coach has restarted', async () => {
      const h = harness();
      await h.created();
      await h.svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1' });
      await handlerFor(h).handle(stub(updated('active')));
      expect(h.purchase().entitlement_active).toBe(true);
    });
  });
});
