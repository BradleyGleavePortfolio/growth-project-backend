// #661 settlement on real PostgreSQL (C-661-12: the AUD-OPUS-661R5-117 probe, plus
// B-661-3, B-661-9 and C-661-11 in round 6). Real handler, PurchaseFanoutService,
// PartialRefundDecisionService and Prisma on the full schema: xmin, row locks and
// P2025 are the database's own. Gated on MWB3_TEST_DATABASE_URL (mwb-3-live-tests).
import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
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
    const pool = `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}connection_limit=8`;
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
});
