/**
 * GUEST-OUTER-TX (agent 170): a web (guest) purchase no longer holds the Stripe webhook's database
 * save open across account setup and Stripe, live on the replayed migration chain with the
 * production transaction budget. PrismaService passes no transactionOptions, so the webhook's
 * $transaction runs on Prisma's defaults (timeout 5,000 ms, maxWait 2,000 ms); the first case
 * proves that budget is what this connection enforces. Coach K sells PK (one-time) and PKR
 * (recurring); coach L is the other tenant.
 *   A  Supabase answers in 6 s (past the 5 s budget, inside its own 10 s limit): the first delivery
 *      converts the buyer once; a redelivery changes nothing.
 *   R  a recurring first-invoice payment (no metadata) with the receipt lookup and the subscription
 *      read each answering in 6 s: converts once, receipt kept, purchase active.
 *   C  the process dies right after the webhook commits: the `paid` row stays and the reconciler
 *      converts it exactly once.
 * The real BillingService, GuestCheckoutService, PurchaseFanoutService and
 * GuestCheckoutReconciliationService run on the superuser connection, as the API does, with a
 * 5-connection pool; Supabase, Stripe and the welcome email are doubles that count their calls.
 * Purchase and checkout rows are server-only: the signed-in buyer and both coaches (role
 * `authenticated`, no row-security bypass) read none of them, after the server reads exactly one.
 * Before this fix case A failed: the 6 s account setup ran inside the webhook transaction, which
 * expired at 5 s, so the delivery threw P2028 and Stripe had to retry.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { BillingService } from '../../src/billing/billing.service';
import { PrismaService } from '../../src/prisma.service';
import { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { PurchaseFanoutService } from '../../src/packages/purchase-fanout.service';
import { GuestCheckoutReconciliationService } from '../../src/storefront/guest-checkout-reconciliation.service';
import {
  GUEST_CHECKOUT_METADATA_KEY,
  GuestCheckoutService,
} from '../../src/storefront/guest-checkout.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('guest-outer-tx-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const SLOW_MS = 6_000;
const sleep = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

(DB_URL ? describe : describe.skip)('GUEST-OUTER-TX: web purchase setup runs after the payment save commits', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL.replace('connection_limit=1', 'connection_limit=5') } } });
  const run = randomUUID().slice(0, 8);
  const [K, L, PK, PKR] = ['K', 'L', 'PK', 'PKR'].map((t) => `${t}-${run}`);
  const calls: string[] = [];
  const welcome: string[] = [];
  const slow = { supabase: 0, stripe: 0 };
  let sbSeq = 0;

  const supabase = {
    getClient: () => ({
      auth: {
        admin: {
          createUser: (args: { email: string }) => {
            calls.push('supabase.createUser');
            return sleep(slow.supabase, { data: { user: { id: `sb-${run}-${++sbSeq}`, email: args.email } }, error: null });
          },
          generateLink: () => {
            calls.push('supabase.generateLink');
            return sleep(0, { data: { properties: { action_link: 'https://auth.example.com/invite' } }, error: null });
          },
          listUsers: () => {
            calls.push('supabase.listUsers');
            return sleep(0, { data: { users: [] }, error: null });
          },
        },
      },
    }),
  };
  const stripe = {
    retrievePaymentIntent: (id: string) => {
      calls.push('stripe.retrievePaymentIntent');
      return sleep(slow.stripe, { id, latest_charge: `ch_${id}` });
    },
    retrieveCharge: (id: string) => {
      calls.push('stripe.retrieveCharge');
      return sleep(slow.stripe, { id, receipt_url: `https://pay.stripe.com/receipts/${id}` });
    },
    retrieveSubscription: (id: string) => {
      calls.push('stripe.retrieveSubscription');
      return sleep(slow.stripe, { id, status: 'active' });
    },
  };
  const fanout = new PurchaseFanoutService(new AssignableAssetResolverRegistry([]), undefined, undefined, prisma);
  // Reflect.construct keeps the partial doubles untyped without a cast; the services are the real classes.
  const guest: GuestCheckoutService = Reflect.construct(GuestCheckoutService, [
    prisma,
    stripe,
    supabase,
    { get: () => undefined },
    { createNotification: async () => undefined },
    {},
    {},
    undefined,
    undefined,
    fanout,
    undefined,
  ]);
  Reflect.set(guest, 'sendWelcomeEmail', async (checkout: { id: string }) => {
    welcome.push(checkout.id);
  });
  const billing: BillingService = Reflect.construct(BillingService, [
    prisma,
    { capture: () => undefined, identify: () => undefined },
    { write: async () => undefined },
    undefined,
    undefined,
    undefined,
    guest,
  ]);
  const reconciler = new GuestCheckoutReconciliationService(prisma, guest);

  const seed = (pi: string, extra: Partial<Prisma.GuestCheckoutUncheckedCreateInput> = {}) =>
    prisma.guestCheckout.create({
      data: {
        idempotency_key: `idem-${pi}`,
        guest_email: `gotx-${pi}@example.com`,
        guest_name: 'Guest Buyer',
        package_id: PK,
        stripe_payment_intent_id: pi,
        stripe_customer_id: `cus_${run}`,
        status: 'pending',
        expires_at: new Date(Date.now() + 60 * 60_000),
        ...extra,
      },
    });
  const piEvent = (eventId: string, pi: string, withMetadata = true) => ({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: pi,
        metadata: withMetadata ? { [GUEST_CHECKOUT_METADATA_KEY]: `idem-${pi}` } : {},
        latest_charge: `ch_${pi}`,
      },
    },
  });
  const state = async (pi: string) => {
    const row = await prisma.guestCheckout.findUnique({ where: { stripe_payment_intent_id: pi } });
    return {
      status: row?.status,
      account: row?.created_user_id ? 'created' : null,
      purchases: await prisma.clientPurchase.count({ where: { stripe_payment_intent_id: pi } }),
    };
  };
  /** What `reader` (signed in, row security on) reads of the purchase and checkout rows of `pi`. */
  const readsAs = async (reader: string, role: string, pi: string) => {
    const one = (read: (tx: Prisma.TransactionClient) => Promise<number>) =>
      prisma
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
          await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: reader, role: 'authenticated' }));
          return read(tx);
        })
        .then(
          (n) => n,
          () => 'refused' as const,
        );
    return [
      await one((tx) => tx.clientPurchase.count({ where: { stripe_payment_intent_id: pi } })),
      await one((tx) => tx.guestCheckout.count({ where: { stripe_payment_intent_id: pi } })),
    ].map((r) => (r === 0 || r === 'refused' ? 'none' : r));
  };

  beforeAll(async () => {
    for (const [id, role] of [[K, 'coach'], [L, 'coach']] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `gotx-${id}@example.com`, name: 'Live coach', role } });
    }
    await prisma.coachPackage.create({ data: { id: PK, coach_id: K, name: 'Getting started', amount_cents: 4900 } });
    await prisma.coachPackage.create({ data: { id: PKR, coach_id: K, name: 'Monthly', amount_cents: 9900, billing_type: 'recurring', interval: 'month' } });
    await prisma.connectAccount.create({ data: { coach_user_id: K, stripe_account_id: `acct_${run}` } });
  });
  afterAll(() => prisma.$disconnect());

  it('the webhook transaction runs on the production budget: 5 s, then the save is refused', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await sleep(5_500, null);
        return tx.user.count({ where: { id: K } });
      }),
    ).rejects.toMatchObject({ code: 'P2028' });
  });

  it('A: a 6 s account setup converts the buyer on the first delivery, once; a redelivery changes nothing', async () => {
    const pi = `pi_${run}_a`;
    await seed(pi);
    slow.supabase = SLOW_MS;
    // The event carries its receipt, as a one-time charge does, so no lookup runs before the save.
    const event = piEvent(`evt_${run}_a`, pi);
    const withReceipt = {
      ...event,
      data: { object: { ...event.data.object, charges: { data: [{ id: `ch_${pi}`, receipt_url: `https://pay.stripe.com/receipts/ch_${pi}` }] } } },
    };

    await expect(billing.handleEvent(withReceipt)).resolves.toEqual({ processed: true });

    expect(await state(pi)).toEqual({ status: 'converted', account: 'created', purchases: 1 });
    const purchase = await prisma.clientPurchase.findFirstOrThrow({ where: { stripe_payment_intent_id: pi } });
    expect(purchase).toMatchObject({ coach_user_id: K, package_id: PK, amount_cents: 4900, idempotency_key: `guest-purchase-idem-${pi}`, stripe_destination_account: `acct_${run}` });
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: purchase.client_user_id } });
    expect([buyer.role, buyer.coach_id]).toEqual(['student', K]);
    const dedup = await prisma.stripeProcessedEvent.findUniqueOrThrow({ where: { stripe_event_id: `evt_${run}_a` } });
    expect(dedup.handler_completed_at).toBeInstanceOf(Date);
    expect((await prisma.guestCheckout.findUniqueOrThrow({ where: { stripe_payment_intent_id: pi } })).receipt_url).toBe(`https://pay.stripe.com/receipts/ch_${pi}`);
    expect(welcome).toHaveLength(1);

    await expect(billing.handleEvent(withReceipt)).resolves.toEqual({ processed: false, alreadyProcessed: true });
    expect(await state(pi)).toEqual({ status: 'converted', account: 'created', purchases: 1 });
    expect(welcome).toHaveLength(1);
    expect(calls.filter((c) => c === 'supabase.createUser')).toHaveLength(1);

    // Server-only rows: the server reads one purchase; the buyer and both coaches, signed in, read none.
    for (const [reader, role] of [[purchase.client_user_id, 'student'], [K, 'coach'], [L, 'coach']] as const) {
      expect(await readsAs(reader, role, pi)).toEqual(['none', 'none']);
    }
    slow.supabase = 0;
  });

  it('R: a recurring first-invoice payment with 6 s Stripe replies converts once, receipt kept, purchase active', async () => {
    const pi = `pi_${run}_r`;
    await seed(pi, { package_id: PKR, stripe_subscription_id: `sub_${run}` });
    slow.stripe = SLOW_MS;
    const before = calls.length;

    await expect(billing.handleEvent(piEvent(`evt_${run}_r`, pi, false))).resolves.toEqual({ processed: true });

    expect(await state(pi)).toEqual({ status: 'converted', account: 'created', purchases: 1 });
    expect(calls.slice(before)).toEqual(expect.arrayContaining(['stripe.retrieveCharge', 'stripe.retrieveSubscription']));
    const row = await prisma.guestCheckout.findUniqueOrThrow({ where: { stripe_payment_intent_id: pi } });
    expect(row.receipt_url).toBe(`https://pay.stripe.com/receipts/ch_${pi}`);
    const purchase = await prisma.clientPurchase.findFirstOrThrow({ where: { stripe_payment_intent_id: pi } });
    expect([purchase.status, purchase.entitlement_active, purchase.stripe_subscription_id]).toEqual(['active', true, `sub_${run}`]);
    expect(welcome).toHaveLength(2);
    slow.stripe = 0;
  });

  it('C: a crash after the commit leaves the paid row; the reconciler converts it exactly once', async () => {
    const pi = `pi_${run}_c`;
    // Paid a few minutes after the checkout opened, past the reconciler's 2 min grace.
    await seed(pi, { created_at: new Date(Date.now() - 5 * 60_000) });
    const finish = jest.spyOn(guest, 'finishPaidCheckout').mockImplementationOnce(async () => {
      throw new Error('process exited');
    });

    await expect(billing.handleEvent(piEvent(`evt_${run}_c`, pi))).resolves.toEqual({ processed: true });
    expect(await state(pi)).toEqual({ status: 'paid', account: null, purchases: 0 });
    finish.mockRestore();

    await reconciler.run();
    await reconciler.run();
    expect(await state(pi)).toEqual({ status: 'converted', account: 'created', purchases: 1 });
    expect(welcome).toHaveLength(3);

    // A redelivery and the lost-webhook sweep's direct call change nothing.
    await expect(billing.handleEvent(piEvent(`evt_${run}_c`, pi))).resolves.toEqual({ processed: false, alreadyProcessed: true });
    await guest.handlePaymentSucceeded(pi);
    expect(await state(pi)).toEqual({ status: 'converted', account: 'created', purchases: 1 });
    expect(welcome).toHaveLength(3);
  });
});
