// #661 settlement on real PostgreSQL (C-661-12: the AUD-OPUS-661R5-117 probe, plus
// B-661-3, B-661-9 and C-661-11 in round 6, the B-661-3 list boundary in round 7). Real
// handler, PurchaseFanoutService, PartialRefundDecisionService, CheckoutService and Prisma
// on the full schema: xmin, row locks and P2025 are the database's own. Gated on
// MWB3_TEST_DATABASE_URL (mwb-3-live-tests).
import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { PrismaService } from '../src/prisma.service';
import { PartialRefundDecisionService } from '../src/regimes/partial-refund-decision.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = DB_URL ? describe : describe.skip;
const [CLIENT, COACH, PKG] = ['l661-client', 'l661-coach', 'l661-pkg'];
class StripeStub extends StripeConnectApiService {
  status = 'requires_payment_method';
  retrievePaymentIntent = jest.fn(async (id: string) => ({ id, status: this.status }));
}
type Ev = { id: string; type: string; data: { object: Record<string, unknown> } };
let seq = 0;
const ev = (type: string, id: string, rest: Record<string, unknown> = {}): Ev => ({
  id: `evt_l661_${(seq += 1)}`,
  type,
  data: { object: { id, ...rest } },
});
function deferred() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Partial doubles of CheckoutService's collaborators (packages, Connect state, fees, contracts).
const wire = <T>(value: object): T => value as T;
// Answers the purchase reads that name no order in an adversarial legal order: findMany
// newest first, findFirst oldest first. Reads with an explicit order are unchanged.
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

liveDescribe('#661 settlement on real PostgreSQL', () => {
  let prisma: PrismaService;
  let handler: CheckoutWebhookHandlerService;
  let fanout: PurchaseFanoutService;
  let decisions: PartialRefundDecisionService;
  const stripe = new StripeStub();
  const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(fn, { timeout: 30_000, maxWait: 10_000 });
  async function deliver(e: Ev) {
    const pre = await handler.prefetchForOuterTx(e);
    return inTx((tx) => handler.handle(e, tx, pre));
  }
  const row = (id: string) => prisma.clientPurchase.findUniqueOrThrow({ where: { id } });
  const drop = (id: string) => prisma.scheduledDrop.findUniqueOrThrow({ where: { id: `d-${id}` } });
  async function lockWaiterSeen(): Promise<boolean> {
    for (let i = 0; i < 60; i += 1) {
      const [r] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n
        FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (r.n > 0) return true;
      await sleep(50);
    }
    return false;
  }
  type Seed = { status: string; sheet?: boolean; activated?: boolean; dropReason?: string };
  async function seed(id: string, pi: string, o: Seed) {
    const [session, secret] = o.sheet ? [pi, `${pi}_secret_l661`] : [`cs_${id}`, null];
    await prisma.clientPurchase.create({ data: { id, client_user_id: CLIENT, coach_user_id: COACH,
      package_id: PKG, amount_cents: 5000, stripe_checkout_session_id: session, idempotency_key: id,
      stripe_payment_intent_id: pi, status: o.status, entitlement_active: o.status === 'paid',
      stripe_client_secret: secret } });
    if (!o.activated) return;
    const state = { purchase_id: id, entrypoint: 'in_app_hosted', state: 'succeeded' };
    await prisma.purchaseFanout.create({ data: state });
    await prisma.scheduledDrop.create({ data: { id: `d-${id}`, client_purchase_id: id,
      content_id: id, asset_type: 'workout', asset_id: 'a1', cadence_kind: 'offset_days',
      cadence_payload: {}, fire_at: new Date(Date.now() + 86_400_000),
      status: o.dropReason ? 'canceled' : 'pending', failure_reason: o.dropReason ?? null } });
  }
  async function failedThenDecided(id: string) {
    await seed(id, `pi_${id}`, { status: 'paid', activated: true });
    const decision = { client_purchase_id: id, stripe_refund_id: `re_${id}` };
    await prisma.partialRefundDecision.create({ data: decision });
    stripe.status = 'requires_payment_method';
    await deliver(ev('payment_intent.payment_failed', `pi_${id}`));
    stripe.status = 'succeeded';
  }

  beforeAll(async () => {
    const pool = `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}connection_limit=16`;
    prisma = new PrismaService({ datasources: { db: { url: pool } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    for (const id of [CLIENT, COACH]) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: id } });
    }
    await prisma.coachPackage.create({
      data: { id: PKG, coach_id: COACH, name: 'Live package', amount_cents: 5000 },
    });
    fanout = new PurchaseFanoutService(undefined, undefined, undefined, prisma);
    handler = new CheckoutWebhookHandlerService(prisma, stripe, undefined, undefined, undefined, fanout);
    decisions = new PartialRefundDecisionService(prisma, fanout);
  }, 180_000);
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('xmin versions the row (equal updated_at too, not a lock or a rollback): an old decline is retried, a fresh one revokes, a late completion never re-activates, the success recovers once', async () => {
    await seed('v', 'pi_v', { status: 'paid', activated: true });
    const version = async () => (await handler['readPurchaseVersion'](prisma, 'v', false))?.row_version;
    const v0 = await version();
    await inTx((tx) => handler['readPurchaseVersion'](tx, 'v', true));
    const rollback = inTx(async (tx) => {
      await tx.clientPurchase.update({ where: { id: 'v' }, data: { last_error: 'x' } });
      throw new Error('rolled back');
    });
    await expect(rollback).rejects.toThrow('rolled back');
    expect(await version()).toBe(v0);
    const decline = ev('payment_intent.payment_failed', 'pi_v');
    const pre = await handler.prefetchForOuterTx(decline);
    const { updated_at } = await row('v');
    await deliver(ev('payment_intent.succeeded', 'pi_v'));
    await prisma.$executeRaw`UPDATE "ClientPurchase" SET updated_at = ${updated_at} WHERE id = 'v'`;
    expect((await row('v')).updated_at).toEqual(updated_at);
    const stale = await inTx((tx) => handler.handle(decline, tx, pre)).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ServiceUnavailableException);
    expect(await row('v')).toMatchObject({ status: 'paid', entitlement_active: true });
    expect(await deliver(decline)).toEqual({ claimed: true, purchase_id: 'v' });
    expect(await drop('v')).toMatchObject({ status: 'canceled' });
    const late = ev('checkout.session.completed', 'cs_v', { payment_intent: 'pi_v', mode: 'payment' });
    expect(await deliver(late)).toMatchObject({ reason: 'already_progressed' });
    stripe.status = 'succeeded';
    const success = ev('payment_intent.succeeded', 'pi_v');
    expect(await deliver(success)).toMatchObject({ claimed: true, reason: 'payment_recovered' });
    expect(await row('v')).toMatchObject({ status: 'paid', entitlement_active: true });
    expect(await drop('v')).toMatchObject({ status: 'pending', failure_reason: null });
    expect(await deliver(success)).toEqual({ claimed: false, reason: 'no_matching_purchase' });
  }, 60_000);

  it('B-661-8: a refund holding the row wins over a success waiting on the lock (P2025 on a missed compare-and-set); two concurrent successes activate once', async () => {
    await seed('r', 'pi_r', { status: 'pending', sheet: true });
    const [held, release] = [deferred(), deferred()];
    const refund = inTx(async (tx) => {
      await tx.clientPurchase.update({ where: { id: 'r' }, data: { status: 'refunded' } });
      held.open();
      await release.opened;
    });
    await held.opened;
    const success = deliver(ev('payment_intent.succeeded', 'pi_r'));
    expect(await lockWaiterSeen()).toBe(true);
    release.open();
    await refund;
    expect(await success).toEqual({ claimed: false, reason: 'no_matching_purchase' });
    const cas = { where: { id: 'r', status: 'pending' }, data: { status: 'paid' } };
    expect(await prisma.clientPurchase.update(cas).catch((e: unknown) => e)).toMatchObject({ code: 'P2025' });
    await seed('t', 'pi_t', { status: 'pending', sheet: true });
    const both = await Promise.all([1, 2].map(() => deliver(ev('payment_intent.succeeded', 'pi_t'))));
    expect(both.filter((r) => r.claimed)).toHaveLength(1);
    expect(await row('t')).toMatchObject({ status: 'paid', stripe_client_secret: null });
    expect(await prisma.purchaseFanout.count({ where: { purchase_id: 't' } })).toBe(1);
  }, 60_000);

  it('C-661-11: the purchase locks block an UPDATE of the row, never an insert that references it', async () => {
    await seed('k', 'pi_k', { status: 'paid' });
    const [held, release] = [deferred(), deferred()];
    const locker = inTx(async (tx) => {
      await handler['lockPurchasesOfPaymentIntent'](tx, 'pi_k');
      await handler['readPurchaseVersion'](tx, 'k', true);
      held.open();
      await release.opened;
    });
    await held.opened;
    const fk = { data: { purchase_id: 'k', entrypoint: 'in_app_hosted', state: 'succeeded' } };
    const insert = prisma.purchaseFanout.create(fk).then(() => 'inserted');
    const outcome = await Promise.race([insert, sleep(3_000).then(() => 'blocked')]);
    const write = { where: { id: 'k' }, data: { last_error: 'w' } };
    const update = prisma.clientPurchase.update(write).then(() => 'updated');
    const updateWaited = await lockWaiterSeen();
    release.open();
    await Promise.all([locker, insert, update]);
    expect({ outcome, updateWaited }).toEqual({ outcome: 'inserted', updateWaited: true });
  }, 60_000);

  it.each(['adopted', 'owner'])('B-661-3: an activated owner and a never-activated adopted purchase share a PaymentIntent (%s inserted first): the owner recovers, the adopted one gains nothing', async (first) => {
    const pi = `pi_two_${first}`;
    const [owner, adopted] = [`owner-${first}`, `adopted-${first}`];
    const seedOwner = () =>
      seed(owner, pi, { status: 'payment_failed', activated: true, dropReason: 'canceled:payment_failed' });
    if (first === 'owner') await seedOwner();
    await seed(adopted, pi, { status: 'payment_failed' });
    if (first === 'adopted') await seedOwner();
    stripe.status = 'succeeded';
    const result = await deliver(ev('payment_intent.succeeded', pi));
    expect(result).toEqual({ claimed: true, purchase_id: owner, reason: 'payment_recovered' });
    expect(await row(owner)).toMatchObject({ status: 'paid', entitlement_active: true });
    expect(await drop(owner)).toMatchObject({ status: 'pending' });
    expect(await row(adopted)).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    expect(await prisma.purchaseFanout.count({ where: { purchase_id: adopted } })).toBe(0);
  }, 60_000);

  it.each([
    ['unassign_drops', 'canceled'],
    ['keep_drops', 'pending'],
  ] as const)('B-661-9: a coach decision (%s) committed after the failure still decides the drop after the recovery', async (decision, expected) => {
    await failedThenDecided(`s-${decision}`);
    await decisions.decide(COACH, `re_s-${decision}`, decision);
    const recovered = await deliver(ev('payment_intent.succeeded', `pi_s-${decision}`));
    expect(recovered).toMatchObject({ reason: 'payment_recovered' });
    expect(await drop(`s-${decision}`)).toMatchObject({ status: expected });
  }, 60_000);

  it.each(['recovery', 'decision'])('B-661-9: "Unassign drops" racing the recovery (%s holds the drop first) leaves the drop canceled', async (holder) => {
    const id = `race-${holder}`;
    await failedThenDecided(id);
    const [held, release] = [deferred(), deferred()];
    const success = ev('payment_intent.succeeded', `pi_${id}`);
    const unassign = () => decisions.decide(COACH, `re_${id}`, 'unassign_drops');
    let first: Promise<unknown>;
    if (holder === 'recovery') {
      const pre = await handler.prefetchForOuterTx(success);
      first = inTx(async (tx) => {
        await handler.handle(success, tx, pre);
        held.open();
        await release.opened;
      });
    } else {
      const cancel = fanout.cancelPendingForPurchase.bind(fanout);
      jest.spyOn(fanout, 'cancelPendingForPurchase').mockImplementationOnce(async (...args) => {
        const count = await cancel(...args);
        held.open();
        await release.opened;
        return count;
      });
      first = unassign();
    }
    await held.opened;
    const second = holder === 'recovery' ? unassign() : deliver(success);
    const waited = await lockWaiterSeen();
    release.open();
    await Promise.all([first, second]);
    expect(await drop(id)).toMatchObject({ failure_reason: 'canceled:partial_refund_decision' });
    expect(waited).toBe(true);
  }, 60_000);

  // B-661-3 round 7 (Sol, AUD-SOL-661R6B-117): the activated owner of a PaymentIntent is
  // selected by the query itself, so no number of never-activated purchases that declines
  // adopted onto the same PaymentIntent can push it out of the read. The adopted purchases
  // are real native reservations (CheckoutService, provider replies held) adopted by real
  // decline deliveries in concurrent, held transactions; unordered reads use legalOrder.
  describe('B-661-3 round 7: the owner query is complete at any number of adopted purchases', () => {
    let ordered: CheckoutWebhookHandlerService;
    let checkout: CheckoutService;
    let replies = deferred();
    let reached = deferred();
    const splits = { onChargeSucceeded: jest.fn() };
    const deliverOrdered = async (e: Ev) => {
      const pre = await ordered.prefetchForOuterTx(e);
      return inTx((tx) => ordered.handle(e, legalOrder(tx), pre));
    };
    beforeAll(async () => {
      await prisma.coachPackage.update({ where: { id: PKG }, data: { published_at: new Date() } });
      await prisma.user.update({ where: { id: CLIENT }, data: { coach_id: COACH } });
      await prisma.connectAccount.create({
        data: { coach_user_id: COACH, stripe_account_id: 'acct_l661', charges_enabled: true },
      });
      await prisma.connectCustomer.create({
        data: { client_user_id: CLIENT, stripe_customer_id: 'cus_l661' },
      });
      jest.spyOn(stripe, 'createEphemeralKey').mockResolvedValue({ secret: 'ek_l661_secret' });
      jest.spyOn(stripe, 'createPaymentIntent').mockImplementation(async ({ idempotencyKey }) => {
        reached.open();
        await replies.opened;
        const own = `pi_own_${idempotencyKey.slice(-6)}`;
        return { id: own, client_secret: `${own}_secret_l661` };
      });
      ordered = new CheckoutWebhookHandlerService(
        legalOrder(prisma),
        stripe,
        wire(splits),
        undefined,
        undefined,
        fanout,
      );
      type Deps = ConstructorParameters<typeof CheckoutService>;
      checkout = new CheckoutService(
        prisma,
        stripe,
        wire<Deps[2]>({
          getById: (id: string) => prisma.coachPackage.findUnique({ where: { id } }),
        }),
        wire<Deps[3]>({ ready: true, reason: null }),
        wire<Deps[4]>({
          planFor: async () => ({ application_fee_cents: 100, head_coach_split_cents: 0 }),
        }),
        wire<Deps[5]>({ evaluate: async () => ({ ok: true }) }),
      );
    });
    afterAll(() => jest.restoreAllMocks());

    it.each([9, 10, 12])(
      'the activated owner recovers behind %i never-activated purchases adopted onto its PaymentIntent; they gain nothing and nothing runs twice',
      async (count) => {
        const [pi, owner] = [`pi_list_${count}`, `owner-list-${count}`];
        await prisma.clientPurchase.create({
          data: {
            id: owner,
            client_user_id: CLIENT,
            coach_user_id: COACH,
            package_id: PKG,
            amount_cents: 5000,
            stripe_checkout_session_id: `cs_${owner}`,
            idempotency_key: owner,
            created_at: new Date(Date.now() - 60_000),
          },
        });
        [replies, reached] = [deferred(), deferred()];
        const release = deferred();
        const [adoptions, creations, adopted]: [Promise<void>[], Promise<unknown>[], string[]] = [
          [],
          [],
          [],
        ];
        try {
          for (let i = 0; i < count; i += 1) {
            await sleep(5); // distinct created_at: each decline adopts the newest reservation
            reached = deferred();
            const key = `00000000-0000-4000-8000-${String(count * 100 + i).padStart(12, '0')}`;
            const creation = checkout.createPaymentIntentForClient(CLIENT, {
              package_id: PKG,
              idempotency_key: key,
            });
            creations.push(creation);
            await Promise.race([reached.opened, creation]);
            const reserved = await prisma.clientPurchase.findUniqueOrThrow({
              where: { idempotency_key: `pi-${CLIENT}-${key}` },
            });
            expect(reserved).toMatchObject({ status: 'pending', stripe_payment_intent_id: null });
            adopted.push(reserved.id);
            const held = deferred();
            const decline = ev('payment_intent.payment_failed', pi, {
              metadata: { tgp_package_id: PKG, tgp_client_user_id: CLIENT },
            });
            const pre = await ordered.prefetchForOuterTx(decline);
            const adoption = inTx(async (tx) => {
              expect(await ordered.handle(decline, legalOrder(tx), pre)).toEqual({
                claimed: true,
                purchase_id: reserved.id,
              });
              held.open();
              await release.opened;
            });
            adoptions.push(adoption);
            await Promise.race([held.opened, adoption]);
          }
          release.open();
          await Promise.all(adoptions);
          const completed = ev('checkout.session.completed', `cs_${owner}`, {
            payment_intent: pi,
            mode: 'payment',
          });
          expect(await deliverOrdered(completed)).toMatchObject({
            claimed: true,
            purchase_id: owner,
            deferredSplit: expect.anything(),
          });
          await prisma.scheduledDrop.create({
            data: {
              id: `d-${owner}`,
              client_purchase_id: owner,
              content_id: owner,
              asset_type: 'workout',
              asset_id: 'a1',
              cadence_kind: 'offset_days',
              cadence_payload: {},
              fire_at: new Date(Date.now() + 86_400_000),
            },
          });
          stripe.status = 'requires_payment_method';
          expect(await deliverOrdered(ev('payment_intent.payment_failed', pi))).toEqual({
            claimed: true,
            purchase_id: owner,
          });
          expect(await drop(owner)).toMatchObject({
            status: 'canceled',
            failure_reason: 'canceled:payment_failed',
          });
          // The boundary: count + 1 failed purchases share the PaymentIntent and exactly one was
          // activated; an unfiltered ten-row read newest first misses the owner from ten on.
          const failed = { stripe_payment_intent_id: pi, status: 'payment_failed' };
          expect(await prisma.clientPurchase.count({ where: failed })).toBe(count + 1);
          expect(
            await prisma.purchaseFanout.count({
              where: { purchase: { stripe_payment_intent_id: pi } },
            }),
          ).toBe(1);
          const unfiltered = await legalOrder(prisma).clientPurchase.findMany({
            where: failed,
            take: 10,
          });
          expect(unfiltered.some((p) => p.id === owner)).toBe(count < 10);

          stripe.status = 'succeeded';
          const success = ev('payment_intent.succeeded', pi);
          expect(await deliverOrdered(success)).toEqual({
            claimed: true,
            purchase_id: owner,
            reason: 'payment_recovered',
          });
          expect(await row(owner)).toMatchObject({
            status: 'paid',
            entitlement_active: true,
            last_error: null,
          });
          expect(await drop(owner)).toMatchObject({ status: 'pending', failure_reason: null });
          const others = await prisma.clientPurchase.findMany({ where: { id: { in: adopted } } });
          expect(others.map((p) => [p.status, p.entitlement_active])).toEqual(
            adopted.map(() => ['payment_failed', false]),
          );
          expect(
            await prisma.purchaseFanout.count({
              where: { purchase_id: { in: [owner, ...adopted] } },
            }),
          ).toBe(1);
        } finally {
          release.open();
          replies.open();
          await Promise.allSettled([...adoptions, ...creations]);
        }
        // The native replies land afterwards: each adopted purchase takes its own PaymentIntent,
        // stays unentitled, and a redelivered success finds nothing left to do.
        const settled = await prisma.clientPurchase.findMany({ where: { id: { in: adopted } } });
        expect(
          settled.every(
            (p) => p.stripe_payment_intent_id?.startsWith('pi_own_') && !p.entitlement_active,
          ),
        ).toBe(true);
        const again = await deliverOrdered(ev('payment_intent.succeeded', pi));
        expect(again).toEqual({ claimed: false, reason: 'no_matching_purchase' });
        expect(await row(owner)).toMatchObject({ status: 'paid', entitlement_active: true });
        expect(await prisma.purchaseFanout.count({ where: { purchase_id: owner } })).toBe(1);
      },
      90_000,
    );
  });
});
