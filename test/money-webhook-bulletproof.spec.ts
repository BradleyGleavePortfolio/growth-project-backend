// MONEY-WEBHOOK-124 — the Stripe webhook money path on the real handlers:
// StripeWebhookController -> BillingService.handleEvent -> CheckoutWebhookHandlerService
// -> PurchaseFanoutService -> MediaAssetResolver, with Stripe fixtures and no network.
//
// The database double keeps PostgreSQL's transaction rules: unique indexes raise P2002,
// a raised error aborts the open transaction (every later statement fails until rollback,
// SQLSTATE 25P02), and a failed delivery rolls back every write, the dedup row included.
//
// B-WH-1: a client locked out for an unpaid renewal who then pays was never given access
// back (the repeat grant's coach-alert marker INSERT raised inside the webhook transaction,
// so every Stripe delivery failed). B-WH-2: a returning client whose new plan includes a
// PDF they already hold was never given access (same abort on the asset grant INSERT).
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BillingService } from '../src/billing/billing.service';
import { StripeWebhookController } from '../src/billing/stripe-webhook.controller';
import { signStripePayload } from '../src/billing/stripe-signature';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { AssignableAssetResolverRegistry } from '../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { MediaAssetResolver } from '../src/packages/asset-resolvers/media-asset.resolver';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

type Row = Record<string, any>;
type State = Record<string, Row[]>;

const UNIQUE: Record<string, string[][]> = {
  stripeProcessedEvent: [['stripe_event_id']],
  clientPurchase: [['id'], ['stripe_subscription_id']],
  purchaseFanout: [['purchase_id']],
  scheduledDrop: [['id'], ['client_purchase_id', 'content_id']],
  dripResolverMarker: [['purpose', 'purchase_id', 'content_id']],
  clientAssetGrant: [['id'], ['client_id', 'media_asset_id']],
};
const MODELS = [
  'stripeProcessedEvent', 'clientPurchase', 'coachPackage', 'coachPackageContent', 'purchaseFanout',
  'scheduledDrop', 'dripResolverMarker', 'user', 'coachMediaAsset', 'clientAssetGrant',
];

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    if (v && typeof v === 'object') {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('notIn' in v) return !(v.notIn as unknown[]).includes(row[k]);
      if ('not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ('lte' in v) return row[k] != null && row[k] <= v.lte;
      return matches(row, v as Row); // compound unique key
    }
    return row[k] === v;
  });
}

function apply(row: Row, data: Row = {}): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) {
      row[k] = (row[k] ?? 0) + v.increment;
    } else if (v !== undefined) row[k] = v;
  }
}

function p2002(model: string, keys: string[]) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${keys.map((k) => `\`${k}\``).join(',')}) on ${model}`,
    { code: 'P2002', clientVersion: 'test' },
  );
}

function makeDb(seed: State) {
  let state: State = seed;
  let seq = 0;
  const rows = (m: string) => (state[m] ??= []);
  const clash = (m: string, data: Row) =>
    (UNIQUE[m] ?? []).find(
      (keys) =>
        keys.every((k) => data[k] != null) &&
        rows(m).some((r) => keys.every((k) => r[k] === data[k])),
    );
  const insert = (m: string, data: Row) => {
    const row: Row = { id: `${m}-${(seq += 1)}`, created_at: new Date(), ...data };
    const keys = clash(m, row);
    if (keys) throw p2002(m, keys);
    rows(m).push(row);
    return { ...row };
  };
  // Reads return copies, as Prisma does: a later write never changes a row already read.
  const read = (m: string, where: Row) => {
    const r = rows(m).find((x) => matches(x, where));
    return r ? { ...r } : null;
  };
  const ops = (m: string): Record<string, (a: Row) => Promise<unknown>> => ({
    findUnique: async ({ where }) => read(m, where),
    findUniqueOrThrow: async ({ where }) => {
      const r = read(m, where);
      if (!r) throw Object.assign(new Error('No record found'), { code: 'P2025' });
      return r;
    },
    findFirst: async ({ where }) => read(m, where),
    findMany: async ({ where } = {}) => rows(m).filter((r) => matches(r, where)).map((r) => ({ ...r })),
    count: async ({ where } = {}) => rows(m).filter((r) => matches(r, where)).length,
    create: async ({ data }) => insert(m, data),
    createMany: async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const d of [].concat(data)) {
        if (skipDuplicates && clash(m, d)) continue;
        insert(m, d);
        count += 1;
      }
      return { count };
    },
    update: async ({ where, data }) => {
      const r = rows(m).find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
      apply(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }) => {
      const found = rows(m).filter((r) => matches(r, where));
      for (const r of found) apply(r, data);
      return { count: found.length };
    },
    upsert: async ({ where, create, update }) => {
      const r = rows(m).find((x) => matches(x, where));
      if (!r) return insert(m, create);
      apply(r, update);
      return { ...r };
    },
  });
  // ctx is null for the autocommit client and per-transaction otherwise.
  const client = (ctx: { aborted: boolean } | null): any => {
    const guard =
      (fn: (...a: any[]) => Promise<unknown>) =>
      async (...args: any[]) => {
        if (ctx?.aborted) {
          throw new Error(
            'current transaction is aborted, commands ignored until end of transaction block (25P02)',
          );
        }
        try {
          return await fn(...args);
        } catch (err) {
          if (ctx) ctx.aborted = true;
          throw err;
        }
      };
    const c: any = { $queryRaw: guard(async () => []) };
    for (const m of MODELS) {
      c[m] = Object.fromEntries(Object.entries(ops(m)).map(([k, fn]) => [k, guard(fn)]));
    }
    c.$transaction = async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await cb(client({ aborted: false }));
      } catch (err) {
        state = snapshot;
        throw err;
      }
    };
    return c;
  };
  return { db: client(null), rows };
}

class StripeStub extends StripeConnectApiService {
  subs: Record<string, Row> = {};
  failReads = 0;
  retrieveSubscription = jest.fn(async (id: string): Promise<any> => {
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('stripe unavailable');
    }
    return this.subs[id];
  });
  retrieveSubscriptionForCheckout = jest.fn(async (id: string): Promise<any> => this.subs[id]);
}

const NOW_S = Math.floor(Date.now() / 1000);
const PERIOD_END = NOW_S + 30 * 86_400;
const liveSub = (id: string, over: Row = {}): Row => ({
  id,
  status: 'active',
  customer: 'cus_1',
  current_period_end: PERIOD_END,
  cancel_at_period_end: false,
  canceled_at: null,
  default_payment_method: 'pm_1',
  metadata: {},
  ...over,
});

function purchase(id: string, sub: string, over: Row = {}): Row {
  return {
    id,
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_subscription_id: sub,
    stripe_checkout_session_id: sub,
    stripe_payment_intent_id: null,
    stripe_customer_id: 'cus_1',
    status: 'active',
    entitlement_active: true,
    trial_days: null,
    trial_started_at: null,
    trial_ends_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    current_period_end: new Date(PERIOD_END * 1000),
    access_expires_at: null,
    last_error: null,
    created_at: new Date(Date.now() - 60 * 86_400_000),
    updated_at: new Date(Date.now() - 86_400_000),
    ...over,
  };
}

function makeWorld(seed: State = {}) {
  const { db, rows } = makeDb({
    user: [
      { id: 'client-1', name: 'Client One', email: 'client-1@example.test' },
      { id: 'coach-1', name: 'Coach One', email: 'coach-1@example.test' },
    ],
    coachPackage: [
      { id: 'pkg-1', coach_id: 'coach-1', name: 'Monthly coaching', billing_type: 'recurring', amount_cents: 4900 },
    ],
    ...seed,
  });
  const stripe = new StripeStub();
  const splits = { onChargeSucceeded: jest.fn(async () => undefined) };
  const scope = { resolve: async (coachId: string) => ({ tenantCoachId: coachId, actingCoachId: coachId }) };
  // Reflect.construct keeps the partial doubles untyped without a banned cast.
  const media: MediaAssetResolver = Reflect.construct(MediaAssetResolver, [db, scope]);
  const fanout = new PurchaseFanoutService(new AssignableAssetResolverRegistry([media]));
  const handler: CheckoutWebhookHandlerService = Reflect.construct(CheckoutWebhookHandlerService, [
    db, stripe, splits, undefined, undefined, fanout,
  ]);
  const billing: BillingService = Reflect.construct(BillingService, [
    db,
    { capture: jest.fn(), identify: jest.fn() },
    { write: jest.fn(async () => undefined), list: jest.fn(async () => []) },
    undefined,
    handler,
  ]);
  const row = (m: string, id: string) => rows(m).find((r) => r.id === id);
  return { db, rows, row, stripe, splits, billing };
}

type Ev = { id: string; type: string; data: { object: Row } };
const invoicePaid = (id: string, sub: string, cents: number, charge: string): Ev => ({
  id,
  type: 'invoice.paid',
  data: { object: { id: `in_${id}`, subscription: sub, amount_paid: cents, currency: 'usd', charge } },
});
const subUpdated = (id: string, sub: Row): Ev => ({
  id,
  type: 'customer.subscription.updated',
  data: { object: sub },
});

// A plan whose renewal card declined: past the Days 0-9 grace the plan is locked
// (entitlement off, subscription unpaid). It was granted once before, so its fan-out
// and coach "new purchase" marker already exist.
function lockedOut(): State {
  return {
    clientPurchase: [purchase('cp-1', 'sub_1', { status: 'unpaid', entitlement_active: false })],
    purchaseFanout: [{ id: 'fo-1', purchase_id: 'cp-1', entrypoint: 'in_app_ps', state: 'succeeded' }],
    dripResolverMarker: [{ id: 'mk-1', purpose: 'coach_new_purchase', purchase_id: 'cp-1', content_id: '-' }],
  };
}

describe('MONEY-WEBHOOK-124 — Stripe webhooks on the real handlers', () => {
  it('B-WH-1: a locked-out client pays the overdue renewal; invoice.paid restores access on the first delivery and pays the coach the exact cents once', async () => {
    const w = makeWorld(lockedOut());
    w.stripe.subs.sub_1 = liveSub('sub_1');

    await expect(w.billing.handleEvent(invoicePaid('evt_paid_1', 'sub_1', 4900, 'ch_renew'))).resolves.toEqual({
      processed: true,
    });
    expect(w.row('clientPurchase', 'cp-1')).toMatchObject({ status: 'active', entitlement_active: true });
    expect(w.rows('stripeProcessedEvent')).toEqual([
      expect.objectContaining({ stripe_event_id: 'evt_paid_1', handler_completed_at: expect.any(Date) }),
    ]);
    expect(w.splits.onChargeSucceeded).toHaveBeenCalledTimes(1);
    expect(w.splits.onChargeSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_amount_cents: 4900, invoice_charge_id: 'ch_renew' }),
    );
    // The coach is not told about a "new purchase" again.
    expect(w.rows('dripResolverMarker')).toHaveLength(1);

    // Same event twice = one effect.
    await expect(w.billing.handleEvent(invoicePaid('evt_paid_1', 'sub_1', 4900, 'ch_renew'))).resolves.toEqual({
      processed: false,
      alreadyProcessed: true,
    });
    expect(w.splits.onChargeSucceeded).toHaveBeenCalledTimes(1);
  });

  it('B-WH-1: the subscription update (unpaid -> active) arriving before invoice.paid restores access too', async () => {
    const w = makeWorld(lockedOut());
    w.stripe.subs.sub_1 = liveSub('sub_1');

    await expect(w.billing.handleEvent(subUpdated('evt_sub_1', liveSub('sub_1')))).resolves.toEqual({
      processed: true,
    });
    expect(w.row('clientPurchase', 'cp-1')).toMatchObject({ status: 'active', entitlement_active: true });

    await expect(w.billing.handleEvent(invoicePaid('evt_paid_2', 'sub_1', 4900, 'ch_renew'))).resolves.toEqual({
      processed: true,
    });
    expect(w.row('clientPurchase', 'cp-1')).toMatchObject({ status: 'active', entitlement_active: true });
    expect(w.splits.onChargeSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_amount_cents: 4900 }),
    );
  });

  it('B-WH-2: a returning client whose new plan includes a PDF they already hold gets access on the first payment', async () => {
    const w = makeWorld({
      clientPurchase: [
        purchase('cp-2', 'sub_2', {
          status: 'incomplete',
          entitlement_active: false,
          created_at: new Date(),
          current_period_end: null,
        }),
      ],
      coachPackageContent: [
        {
          id: 'content-pdf',
          package_id: 'pkg-1',
          removed_at: null,
          display_order: 0,
          asset_type: 'pdf',
          asset_id: 'pdf-1',
          asset_revision_id: null,
          cadence_kind: 'immediate',
          cadence_payload: {},
          display_title: 'Welcome guide',
          display_caption: null,
        },
      ],
      coachMediaAsset: [{ id: 'pdf-1', coach_id: 'coach-1', archived_at: null, status: 'ready' }],
      // Granted by the plan this client bought last year.
      clientAssetGrant: [{ id: 'grant-old', client_id: 'client-1', media_asset_id: 'pdf-1' }],
    });
    w.stripe.subs.sub_2 = liveSub('sub_2');

    await expect(w.billing.handleEvent(invoicePaid('evt_first_2', 'sub_2', 4900, 'ch_first'))).resolves.toEqual({
      processed: true,
    });
    expect(w.row('clientPurchase', 'cp-2')).toMatchObject({ status: 'active', entitlement_active: true });
    expect(w.rows('scheduledDrop')).toEqual([
      expect.objectContaining({ client_purchase_id: 'cp-2', status: 'fired', materialised_ref: 'grant-old' }),
    ]);
    expect(w.rows('clientAssetGrant')).toHaveLength(1);
    expect(w.splits.onChargeSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_amount_cents: 4900, invoice_charge_id: 'ch_first' }),
    );
  });

  it('a delivery that fails mid-handler leaves no half-written state and the Stripe retry applies it once', async () => {
    const w = makeWorld(lockedOut());
    w.stripe.subs.sub_1 = liveSub('sub_1');
    w.stripe.failReads = 1;

    await expect(w.billing.handleEvent(invoicePaid('evt_paid_3', 'sub_1', 4900, 'ch_renew'))).rejects.toThrow();
    expect(w.row('clientPurchase', 'cp-1')).toMatchObject({ status: 'unpaid', entitlement_active: false });
    expect(w.rows('stripeProcessedEvent')).toEqual([]);
    expect(w.splits.onChargeSucceeded).not.toHaveBeenCalled();

    await expect(w.billing.handleEvent(invoicePaid('evt_paid_3', 'sub_1', 4900, 'ch_renew'))).resolves.toEqual({
      processed: true,
    });
    expect(w.row('clientPurchase', 'cp-1')).toMatchObject({ status: 'active', entitlement_active: true });
    expect(w.splits.onChargeSucceeded).toHaveBeenCalledTimes(1);
  });

  it('cancel at period end keeps access until Stripe ends the subscription, then access stops', async () => {
    const w = makeWorld({ clientPurchase: [purchase('cp-4', 'sub_4')] });
    const ending = liveSub('sub_4', { cancel_at_period_end: true });
    w.stripe.subs.sub_4 = ending;

    await w.billing.handleEvent(subUpdated('evt_cancel_req', ending));
    expect(w.row('clientPurchase', 'cp-4')).toMatchObject({
      status: 'active',
      entitlement_active: true,
      cancel_at_period_end: true,
    });

    const ended = liveSub('sub_4', { status: 'canceled', canceled_at: PERIOD_END });
    await w.billing.handleEvent({ id: 'evt_deleted', type: 'customer.subscription.deleted', data: { object: ended } });
    expect(w.row('clientPurchase', 'cp-4')).toMatchObject({ status: 'canceled', entitlement_active: false });
  });

  describe('signature check (StripeWebhookController)', () => {
    const SECRET = 'test-signing-secret-money-124';
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    beforeEach(() => {
      process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = saved;
    });
    const call = (ctl: StripeWebhookController, payload: string, sig: string) =>
      Reflect.apply(ctl.stripe, ctl, [{ rawBody: Buffer.from(payload, 'utf8') }, sig]);

    it('a correctly signed event reaches the handler; a tampered or unsigned body is refused with 400 and changes nothing', async () => {
      const w = makeWorld(lockedOut());
      w.stripe.subs.sub_1 = liveSub('sub_1');
      const ctl = new StripeWebhookController(w.billing);
      const payload = JSON.stringify(invoicePaid('evt_signed', 'sub_1', 4900, 'ch_renew'));

      const tampered = payload.replace('"amount_paid":4900', '"amount_paid":1');
      await expect(call(ctl, tampered, signStripePayload({ payload, secret: SECRET }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(call(ctl, payload, '')).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        call(ctl, payload, signStripePayload({ payload, secret: 'test-signing-secret-other' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(w.row('clientPurchase', 'cp-1')).toMatchObject({ entitlement_active: false });

      await expect(call(ctl, payload, signStripePayload({ payload, secret: SECRET }))).resolves.toEqual({
        processed: true,
      });
      expect(w.row('clientPurchase', 'cp-1')).toMatchObject({ entitlement_active: true });
    });
  });
});
