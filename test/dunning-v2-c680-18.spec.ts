// C-680-18 (Opus R34D-119, hard obligation before FEATURE_DUNNING_V2=true):
// with the flag on, a paid invoice must never hand access back to a plan that
// ended or was revoked for money, nor lift its lock. Regression for the probe
// in ops/aud-119/AUD-OPUS-R34D-119 (lock variant: on D2 only a locked cycle
// writes access, dunning-v2.service.ts applyImmediateClear).
import {
  CheckoutWebhookHandlerService,
  purchaseHasEnded,
} from '../src/checkout/checkout-webhook-handler.service';
import {
  DunningV2Service,
  dunningPurchaseEnded,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const ENDED = ['refunded', 'chargeback_lost', 'disputed', 'canceled', 'expired'];
const LOCKED_AT = new Date(Date.now() - 2 * DUNNING_V2_DAY_MS);

const prevFlag = process.env.FEATURE_DUNNING_V2;
beforeEach(() => {
  process.env.FEATURE_DUNNING_V2 = 'true';
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.FEATURE_DUNNING_V2;
  else process.env.FEATURE_DUNNING_V2 = prevFlag;
});

function telemetry() {
  return { recovered: jest.fn(), lockoutExited: jest.fn(), lockoutEntered: jest.fn() };
}

describe('C-680-18 applyImmediateClear refuses a plan that ended or was revoked', () => {
  function setup(status: string, entitled = false) {
    const fake = new FakePrisma();
    const t = telemetry();
    const svc = new DunningV2Service(fake.client(), stub(t));
    fake.seed('clientPurchase', {
      id: 'p1',
      client_user_id: 'client-1',
      coach_user_id: 'coach-1',
      status,
      entitlement_active: entitled,
      billing_type: 'recurring',
      amount_cents: 15000,
      currency: 'usd',
      stripe_subscription_id: 'sub_1',
    });
    fake.seed('dunningState', {
      id: 'ds1',
      purchase_id: 'p1',
      status: 'resolved',
      step_index: 3,
      entered_at: new Date(LOCKED_AT.getTime() - 10 * DUNNING_V2_DAY_MS),
      locked_out_at: LOCKED_AT,
      last_failure_reason: 'card_declined',
    });
    fake.seed('notification', {
      id: 'n1',
      user_id: 'client-1',
      kind: 'DUNNING_BLOCKER',
      read_at: null,
    });
    return { fake, svc, t };
  }

  it.each(ENDED)('%s without access: no access, lock kept, nothing dismissed', async (status) => {
    for (const via of ['retry', 'card_update', 'manual'] as const) {
      const { fake, svc, t } = setup(status);
      expect(await svc.applyImmediateClear('p1', via)).toEqual({ liftedLockout: false });
      expect(fake.find('clientPurchase', { id: 'p1' })).toMatchObject({
        status,
        entitlement_active: false,
      });
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toEqual(LOCKED_AT);
      expect(fake.find('notification', { id: 'n1' })?.read_at).toBeNull();
      expect(t.recovered).not.toHaveBeenCalled();
    }
  });

  it('decides on the caller transaction under the row locks, DunningState first', async () => {
    const { fake, svc } = setup('refunded');
    const tx = fake.client(true);
    const locks: string[] = [];
    tx.$queryRaw = async (sql: TemplateStringsArray) => {
      locks.push(sql.join('?'));
      return [];
    };
    await svc.applyImmediateClear('p1', 'retry', tx);
    expect(fake.transactionCalls).toBe(0);
    expect(locks).toEqual([
      'SELECT "id" FROM "DunningState" WHERE "purchase_id" = ? FOR UPDATE',
      'SELECT "id" FROM "ClientPurchase" WHERE "id" = ? FOR NO KEY UPDATE',
    ]);
  });

  it('control: a Day-10 locked plan that is still owed (past_due) is unlocked and re-entitled', async () => {
    const { fake, svc, t } = setup('past_due');
    expect(await svc.applyImmediateClear('p1', 'card_update')).toEqual({ liftedLockout: true });
    expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
    expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toBeNull();
    expect(t.recovered).toHaveBeenCalledTimes(1);
  });

  it('control: an ended status that still has access is not treated as revoked', async () => {
    const { fake, svc } = setup('disputed', true);
    expect(await svc.applyImmediateClear('p1')).toEqual({ liftedLockout: true });
    expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toBeNull();
  });

  it('a missing purchase is refused', async () => {
    const { fake, svc } = setup('past_due');
    fake.rows('clientPurchase').splice(0, 1);
    expect(await svc.applyImmediateClear('p1')).toEqual({ liftedLockout: false });
    expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toEqual(LOCKED_AT);
  });
});

describe('C-680-18 parity with the webhook fence', () => {
  const STATUSES = [
    'pending',
    'incomplete',
    'payment_failed',
    'active',
    'trialing',
    'past_due',
    'unpaid',
    'paid',
    'canceled',
    'expired',
    'incomplete_expired',
    'refunded',
    'chargeback_lost',
    'disputed',
  ];
  it.each(STATUSES)('%s: same answer as purchaseHasEnded', (status) => {
    for (const entitlement_active of [true, false]) {
      expect(dunningPurchaseEnded({ status, entitlement_active })).toBe(
        purchaseHasEnded({ status, entitlement_active }),
      );
    }
  });
});

describe('C-680-18 through the webhook (invoice.paid, then customer.subscription.updated)', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const PERIOD = NOW + 30 * 86400;
  let seq = 0;
  const ev = (type: string, object: Record<string, unknown>) => {
    seq += 1;
    return { id: `evt_c68018_${seq}`, type, data: { object } };
  };
  const sub = (status: string) => ({
    id: 'sub_18',
    status,
    customer: 'cus_18',
    current_period_end: PERIOD,
    default_payment_method: 'pm_18',
    cancel_at_period_end: false,
  });
  const paid = () =>
    ev('invoice.paid', {
      id: 'in_18',
      subscription: 'sub_18',
      amount_paid: 14800,
      currency: 'usd',
      charge: 'ch_18',
      billing_reason: 'subscription_cycle',
    });

  function harness(status: string, entitled: boolean) {
    const db = makeFakePrisma();
    const states = [
      {
        id: 'ds_18',
        purchase_id: 'cp_18',
        status: 'resolved',
        locked_out_at: LOCKED_AT as Date | null,
        last_failure_reason: 'card_declined',
        entered_at: new Date(LOCKED_AT.getTime() - 10 * DUNNING_V2_DAY_MS),
      },
    ];
    db.dunningState = {
      findUnique: jest.fn(async ({ where }: { where: { purchase_id: string } }) => {
        const s = states.find((r) => r.purchase_id === where.purchase_id);
        return s ? { ...s, purchase: { client_user_id: 'client_18' } } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) =>
        Object.assign(states.find((r) => r.id === where.id) as object, data),
      ),
    };
    db.dunningAttempt = { findMany: jest.fn(async () => []) };
    db.notification = { updateMany: jest.fn(async () => ({ count: 0 })) };
    db.paymentRecoveryToken = { updateMany: jest.fn(async () => ({ count: 0 })) };
    db.dunningDisputeObligation = { findMany: jest.fn(async () => []) };
    db.chargeDispute = { findMany: jest.fn(async () => []) };
    db._packages.push({ id: 'pkg_18', billing_type: 'recurring', duration_periods: null });
    db._purchases.push({
      id: 'cp_18',
      package_id: 'pkg_18',
      client_user_id: 'client_18',
      coach_user_id: 'coach_18',
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'recurring',
      stripe_subscription_id: 'sub_18',
      stripe_checkout_session_id: 'sub_18',
      stripe_payment_intent_id: 'pi_18',
      stripe_customer_id: 'cus_18',
      status,
      entitlement_active: entitled,
      trial_days: null,
      trial_started_at: null,
      current_period_end: new Date(PERIOD * 1000),
      access_expires_at: new Date((PERIOD + 86400) * 1000),
      canceled_at: null,
      cancel_at_period_end: false,
      last_error: null,
      idempotency_key: 'sub-18',
      created_at: new Date(Date.now() - 60_000),
      updated_at: new Date(Date.now() - 60_000),
    });
    const live = sub('active');
    const stripe = stub({
      retrieveSubscription: jest.fn(async () => ({ ...live })),
      retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
      retrieveInvoice: jest.fn(async () => ({ id: 'in_18', status: 'paid' })),
    });
    const splits = stub({ onChargeSucceeded: jest.fn(async () => undefined) });
    const fanout = stub({
      onPurchaseEntitled: jest.fn(async () => undefined),
      cancelPendingForPurchase: jest.fn(async () => 0),
    });
    const dunning = stub({
      recordFailure: jest.fn(async () => ({})),
      recordResolution: jest.fn(async () => null),
      terminate: jest.fn(async () => null),
    });
    const dunningV2 = new DunningV2Service(db, stub(telemetry()));
    const svc = new CheckoutWebhookHandlerService(
      db,
      stripe,
      splits,
      dunning,
      undefined,
      fanout,
      undefined,
      dunningV2,
      undefined,
    );
    const deliver = async (e: ReturnType<typeof ev>) =>
      svc.handle(e, db, await svc.prefetchForOuterTx(e));
    return { db, deliver, states, dunning, dunningV2, row: () => db._purchases[0] };
  }

  it.each(ENDED.filter((s) => s !== 'canceled' && s !== 'expired'))(
    '%s without access and a Day-10 lock: invoice.paid and sub.updated(active) never reopen it',
    async (status) => {
      const h = harness(status, false);
      await h.deliver(paid());
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
      expect(h.states[0].locked_out_at).toEqual(LOCKED_AT);
      h.row().updated_at = new Date(Date.now() - 30_000);
      await h.deliver(ev('customer.subscription.updated', sub('active')));
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
    },
  );

  it.each(['canceled', 'expired'])(
    '%s without access and a Day-10 lock: invoice.paid keeps it ended',
    async (status) => {
      const h = harness(status, false);
      await h.deliver(paid());
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
      expect(h.states[0].locked_out_at).toEqual(LOCKED_AT);
    },
  );

  it('control: a past_due plan locked at Day 10 recovers on invoice.paid (access back, lock lifted)', async () => {
    const h = harness('past_due', false);
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
    expect(h.states[0].locked_out_at).toBeNull();
  });

  // R-DISPUTE-PAUSE on main's webhook (B-DUNMR-120 restack of D2c).
  const pause = (h: ReturnType<typeof harness>) =>
    Object.assign(h.states[0], { status: 'active', last_failure_reason: 'charge_disputed' });
  it.each(['active', 'paid'])(
    'a paused plan (%s, no access): invoice.paid and sub.updated(active) keep access ended',
    async (status) => {
      const h = harness(status, false);
      pause(h);
      const clear = jest.spyOn(h.dunningV2, 'applyImmediateClear');
      await h.deliver(paid());
      expect(h.row().entitlement_active).toBe(false);
      expect(h.states[0].locked_out_at).toEqual(LOCKED_AT);
      // The webhook tx is passed on (it holds the purchase lock), and no
      // DunningState lock is taken before v1 writes that row on its own
      // connection (a 5 s stall and a failed delivery otherwise).
      expect(clear.mock.calls[0][2]).toBe(h.db);
      const v1At = (h.dunning.recordResolution as jest.Mock).mock.invocationCallOrder[0];
      const raw = (h.db.$queryRaw as jest.Mock).mock;
      raw.calls.forEach((c: [TemplateStringsArray], i: number) => {
        if (c[0].join('?').includes('"DunningState"'))
          expect(raw.invocationCallOrder[i]).toBeGreaterThan(v1At);
      });
      h.row().updated_at = new Date(Date.now() - 30_000);
      await h.deliver(ev('customer.subscription.updated', sub('active')));
      expect(h.row().entitlement_active).toBe(false);
    },
  );

  describe('C-680-19: a won dispute keeps a paused recurring plan revoked', () => {
    const won = (rd: RefundDisputeHandlerService) =>
      rd.handle({
        id: 'evt_won_18',
        type: 'charge.dispute.closed',
        data: { object: { id: 'dp_18', status: 'won' } },
      });
    function withDispute(status: string, entitled: boolean, billing = 'recurring') {
      const h = harness(status, entitled);
      Object.assign(h.row(), { billing_type: billing });
      const row = { id: 'cd_18', stripe_dispute_id: 'dp_18', purchase_id: 'cp_18', status: 'open' };
      h.db.chargeDispute = {
        findUnique: jest.fn(async () => ({ ...row })),
        update: jest.fn(async ({ data }: { data: object }) => Object.assign(row, data)),
      };
      h.db.clientPurchase.update = jest.fn(async ({ data }: { data: object }) =>
        Object.assign(h.row(), data),
      );
      const rd = new RefundDisputeHandlerService(
        h.db,
        stub({}),
        stub({}),
        stub({}),
        stub({}),
        stub({}),
      );
      return { h, rd };
    }
    it('won: stays disputed without access, and sub.updated(active) (flag off) never reopens it', async () => {
      const { h, rd } = withDispute('disputed', false);
      await won(rd);
      expect(h.row()).toMatchObject({ status: 'disputed', entitlement_active: false });
      process.env.FEATURE_DUNNING_V2 = 'false';
      h.row().updated_at = new Date(Date.now() - 30_000);
      await h.deliver(ev('customer.subscription.updated', sub('active')));
      expect(h.row()).toMatchObject({ status: 'disputed', entitlement_active: false });
    });
    it.each([
      ['a recurring plan that kept access', 'recurring', true],
      ['a one-time purchase', 'one_time', true],
    ])('control: %s rejoins the feed as paid', async (_l, billing, entitled) => {
      const { h, rd } = withDispute('disputed', entitled as boolean, billing as string);
      await won(rd);
      expect(h.row()).toMatchObject({ status: 'paid', entitlement_active: entitled });
    });
  });
});
