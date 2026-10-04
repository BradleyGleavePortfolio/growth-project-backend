// AUD-OPUS-661-118 independent probe (Claude Opus 5.5 lens, agent 118; never merge).
// Real PostgreSQL (runner-local, lane-only global setup), full schema via bootstrapTestSchema,
// real CheckoutWebhookHandlerService + PurchaseFanoutService + Prisma. Targets the #661 delta
// since this lens's APPROVE at 957e3677: the round-6/7 owner query (activatedFailedPurchases),
// the owner-first order in applyPaymentIntentSucceeded, the B-661-9 drop takeover in
// cancelPendingForPurchase, and FOR NO KEY UPDATE.
import type { Prisma } from '@prisma/client';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { PrismaService } from '../src/prisma.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const live = DB_URL ? describe : describe.skip;
const [CLIENT, COACH, PKG] = ['ao118-client', 'ao118-coach', 'ao118-pkg'];
class StripeStub extends StripeConnectApiService {
  status = 'succeeded';
  retrievePaymentIntent = jest.fn(async (id: string) => ({ id, status: this.status }));
}
type Ev = { id: string; type: string; data: { object: Record<string, unknown> } };
let seq = 0;
const ev = (type: string, id: string): Ev => ({
  id: `evt_ao118_${(seq += 1)}`,
  type,
  data: { object: { id } },
});
// Unordered purchase reads answered in an adversarial legal order (owner is always the oldest
// row): findMany newest first, findFirst oldest first. Explicit orders are left alone.
function legalOrder<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key !== 'clientPurchase' || !value || typeof value !== 'object') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return new Proxy(value, {
        get(delegate, method) {
          const fn: unknown = Reflect.get(delegate, method);
          if (typeof fn !== 'function') return fn;
          if (method !== 'findFirst' && method !== 'findMany') return fn.bind(delegate);
          const created_at = method === 'findFirst' ? 'asc' : 'desc';
          return (args: { orderBy?: unknown } = {}) =>
            fn.call(delegate, { ...args, orderBy: args.orderBy ?? { created_at } });
        },
      });
    },
  });
}

live('AUD-OPUS-661-118: #661 round 6-8 delta on real PostgreSQL', () => {
  let prisma: PrismaService;
  let handler: CheckoutWebhookHandlerService;
  let fanout: PurchaseFanoutService;
  const stripe = new StripeStub();
  const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(fn, { timeout: 30_000, maxWait: 10_000 });
  async function deliver(e: Ev) {
    const pre = await handler.prefetchForOuterTx(e);
    return inTx((tx) => handler.handle(e, legalOrder(tx), pre));
  }
  const base = Date.now() - 3_600_000;
  type Seed = {
    pi: string;
    status: string;
    at: number;
    activated?: boolean;
    billing?: string;
    sub?: string;
    drop?: { status: string; reason: string | null };
  };
  async function seed(id: string, o: Seed) {
    await prisma.clientPurchase.create({
      data: {
        id,
        client_user_id: CLIENT,
        coach_user_id: COACH,
        package_id: PKG,
        amount_cents: 5000,
        stripe_checkout_session_id: `cs_${id}`,
        idempotency_key: id,
        stripe_payment_intent_id: o.pi,
        status: o.status,
        billing_type: o.billing ?? 'one_time',
        stripe_subscription_id: o.sub ?? null,
        entitlement_active: o.status === 'paid',
        created_at: new Date(base + o.at),
      },
    });
    if (o.activated) {
      await prisma.purchaseFanout.create({
        data: { purchase_id: id, entrypoint: 'in_app_hosted', state: 'succeeded' },
      });
    }
    if (o.drop) {
      await prisma.scheduledDrop.create({
        data: {
          id: `d-${id}`,
          client_purchase_id: id,
          content_id: `c-${id}`,
          asset_type: 'workout',
          asset_id: 'a1',
          cadence_kind: 'offset_days',
          cadence_payload: {},
          fire_at: new Date(Date.now() + 86_400_000),
          status: o.drop.status,
          failure_reason: o.drop.reason,
        },
      });
    }
  }
  const snap = async (ids: string[]) => {
    const rows = await prisma.clientPurchase.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const drops = await prisma.scheduledDrop.findMany({
      where: { client_purchase_id: { in: ids } },
      orderBy: { id: 'asc' },
    });
    return {
      rows: rows.map((r) => [r.id, r.status, r.entitlement_active, r.stripe_payment_intent_id]),
      drops: drops.map((d) => [d.id, d.status, d.failure_reason]),
      fanouts: await prisma.purchaseFanout.count({ where: { purchase_id: { in: ids } } }),
    };
  };

  beforeAll(async () => {
    const pool = `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}connection_limit=8`;
    prisma = new PrismaService({ datasources: { db: { url: pool } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    for (const id of [CLIENT, COACH]) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: id } });
    }
    await prisma.coachPackage.create({
      data: { id: PKG, coach_id: COACH, name: 'Probe package', amount_cents: 5000 },
    });
    fanout = new PurchaseFanoutService(undefined, undefined, undefined, prisma);
    handler = new CheckoutWebhookHandlerService(
      legalOrder(prisma),
      stripe,
      undefined,
      undefined,
      undefined,
      fanout,
    );
  }, 180_000);
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  // O1: every owner condition (status, one-time, no subscription, activation record) is in the
  // query, so 30 never-activated rows plus activated rows that are NOT owners (recurring, with a
  // subscription, refunded, chargeback_lost, canceled), all newer than the owner, never push the
  // owner out of the ten-row read and are never recovered themselves.
  it('O1: the owner recovers behind 30 never-activated rows and 5 activated non-owners; none of them changes, a redelivery changes nothing', async () => {
    const pi = 'pi_ao118_o1';
    const owner = 'o1-owner';
    await seed(owner, {
      pi,
      status: 'payment_failed',
      at: 0,
      activated: true,
      drop: { status: 'canceled', reason: 'canceled:payment_failed' },
    });
    const nonOwners: Array<[string, Seed]> = [
      ['o1-recurring', { pi, status: 'payment_failed', at: 1_000, activated: true, billing: 'recurring',
        drop: { status: 'canceled', reason: 'canceled:payment_failed' } }],
      ['o1-sub', { pi, status: 'payment_failed', at: 2_000, activated: true, sub: 'sub_ao118_o1',
        drop: { status: 'canceled', reason: 'canceled:payment_failed' } }],
      ['o1-refunded', { pi, status: 'refunded', at: 3_000, activated: true,
        drop: { status: 'canceled', reason: 'canceled:refund' } }],
      ['o1-lost', { pi, status: 'chargeback_lost', at: 4_000, activated: true,
        drop: { status: 'canceled', reason: 'canceled:dispute' } }],
      ['o1-canceled', { pi, status: 'canceled', at: 5_000, activated: true,
        drop: { status: 'canceled', reason: 'canceled:payment_failed' } }],
    ];
    for (const [id, o] of nonOwners) await seed(id, o);
    const adopted: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = `o1-adopted-${String(i).padStart(2, '0')}`;
      adopted.push(id);
      await seed(id, { pi, status: 'payment_failed', at: 10_000 + i * 1_000 });
    }
    const others = [...nonOwners.map(([id]) => id), ...adopted];
    const before = await snap(others);
    // The boundary is real: an unfiltered ten-row read newest first misses the owner.
    const unfiltered = await legalOrder(prisma).clientPurchase.findMany({
      where: { stripe_payment_intent_id: pi, status: 'payment_failed' },
      take: 10,
    });
    expect(unfiltered.some((p) => p.id === owner)).toBe(false);

    const success = ev('payment_intent.succeeded', pi);
    expect(await deliver(success)).toEqual({ claimed: true, purchase_id: owner, reason: 'payment_recovered' });
    expect(await snap([owner])).toEqual({
      rows: [[owner, 'paid', true, pi]],
      drops: [[`d-${owner}`, 'pending', null]],
      fanouts: 1,
    });
    expect(await snap(others)).toEqual(before);

    // Redelivery: nothing left to recover; the non-owners are still not activated by it.
    const again = await deliver(ev('payment_intent.succeeded', pi));
    expect(again).toMatchObject({ claimed: false });
    expect(await snap(others)).toEqual(before);
    expect((await snap([owner])).rows).toEqual([[owner, 'paid', true, pi]]);
  }, 90_000);

  // O2: the no-transaction path (db = PrismaService itself) finds the owner too and its
  // compare-and-set recovery restores access once.
  it('O2: no-transaction path: the owner query and the compare-and-set recovery work on PrismaService', async () => {
    const pi = 'pi_ao118_o2';
    const owner = 'o2-owner';
    await seed(owner, {
      pi,
      status: 'payment_failed',
      at: 0,
      activated: true,
      drop: { status: 'canceled', reason: 'canceled:payment_failed' },
    });
    for (let i = 0; i < 12; i += 1) {
      await seed(`o2-adopted-${i}`, { pi, status: 'payment_failed', at: 10_000 + i * 1_000 });
    }
    expect(await handler.handle(ev('payment_intent.succeeded', pi))).toEqual({
      claimed: true,
      purchase_id: owner,
      reason: 'payment_recovered',
    });
    expect(await snap([owner])).toEqual({
      rows: [[owner, 'paid', true, pi]],
      drops: [[`d-${owner}`, 'pending', null]],
      fanouts: 1,
    });
    expect(await handler.handle(ev('payment_intent.succeeded', pi))).toMatchObject({ claimed: false });
  }, 60_000);

  // D1: B-661-9 takeover for every non-failure reason on real PostgreSQL. Pending/due and
  // failure-canceled drops take the new reason; drops canceled for another reason, fired and
  // failed drops are untouched; a later recovery restores none of them.
  it.each(['refund', 'dispute', 'subscription_canceled', 'partial_refund_decision', 'grant_revoked'] as const)(
    'D1: a %s cancel takes over failure-canceled drops and never touches other reasons; recovery restores nothing',
    async (reason) => {
      const id = `d1-${reason}`;
      await seed(id, { pi: `pi_${id}`, status: 'paid', at: 0 });
      const other = reason === 'refund' ? 'canceled:dispute' : 'canceled:refund';
      const drops: Array<[string, string, string | null]> = [
        ['a', 'pending', null],
        ['b', 'due', null],
        ['c', 'canceled', 'canceled:payment_failed'],
        ['d', 'canceled', other],
        ['e', 'fired', null],
        ['f', 'failed', 'resolver failed'],
      ];
      for (const [k, status, failure_reason] of drops) {
        await prisma.scheduledDrop.create({
          data: { id: `${id}-${k}`, client_purchase_id: id, content_id: `${id}-${k}`, asset_type: 'workout',
            asset_id: 'a1', cadence_kind: 'offset_days', cadence_payload: {}, status, failure_reason },
        });
      }
      const count = await inTx((tx) => fanout.cancelPendingForPurchase(id, reason, tx));
      expect(count).toBe(3);
      const read = async () =>
        (await prisma.scheduledDrop.findMany({ where: { client_purchase_id: id }, orderBy: { id: 'asc' } })).map(
          (d) => [d.id.slice(-1), d.status, d.failure_reason],
        );
      const expected = [
        ['a', 'canceled', `canceled:${reason}`],
        ['b', 'canceled', `canceled:${reason}`],
        ['c', 'canceled', `canceled:${reason}`],
        ['d', 'canceled', other],
        ['e', 'fired', null],
        ['f', 'failed', 'resolver failed'],
      ];
      expect(await read()).toEqual(expected);
      expect(await inTx((tx) => fanout.restoreAfterPaymentRecovered(id, tx))).toBe(0);
      expect(await read()).toEqual(expected);
    },
    60_000,
  );

  // D2: a payment failure cancel never takes over another reason, so the recovery restores only
  // the drops that failure canceled.
  it('D2: a payment_failed cancel leaves other reasons alone; recovery restores only failure-canceled drops', async () => {
    const id = 'd2';
    await seed(id, { pi: 'pi_d2', status: 'paid', at: 0 });
    const drops: Array<[string, string, string | null]> = [
      ['a', 'pending', null],
      ['b', 'canceled', 'canceled:payment_failed'],
      ['c', 'canceled', 'canceled:partial_refund_decision'],
      ['d', 'canceled', 'canceled:refund'],
      ['e', 'fired', null],
    ];
    for (const [k, status, failure_reason] of drops) {
      await prisma.scheduledDrop.create({
        data: { id: `${id}-${k}`, client_purchase_id: id, content_id: `${id}-${k}`, asset_type: 'workout',
          asset_id: 'a1', cadence_kind: 'offset_days', cadence_payload: {}, status, failure_reason },
      });
    }
    expect(await inTx((tx) => fanout.cancelPendingForPurchase(id, 'payment_failed', tx))).toBe(1);
    expect(await inTx((tx) => fanout.restoreAfterPaymentRecovered(id, tx))).toBe(2);
    const after = (
      await prisma.scheduledDrop.findMany({ where: { client_purchase_id: id }, orderBy: { id: 'asc' } })
    ).map((d) => [d.id.slice(-1), d.status, d.failure_reason]);
    expect(after).toEqual([
      ['a', 'pending', null],
      ['b', 'pending', null],
      ['c', 'canceled', 'canceled:partial_refund_decision'],
      ['d', 'canceled', 'canceled:refund'],
      ['e', 'fired', null],
    ]);
  }, 60_000);

  // L1: while a success transaction holds the PaymentIntent lock (FOR NO KEY UPDATE), another
  // connection can still insert a ScheduledDrop that references the purchase (FK check takes
  // FOR KEY SHARE); an UPDATE of the purchase waits.
  it('L1: the PaymentIntent lock never blocks an insert of a referencing ScheduledDrop; an UPDATE waits', async () => {
    await seed('l1', { pi: 'pi_l1', status: 'paid', at: 0 });
    let open: () => void = () => undefined;
    const release = new Promise<void>((r) => (open = r));
    let heldOpen: () => void = () => undefined;
    const held = new Promise<void>((r) => (heldOpen = r));
    const locker = inTx(async (tx) => {
      await handler['lockPurchasesOfPaymentIntent'](tx, 'pi_l1');
      heldOpen();
      await release;
    });
    await held;
    const insert = prisma.scheduledDrop
      .create({
        data: { id: 'l1-drop', client_purchase_id: 'l1', content_id: 'l1-c', asset_type: 'workout',
          asset_id: 'a1', cadence_kind: 'offset_days', cadence_payload: {} },
      })
      .then(() => 'inserted');
    const outcome = await Promise.race([insert, new Promise((r) => setTimeout(() => r('blocked'), 3_000))]);
    let updated = false;
    const update = prisma.clientPurchase
      .update({ where: { id: 'l1' }, data: { last_error: 'probe' } })
      .then(() => (updated = true));
    await new Promise((r) => setTimeout(r, 1_500));
    const updatedWhileHeld = updated;
    open();
    await Promise.all([locker, insert, update]);
    expect({ outcome, updatedWhileHeld, updated }).toEqual({
      outcome: 'inserted',
      updatedWhileHeld: false,
      updated: true,
    });
  }, 60_000);
});
