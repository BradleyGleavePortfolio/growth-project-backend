// Independent Sol agent 120 round-9 boundary probe. Disposable CI PostgreSQL only.
import type { Prisma } from '@prisma/client';
import { clearSpentPaymentCredentials } from '../scripts/clear-spent-payment-credentials';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import {
  StripeConnectApiService,
  type StripeSubscriptionCheckoutObject,
} from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { PrismaService } from '../src/prisma.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const url = process.env.MWB3_TEST_DATABASE_URL || '';
const live = url ? describe : describe.skip;
class StripeStub extends StripeConnectApiService {
  sub: StripeSubscriptionCheckoutObject = { id: 'sub_unused', status: 'active' };
  retrieveSubscription = jest.fn(async () => this.sub);
  retrieveSubscriptionForCheckout = jest.fn(async () => this.sub);
}
type Event = { id: string; type: string; data: { object: Record<string, unknown> } };
live('AUD-SOL-661E-120 atomic grant erase and cleanup race', () => {
  let prisma: PrismaService;
  let handler: CheckoutWebhookHandlerService;
  let fanout: PurchaseFanoutService;
  const stripe = new StripeStub();
  let seq = 0;
  const [CLIENT, COACH, PKG] = ['sol120e-client', 'sol120e-coach', 'sol120e-pkg'];
  const EK = 'ek_test_sol120e_canary';
  const seed = (id: string, over: Partial<Prisma.ClientPurchaseUncheckedCreateInput> = {}) =>
    prisma.clientPurchase.create({ data: {
      id, client_user_id: CLIENT, coach_user_id: COACH, package_id: PKG,
      amount_cents: 4900, billing_type: 'recurring', idempotency_key: id,
      stripe_checkout_session_id: `sub_${id}`, stripe_subscription_id: `sub_${id}`,
      stripe_payment_intent_id: `pi_${id}`, stripe_customer_id: 'cus_sol120e',
      stripe_client_secret: `pi_${id}_secret_canary`, stripe_ephemeral_key: EK, ...over,
    } });
  const persisted = (id: string) => prisma.clientPurchase.findUniqueOrThrow({ where: { id } });
  const snapshot = (id: string): StripeSubscriptionCheckoutObject => ({
    id: `sub_${id}`, status: 'active', customer: 'cus_sol120e',
    default_payment_method: 'pm_saved', cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 86400,
  });
  const event = (type: string, id: string): Event => ({
    id: `evt_sol120e_${seq += 1}`, type,
    data: { object: type === 'invoice.paid'
      ? { id: `in_${id}`, subscription: `sub_${id}`, amount_paid: 4900, currency: 'usd' }
      : { ...stripe.sub } },
  });
  async function deliver(e: Event) {
    const pre = await handler.prefetchForOuterTx(e);
    return prisma.$transaction((tx) => handler.handle(e, tx, pre), { timeout: 30000 });
  }
  beforeAll(async () => {
    if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('CI-only disposable fixture');
    prisma = new PrismaService({ datasources: { db: { url } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    for (const id of [CLIENT, COACH]) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: id } });
    }
    await prisma.coachPackage.create({ data: {
      id: PKG, coach_id: COACH, name: 'Round 9 fixture', amount_cents: 4900, billing_type: 'recurring',
    } });
    fanout = new PurchaseFanoutService(undefined, undefined, undefined, prisma);
    handler = new CheckoutWebhookHandlerService(prisma, stripe, undefined, undefined, undefined, fanout);
  }, 180000);
  afterAll(async () => { await prisma?.$disconnect(); });
  afterEach(() => jest.restoreAllMocks());

  it.each(['invoice.paid', 'customer.subscription.updated'])(
    '%s fanout failure rolls back access and both erasures; redelivery then commits once',
    async (type) => {
      const id = `rollback-${type.replaceAll('.', '-')}`;
      await seed(id);
      stripe.sub = snapshot(id);
      jest.spyOn(fanout, 'onPurchaseEntitled').mockRejectedValueOnce(new Error('probe_fanout_failed'));
      const e = event(type, id);
      await expect(deliver(e)).rejects.toThrow('probe_fanout_failed');
      expect(await persisted(id)).toMatchObject({
        status: 'pending', entitlement_active: false,
        stripe_client_secret: `pi_${id}_secret_canary`, stripe_ephemeral_key: EK,
      });
      expect(await prisma.purchaseFanout.count({ where: { purchase_id: id } })).toBe(0);
      await deliver(e);
      expect(await persisted(id)).toMatchObject({
        status: 'active', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null,
      });
      expect(await prisma.purchaseFanout.count({ where: { purchase_id: id } })).toBe(1);
    },
  );

  it('invoice first then subscription update and their replays cannot restore credentials or fan out twice', async () => {
    const id = 'invoice-first';
    await seed(id);
    stripe.sub = snapshot(id);
    const invoice = event('invoice.paid', id);
    const subscription = event('customer.subscription.updated', id);
    for (const e of [invoice, subscription, invoice, subscription]) await deliver(e);
    expect(await persisted(id)).toMatchObject({
      status: 'active', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null,
    });
    expect(await prisma.purchaseFanout.count({ where: { purchase_id: id } })).toBe(1);
  });

  it('two event owners with prefetched same revision serialize to one grant and one fanout', async () => {
    const id = 'two-workers';
    await seed(id);
    stripe.sub = snapshot(id);
    const events = [event('invoice.paid', id), event('customer.subscription.updated', id)];
    const pre = await Promise.all(events.map((e) => handler.prefetchForOuterTx(e)));
    await Promise.all(events.map((e, i) =>
      prisma.$transaction((tx) => handler.handle(e, tx, pre[i]), { timeout: 30000 })));
    expect(await persisted(id)).toMatchObject({
      status: 'active', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null,
    });
    expect(await prisma.purchaseFanout.count({ where: { purchase_id: id } })).toBe(1);
  }, 60000);

  it.each(['one_time', 'recurring'])(
    'cleanup rechecks after %s selected row becomes payable; no state/credential clobber',
    async (billing) => {
      const id = `cleanup-race-${billing}`;
      await seed(id, {
        status: 'active', entitlement_active: true, billing_type: billing,
        stripe_subscription_id: billing === 'recurring' ? `sub_${id}` : null,
      });
      let transitioned = false;
      const clientPurchase = new Proxy(prisma.clientPurchase, {
        get(target, key, receiver) {
          if (key !== 'findMany') return Reflect.get(target, key, receiver);
          return async (args: Prisma.ClientPurchaseFindManyArgs) => {
            const result = await target.findMany(args);
            if (!transitioned) {
              transitioned = true;
              expect(result.some((row) => row.id === id)).toBe(true);
              await target.update({ where: { id }, data: {
                status: billing === 'recurring' ? 'trialing' : 'payment_failed',
                entitlement_active: false, trial_started_at: null,
                stripe_client_secret: `retry_${id}_secret_canary`, stripe_ephemeral_key: EK,
              } });
            }
            return result;
          };
        },
      });
      await clearSpentPaymentCredentials({ clientPurchase }, { apply: true, batchSize: 1 });
      expect(await persisted(id)).toMatchObject({
        status: billing === 'recurring' ? 'trialing' : 'payment_failed', entitlement_active: false,
        trial_started_at: null, stripe_client_secret: `retry_${id}_secret_canary`, stripe_ephemeral_key: EK,
      });
    },
  );
});
