// AUD-OPUS-D6-120 (Claude Opus 5.5 lens, agent 120) — probes on growth-project-backend#705 @ 5138947c.
// REPLAY by B-DUND2D-121 (agent 121) on D2d. Adaptations are marked `D2d REPLAY:`; everything else is verbatim.
// Audit-only spec: never merge. Synthetic ids only. Stripe is modelled with its documented idempotency
// semantics: a request with a key seen in the last 24 h replays the FIRST response and applies nothing;
// keys at least 24 h old are pruned (the repo's own fake says the same: test/support/fake-stripe-billing.ts:96).
import { Logger } from '@nestjs/common';
import {
  DunningV2Service,
  DUNNING_V2_REVERSAL_REASON,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-05T17:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);

function idemStripe() {
  const cache = new Map<string, unknown>();
  const st = { paused: false, real: [] as string[] };
  const once = <T>(op: string, key: string, apply: () => T): T => {
    if (cache.has(key)) return cache.get(key) as T; // replay: nothing applied
    st.real.push(op);
    const v = apply();
    cache.set(key, v);
    return v;
  };
  return {
    st,
    prune: () => cache.clear(),
    pauseSubscriptionCollection: jest.fn(async (a: { idempotencyKey: string }) =>
      once('pause', a.idempotencyKey, () => {
        st.paused = true;
        return { status: 'active' };
      }),
    ),
    resumeSubscriptionCollection: jest.fn(async (a: { idempotencyKey: string }) =>
      once('resume', a.idempotencyKey, () => {
        st.paused = false;
        return { status: 'active' };
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
  });
  fake.seed('connectTransfer', { id: 'tr1', source_stripe_charge_id: 'ch_1', purchase_id: 'p1' });
  const stripe = idemStripe();
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
  const purchase = (id = 'p1') => fake.find('clientPurchase', { id })!;
  const ds = () => fake.find('dunningState', { purchase_id: 'p1' });
  const created = (disputeId = 'dp_1', now = T0) =>
    svc.detectAndHandleLateReversal({ chargeId: 'ch_1', disputeId, reversedChargeAt: now, now });
  const dbPaused = () =>
    ds()?.status === 'active' &&
    ds()?.last_failure_reason === DUNNING_V2_REVERSAL_REASON &&
    purchase().entitlement_active === false;
  const restart = (now = at(0.1)) =>
    svc.restartAfterDisputePause({ coachUserId: 'coach-1', purchaseId: 'p1', now });
  return { fake, db, svc, stripe, purchase, ds, created, dbPaused, restart };
}

describe('AUD-OPUS-D6-120 #705 probes', () => {
  const prior = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (prior === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prior;
  });

  // ── B-705-1: a restart that does not complete leaves Stripe billing resumed on a paused plan ──
  describe('B-705-1 restart exits that keep the plan paused must leave billing paused at Stripe', () => {
    it('control: a completed restart resumes billing and grants access', async () => {
      const h = harness();
      await h.created();
      expect(h.stripe.st.paused).toBe(true);
      expect(await h.restart()).toEqual({ restarted: true, reason: 'restarted' });
      expect(h.stripe.st.paused).toBe(false);
      expect(h.purchase().entitlement_active).toBe(true);
    });

    it('new dispute during the restart (same day): plan stays paused, so Stripe must be paused', async () => {
      const h = harness();
      await h.created();
      const real = h.stripe.resumeSubscriptionCollection.getMockImplementation()!;
      h.stripe.resumeSubscriptionCollection.mockImplementationOnce(async (a: { idempotencyKey: string }) => {
        const out = await real(a); // Stripe applied the resume
        await h.created('dp_2', at(0.05)); // a second dispute webhook lands meanwhile
        return out;
      });
      expect(await h.restart()).toEqual({ restarted: false, reason: 'new_dispute' });
      expect(h.dbPaused()).toBe(true);
      // D2d REPLAY: the bug evidence line was ['pause', 'resume'] (re-pause replayed); the fix makes it a real request.
      expect(h.stripe.st.real).toEqual(['pause', 'resume', 'pause']);
      expect(h.stripe.st.paused).toBe(true); // FAILS at 5138947c: billing resumed, access ended
    });

    it('control: the same race 2 days after the pause (key pruned) ends paused', async () => {
      const h = harness();
      await h.created();
      h.stripe.prune();
      const real = h.stripe.resumeSubscriptionCollection.getMockImplementation()!;
      h.stripe.resumeSubscriptionCollection.mockImplementationOnce(async (a: { idempotencyKey: string }) => {
        const out = await real(a);
        await h.created('dp_2', at(2));
        return out;
      });
      expect((await h.restart(at(2))).reason).toBe('new_dispute');
      expect(h.stripe.st.paused).toBe(true);
    });

    it('two restarts race 3 days after the pause: the losing one must not pause the restarted plan', async () => {
      const h = harness();
      await h.created();
      h.stripe.prune(); // the pause was more than 24 h ago
      // D2d REPLAY: the double tap is serialized on the billing lease (operator ruling: billing_busy), so the
      // second tap never reaches Stripe; the original gate waited for two resume calls and would hang.
      const real = h.stripe.resumeSubscriptionCollection.getMockImplementation()!;
      let second: Promise<{ restarted: boolean; reason: string }> | null = null;
      h.stripe.resumeSubscriptionCollection.mockImplementation(async (a: { idempotencyKey: string }) => {
        if (!second) second = h.restart(at(3)); // the double tap lands while the first is at Stripe
        await second;
        return real(a);
      });
      const first = await h.restart(at(3));
      const outs = [first, await second!, await h.restart(at(3))];
      expect(outs.map((o) => o.reason).sort()).toEqual(['billing_busy', 'not_paused', 'restarted']);
      expect(h.purchase().entitlement_active).toBe(true);
      expect(h.stripe.st.paused).toBe(false); // FAILS at 5138947c: the loser re-paused billing (access free)
    });

    it('the restart transaction fails after Stripe resumed: plan stays paused, so Stripe must be paused', async () => {
      const h = harness();
      await h.created();
      const realTx = h.db.$transaction;
      h.db.$transaction = async (): Promise<never> => {
        throw Object.assign(new Error('synthetic tx failure'), { code: 'P2034' });
      };
      await expect(h.restart()).rejects.toThrow('synthetic tx failure');
      h.db.$transaction = realTx;
      expect(h.dbPaused()).toBe(true);
      expect(h.stripe.st.paused).toBe(true); // FAILS at 5138947c: resumed, never re-paused
    });
  });

  // ── B-705-2: restart resumes a paused subscription while the client already has a live plan for it ──
  describe('B-705-2 restart must not create a second billing subscription for the same plan', () => {
    it('the client bought the package again after the pause; the coach restarts the old plan', async () => {
      const h = harness();
      await h.created();
      // subscription-checkout.service.ts:507-525 treats the paused row (disputed or active, no access) as
      // not live, so a new subscription for pkg-1 can be started and paid.
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
      const out = await h.restart(at(3));
      const billing = h.fake
        .rows('clientPurchase')
        .filter((r) => r.package_id === 'pkg-1' && r.entitlement_active === true);
      expect(out.restarted).toBe(false); // FAILS at 5138947c: restarted
      expect(billing.map((r) => r.stripe_subscription_id)).toEqual(['sub_2']);
    });
  });

  // ── B-705-3: lost closure after a coach restart ends access while billing keeps running ──
  describe('B-705-3 composed: never bill a recurring plan without access after a restart', () => {
    it('restart, then the same dispute closes lost (main handler, then D2c closure)', async () => {
      const h = harness();
      await h.created();
      // main's dispute.created had mirrored status 'disputed' (refund-dispute-handler.service.ts:1093-1104)
      // D2d REPLAY: that mirror runs at dispute.created, before the restart (the restart now restores the
      // status from Stripe, and a later redelivery no longer mirrors a restarted dispute).
      h.purchase().status = 'disputed';
      expect((await h.restart(at(2))).restarted).toBe(true);
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
      const u = undefined;
      const rd = new RefundDisputeHandlerService(
        h.db,
        stub({}),
        stub({}),
        stub({}),
        stub({}),
        stub({}),
        u,
        u,
        u,
        u,
      );
      // money reversal paths are out of scope here (Stripe HTTP); access write is what is probed
      const rdAny = stub(rd);
      rdAny.applyLedgerReversal = jest.fn(async () => undefined);
      rdAny.applyHeadCoachReversal = jest.fn(async () => undefined);
      await rd.handle({
        id: 'evt_lost',
        type: 'charge.dispute.closed',
        data: { object: { id: 'dp_1', status: 'lost' } },
      });
      const d2c = await h.svc.onDisputeClosed({
        chargeId: 'ch_1',
        disputeId: 'dp_1',
        status: 'lost',
        closedAt: at(20),
      });
      expect(d2c.reason).toBe('pause_kept');
      // D2d REPLAY: operator ruling B-705-3 (a lost closure leaves a coach-restarted plan's access unchanged);
      // the observed-bug line was { status: 'chargeback_lost', entitlement_active: false }.
      expect(h.purchase()).toMatchObject({ status: 'active', entitlement_active: true });
      // invariant: a recurring plan without access is not being billed
      expect(h.purchase().entitlement_active || h.stripe.st.paused).toBe(true); // FAILS at 5138947c
    });
  });

  // ── Operator ruling (B-DUNMR decision 2): the pause read must not depend on FEATURE_DUNNING_V2 ──
  describe('flag rollback after a pause (operator ruling 10:1x)', () => {
    it('closure-first pause (status not yet disputed), flag off, sub.updated(active): access stays ended', async () => {
      const h = harness();
      await h.svc.onDisputeClosed({ chargeId: 'ch_1', disputeId: 'dp_1', status: 'won', closedAt: T0 });
      expect(h.dbPaused()).toBe(true);
      h.fake.seed('coachPackage', { id: 'pkg-1', billing_type: 'recurring' });
      const u = undefined;
      const handler = new CheckoutWebhookHandlerService(h.db, stub(h.stripe), u, u, u, u, u, h.svc);
      process.env.FEATURE_DUNNING_V2 = 'false';
      await handler.handle(
        stub({
          id: 'evt_upd',
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_1',
              status: 'active',
              current_period_end: Math.floor(at(30).getTime() / 1000),
              cancel_at_period_end: false,
              pause_collection: { behavior: 'void', resumes_at: null },
            },
          },
        }),
      );
      expect(h.purchase().entitlement_active).toBe(false); // FAILS at 5138947c (C-DUNMR-1)
    });
  });
});
