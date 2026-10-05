// Independent Sol agent 120 probe on exact #661/#702 composed source.
// Only the CI runner's disposable PostgreSQL; no application/provider calls.
import type { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import {
  CheckoutWebhookHandlerService,
} from '../src/checkout/checkout-webhook-handler.service';
import {
  classifyPaymentReplay,
  isRecurringPackage,
} from '../src/checkout/checkout.service';
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
const [CLIENT, COACH, PKG] = ['sol120-client', 'sol120-coach', 'sol120-pkg'];
type Event = { id: string; type: string; data: { object: Record<string, unknown> } };
class StripeStub extends StripeConnectApiService {
  sub: StripeSubscriptionCheckoutObject = { id: 'sub_unused', status: 'active' };
  retrieveSubscription = jest.fn(async () => this.sub);
  retrieveSubscriptionForCheckout = jest.fn(async () => this.sub);
}

live('AUD-SOL-661D-120 conflict composition: credential lifecycle and recurring ownership', () => {
  let prisma: PrismaService;
  let handler: CheckoutWebhookHandlerService;
  const stripe = new StripeStub();
  let seq = 0;
  const event = (type: string, object: Record<string, unknown>): Event => ({
    id: `evt_sol120_${seq += 1}`, type, data: { object },
  });
  const transaction = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(fn, { timeout: 30_000 });
  async function deliver(e: Event) {
    const pre = await handler.prefetchForOuterTx(e);
    return transaction((tx) => handler.handle(e, tx, pre));
  }
  async function seed(id: string, options: Prisma.ClientPurchaseUncheckedCreateInput = {
    client_user_id: CLIENT, coach_user_id: COACH, package_id: PKG,
    amount_cents: 4900, stripe_checkout_session_id: `sub_${id}`, idempotency_key: id,
  }) {
    return prisma.clientPurchase.create({ data: {
      ...options, id,
      client_user_id: CLIENT, coach_user_id: COACH, package_id: PKG,
      amount_cents: 4900, idempotency_key: id,
      stripe_checkout_session_id: `sub_${id}`, stripe_subscription_id: `sub_${id}`,
      stripe_payment_intent_id: `pi_${id}`, stripe_customer_id: 'cus_sol120',
      billing_type: 'recurring', status: options.status ?? 'pending',
      entitlement_active: options.entitlement_active ?? false,
      stripe_client_secret: options.stripe_client_secret ?? `pi_${id}_secret_canary`,
      stripe_ephemeral_key: 'ek_test_sol120_canary',
    } });
  }
  const persisted = (id: string) => prisma.clientPurchase.findUniqueOrThrow({ where: { id } });
  function snapshot(id: string, trial = false): StripeSubscriptionCheckoutObject {
    return {
      id: `sub_${id}`, status: trial ? 'trialing' : 'active',
      customer: 'cus_sol120', default_payment_method: 'pm_saved',
      cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 86_400,
      ...(trial ? { trial_start: Math.floor(Date.now() / 1000) } : {}),
    };
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
      id: PKG, coach_id: COACH, name: 'Composition fixture', amount_cents: 4900, billing_type: 'recurring',
    } });
    const fanout = new PurchaseFanoutService(undefined, undefined, undefined, prisma);
    handler = new CheckoutWebhookHandlerService(prisma, stripe, undefined, undefined, undefined, fanout);
  }, 180_000);
  afterAll(async () => { await prisma?.$disconnect(); });

  it.each(['invoice.paid', 'customer.subscription.updated'])(
    '%s grants the paid plan and atomically erases both consumed sheet credentials',
    async (type) => {
      const id = `paid-${type.replaceAll('.', '-')}`;
      await seed(id);
      stripe.sub = snapshot(id);
      const e = type === 'invoice.paid'
        ? event(type, { id: `in_${id}`, subscription: `sub_${id}`, amount_paid: 4900, currency: 'usd' })
        : event(type, stripe.sub);
      expect((await deliver(e)).claimed).toBe(true);
      expect(await persisted(id)).toMatchObject({ status: 'active', entitlement_active: true });
      expect(await prisma.purchaseFanout.count({ where: { purchase_id: id } })).toBe(1);
      expect(await persisted(id)).toMatchObject({ stripe_client_secret: null, stripe_ephemeral_key: null });
    },
  );

  it.each(['invoice.paid', 'customer.subscription.updated'])(
    '%s starts the card-confirmed trial and erases the spent SetupIntent credentials',
    async (type) => {
      const id = `trial-${type.replaceAll('.', '-')}`;
      await seed(id, {
        client_user_id: CLIENT, coach_user_id: COACH, package_id: PKG, amount_cents: 4900,
        stripe_checkout_session_id: `sub_${id}`, idempotency_key: id,
        trial_days: 7, stripe_client_secret: `seti_${id}_secret_canary`,
      });
      stripe.sub = snapshot(id, true);
      const e = type === 'invoice.paid'
        ? event(type, { id: `in_${id}`, subscription: `sub_${id}`, amount_paid: 0, currency: 'usd' })
        : event(type, stripe.sub);
      expect((await deliver(e)).claimed).toBe(true);
      expect(await persisted(id)).toMatchObject({ status: 'trialing', entitlement_active: true });
      expect((await persisted(id)).trial_started_at).toBeInstanceOf(Date);
      expect(await persisted(id)).toMatchObject({ stripe_client_secret: null, stripe_ephemeral_key: null });
    },
  );

  it.each(['pending', 'active'])(
    'subscription deletion of a %s attempt preserves expiration/churn semantics and erases credentials',
    async (status) => {
      const id = `end-${status}`;
      await seed(id, {
        client_user_id: CLIENT, coach_user_id: COACH, package_id: PKG, amount_cents: 4900,
        stripe_checkout_session_id: `sub_${id}`, idempotency_key: id,
        status, entitlement_active: status === 'active',
      });
      await deliver(event('customer.subscription.deleted', { id: `sub_${id}` }));
      expect(await persisted(id)).toMatchObject({
        status: status === 'pending' ? 'expired' : 'canceled', entitlement_active: false,
        stripe_client_secret: null, stripe_ephemeral_key: null,
      });
    },
  );

  it.each(['invoice.paid', 'customer.subscription.updated'])(
    '%s keeps the payable SetupIntent while a trial card has not been confirmed',
    async (type) => {
      const id = `unconfirmed-${type.replaceAll('.', '-')}`;
      const secret = `seti_${id}_secret_canary`;
      await seed(id, {
        client_user_id: CLIENT, coach_user_id: COACH, package_id: PKG, amount_cents: 4900,
        stripe_checkout_session_id: `sub_${id}`, idempotency_key: id,
        trial_days: 7, stripe_client_secret: secret,
      });
      for (const defaultCard of [null, 'pm_unconfirmed']) {
        stripe.sub = {
          ...snapshot(id, true), default_payment_method: defaultCard, cancel_at_period_end: true,
        };
        const e = type === 'invoice.paid'
          ? event(type, { id: `in_${id}`, subscription: `sub_${id}`, amount_paid: 0, currency: 'usd' })
          : event(type, stripe.sub);
        await deliver(e);
        expect(await persisted(id)).toMatchObject({
          status: 'trialing', entitlement_active: false, trial_started_at: null,
          stripe_client_secret: secret, stripe_ephemeral_key: 'ek_test_sol120_canary',
        });
        expect(await prisma.purchaseFanout.count({ where: { purchase_id: id } })).toBe(0);
      }
    },
  );

  it('first-invoice PI success/decline stay invoice-owned and never recover a recurring fanout as one-time', async () => {
    const id = 'invoice-owned';
    await seed(id);
    const success = await transaction((tx) => handler.handle(event('payment_intent.succeeded', { id: `pi_${id}` }), tx));
    expect(success).toMatchObject({ reason: 'subscription_invoice_owned_by_invoice_paid' });
    expect(success.deferredSplit).toBeUndefined();
    expect(await persisted(id)).toMatchObject({ status: 'pending', entitlement_active: false });
    const failed = await transaction((tx) => handler.handle(event('payment_intent.payment_failed', {
      id: `pi_${id}`, last_payment_error: { message: 'card_declined' },
    }), tx));
    expect(failed).toMatchObject({ reason: 'subscription_invoice_owned_by_invoice_events' });
    expect(await persisted(id)).toMatchObject({
      status: 'pending', entitlement_active: false, last_error: 'card_declined',
      stripe_client_secret: `pi_${id}_secret_canary`,
    });
  });

  it('replay reply codes survive next to the recurring guard without returning credentials', () => {
    for (const [status, code] of [
      ['paid', 'PAYMENT_ALREADY_COMPLETE'],
      ['refunded', 'PAYMENT_REFUNDED_OR_IN_REVIEW'],
      ['disputed', 'PAYMENT_REFUNDED_OR_IN_REVIEW'],
      ['expired', 'PAYMENT_CHECKOUT_CLOSED'],
    ]) {
      const reply = classifyPaymentReplay({
        status, stripe_client_secret: 'pi_complete_secret_canary',
        stripe_ephemeral_key: 'ek_test_canary', stripe_customer_id: 'cus_sol120',
      });
      expect(reply.kind).toBe('finished');
      if (reply.kind !== 'finished') throw new Error('unexpected credential resume');
      expect(reply.error).toBeInstanceOf(ConflictException);
      expect(reply.error.getResponse()).toMatchObject({ error: code });
      expect(JSON.stringify(reply.error.getResponse())).not.toContain('secret_canary');
    }
    expect(isRecurringPackage({ billing_type: 'one_time', recurring_amount_cents: 4900, recurring_interval: 'month' })).toBe(true);
    expect(isRecurringPackage({ billing_type: 'one_time', recurring_amount_cents: 0, recurring_interval: 'month' })).toBe(false);
  });
});
