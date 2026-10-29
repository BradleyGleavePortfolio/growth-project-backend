/**
 * FIRST-PAY-WEB (agent 182; b#1169 AUDIT 6486460217): a sale through the web
 * pay page (guest checkout) is the coach's first payment, live on the replayed
 * migration chain.
 *
 * The real BillingService -> GuestCheckoutService -> CoachFirstPaymentService ->
 * FirstPaymentEmitter -> NotificationsService -> PushDeliveryService run on the
 * superuser connection, as the API does; Supabase, Stripe, the welcome email
 * and the Expo client are doubles. The in-app sale is the in-app paths' step,
 * run by hand: one transaction that writes the ClientPurchase row, runs
 * tryEmitFirstPayment (what CheckoutWebhookHandlerService.maybeEmitFirstPayment
 * calls), then writes again.
 *   W  a guest pays on the web, later a client of the same coach pays in the app:
 *      exactly one first-payment notice, for the web sale.
 *   R  a replayed web payment (redelivery, the reconciler, the lost-webhook
 *      sweep's direct call) does not send it twice.
 *   F  a notice that fails on the web path (a real SQL error at the push
 *      outbox) does not undo the web payment; the next sale sends it once.
 *   Z  a first web purchase of 0 follows the in-app rule (owner call 1, b#1169
 *      AUDIT 6486460217: the in-app one-time paths pass the row's amount with
 *      no amount check; this names that rule, it does not decide it).
 *   O  flag off: the web sale converts and sends nothing, as in the app.
 * Before the fix W, R, F and Z failed: the web path never claimed the notice,
 * so the coach's next in-app sale was announced as the first.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BillingService } from '../../src/billing/billing.service';
import { PrismaService } from '../../src/prisma.service';
import { CoachFirstPaymentService } from '../../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../../src/notifications/emitters/first-payment.emitter';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { ExpoPushClient, PushDeliveryService } from '../../src/notifications/push/push-delivery.service';
import { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { PurchaseFanoutService } from '../../src/packages/purchase-fanout.service';
import { GuestCheckoutReconciliationService } from '../../src/storefront/guest-checkout-reconciliation.service';
import { GUEST_CHECKOUT_METADATA_KEY, GuestCheckoutService } from '../../src/storefront/guest-checkout.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { stub } from '../utils/trial-fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('first-pay-web-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const FLAG = 'FEATURE_ROMAN_FIRST_PAYMENT';
const FIRST_PAYMENT = NotificationKind.FIRST_PAYMENT;
const mail = (local: string) => `${local}\u0040example.com`;

(DB_URL ? describe : describe.skip)('FIRST-PAY-WEB: a web pay page sale is the coach\'s first payment', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL.replace('connection_limit=1', 'connection_limit=5') } } });
  const run = randomUUID().slice(0, 8);
  const coaches = ['K', 'M', 'Z', 'O'] as const;
  type Coach = (typeof coaches)[number];
  const coachId = (c: Coach) => `fpw-${c}-${run}`;
  const pkgId = (c: Coach) => `fpw-pkg-${c}-${run}`;
  let sbSeq = 0;

  const supabase = {
    getClient: () => ({
      auth: {
        admin: {
          createUser: async () => ({ data: { user: { id: `sb-fpw-${run}-${++sbSeq}` } }, error: null }),
          generateLink: async () => ({ data: { properties: { action_link: 'https://auth.example.com/invite' } }, error: null }),
          listUsers: async () => ({ data: { users: [] }, error: null }),
        },
      },
    }),
  };
  const stripe = {
    retrievePaymentIntent: async (id: string) => ({ id, latest_charge: `ch_${id}` }),
    retrieveCharge: async (id: string) => ({ id, receipt_url: `https://pay.stripe.com/receipts/${id}` }),
    retrieveSubscription: async (id: string) => ({ id, status: 'active' }),
  };
  const send = jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` })));
  const delivery = new PushDeliveryService(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(prisma),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
    undefined,
    undefined,
    delivery,
  );
  const firstPayment = new CoachFirstPaymentService(new FirstPaymentEmitter(notifications));
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
    firstPayment,
  ]);
  Reflect.set(guest, 'sendWelcomeEmail', async () => undefined);
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

  /** A web pay page sale for coach `c`: the checkout row, then Stripe's payment_intent.succeeded. */
  const webSale = async (c: Coach, tag: string) => {
    const pi = `pi_fpw_${run}_${tag}`;
    await prisma.guestCheckout.create({
      data: {
        idempotency_key: `idem-${pi}`,
        guest_email: mail(`fpw-${pi}`),
        guest_name: 'Guest Buyer',
        package_id: pkgId(c),
        stripe_payment_intent_id: pi,
        status: 'pending',
        expires_at: new Date(Date.now() + 60 * 60_000),
        created_at: new Date(Date.now() - 5 * 60_000),
      },
    });
    const event = {
      id: `evt_fpw_${run}_${tag}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: pi,
          metadata: { [GUEST_CHECKOUT_METADATA_KEY]: `idem-${pi}` },
          latest_charge: `ch_${pi}`,
          charges: { data: [{ id: `ch_${pi}`, receipt_url: `https://pay.stripe.com/receipts/ch_${pi}` }] },
        },
      },
    };
    await expect(billing.handleEvent(event)).resolves.toEqual({ processed: true });
    const row = await prisma.guestCheckout.findUniqueOrThrow({ where: { stripe_payment_intent_id: pi } });
    expect(row.status).toBe('converted');
    const purchase = await prisma.clientPurchase.findFirstOrThrow({ where: { stripe_payment_intent_id: pi } });
    return { pi, event, buyer: purchase.client_user_id, purchaseId: purchase.id };
  };
  /** An in-app sale for coach `c` by an existing client: the in-app paths' first-payment step. */
  const inAppSale = async (c: Coach, clientId: string, amount: number) => {
    const saleId = randomUUID();
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.clientPurchase.create({
        data: {
          id: saleId,
          client_user_id: clientId,
          coach_user_id: coachId(c),
          package_id: pkgId(c),
          amount_cents: amount,
          stripe_checkout_session_id: `cs_fpw_${saleId}`,
          idempotency_key: `fpw-${saleId}`,
        },
      });
      await firstPayment.tryEmitFirstPayment(tx, { coachId: coachId(c), amount, currency: 'usd', clientId });
      await tx.clientPurchase.update({ where: { id: saleId }, data: { updated_at: new Date() } });
    });
    return saleId;
  };
  const counts = async (c: Coach) => {
    const [ledger, inbox, push, sales] = await Promise.all([
      prisma.coachFirstPaymentNotification.findMany({ where: { coachId: coachId(c) } }),
      prisma.notification.findMany({ where: { user_id: coachId(c), kind: FIRST_PAYMENT }, orderBy: { channel: 'asc' } }),
      prisma.pushOutbox.findMany({ where: { user_id: coachId(c), kind: FIRST_PAYMENT } }),
      prisma.clientPurchase.count({ where: { coach_user_id: coachId(c) } }),
    ]);
    return { ledger, inbox, push, sales };
  };
  const inAppClient = async (c: Coach) => {
    const id = `fpw-client-${c}-${run}`;
    await prisma.user.create({ data: { id, supabase_id: id, email: mail(id), name: 'In-app client', role: 'student', coach_id: coachId(c) } });
    return id;
  };

  const flagBefore = process.env[FLAG];
  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    process.env[FLAG] = 'true';
    for (const c of coaches) {
      await prisma.user.create({ data: { id: coachId(c), supabase_id: coachId(c), email: mail(coachId(c)), name: 'Live coach', role: 'coach' } });
      await prisma.coachPackage.create({
        data: { id: pkgId(c), coach_id: coachId(c), name: 'Getting started', amount_cents: c === 'Z' ? 0 : 4900 },
      });
      await prisma.connectAccount.create({ data: { coach_user_id: coachId(c), stripe_account_id: `acct_fpw_${c}_${run}` } });
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (flagBefore === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flagBefore;
    await prisma.$disconnect();
  });

  it('W (failed before): web sale first, then an in-app sale: one notice, for the web sale; none for coach M or the buyer', async () => {
    const web = await webSale('K', 'w');
    let c = await counts('K');
    expect(c.sales).toBe(1);
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0]).toMatchObject({ coachId: coachId('K'), clientId: web.buyer, amount: 4900, currency: 'usd' });
    expect(c.inbox.map((n) => n.channel)).toEqual(['inapp', 'push']);
    expect(c.inbox.every((n) => n.deep_link === `tgp://coach/clients/${web.buyer}`)).toBe(true);
    expect(c.push).toHaveLength(1);
    // C1 (LO-1181): K's web sale writes nothing for another coach or the buyer.
    for (const other of [coachId('M'), web.buyer]) {
      expect(await prisma.coachFirstPaymentNotification.count({ where: { coachId: other } })).toBe(0);
      expect(await prisma.notification.count({ where: { user_id: other, kind: FIRST_PAYMENT } })).toBe(0);
      expect(await prisma.pushOutbox.count({ where: { user_id: other, kind: FIRST_PAYMENT } })).toBe(0);
    }

    const client = await inAppClient('K');
    await inAppSale('K', client, 12000);
    c = await counts('K');
    expect(c.sales).toBe(2);
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0].clientId).toBe(web.buyer);
    expect(c.inbox).toHaveLength(2);
    expect(c.push).toHaveLength(1);
  });

  it('R (failed before): a replayed web payment does not send it twice', async () => {
    const web = await webSale('K', 'r');
    await expect(billing.handleEvent(web.event)).resolves.toEqual({ processed: false, alreadyProcessed: true });
    await guest.handlePaymentSucceeded(web.pi); // the lost-webhook sweep's direct call
    await reconciler.run();
    const c = await counts('K');
    expect(c.sales).toBe(3);
    expect(c.ledger).toHaveLength(1);
    expect(c.inbox).toHaveLength(2);
    expect(c.push).toHaveLength(1);
  });

  it('F (failed before): a failed notice on the web path keeps the web payment; the next sale sends it once', async () => {
    // A real Postgres error inside the conversion transaction at the push
    // outbox step (NOT NULL violation). The first-payment step rolls back to
    // its savepoint; the purchase, the conversion claim and the fan-out commit.
    const enqueue = jest.spyOn(delivery, 'enqueue').mockImplementationOnce(async (_push, tx) => {
      if (!tx) throw new Error('first-payment push must ride the conversion transaction');
      await tx.$executeRawUnsafe('INSERT INTO "PushOutbox" ("id") VALUES (NULL)');
      throw new Error('unreachable');
    });
    const web = await webSale('M', 'f');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await prisma.clientPurchase.count({ where: { id: web.purchaseId } })).toBe(1);
    expect(await prisma.purchaseFanout.count({ where: { purchase_id: web.purchaseId } })).toBe(1);
    let c = await counts('M');
    expect(c).toMatchObject({ sales: 1, ledger: [], inbox: [], push: [] });

    const second = await webSale('M', 'f2');
    c = await counts('M');
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(c.sales).toBe(2);
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0].clientId).toBe(second.buyer);
    expect(c.push).toHaveLength(1);
    enqueue.mockRestore();
  });

  it('Z (failed before): a first web purchase of 0 follows the in-app rule (owner call 1)', async () => {
    const web = await webSale('Z', 'z');
    const c = await counts('Z');
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0]).toMatchObject({ clientId: web.buyer, amount: 0, currency: 'usd' });
    expect(c.push).toHaveLength(1);
  });

  it('O: flag off, the web sale converts and sends nothing, as in the app', async () => {
    process.env[FLAG] = 'false';
    try {
      await webSale('O', 'o');
      expect(await counts('O')).toMatchObject({ sales: 1, ledger: [], inbox: [], push: [] });
    } finally {
      process.env[FLAG] = 'true';
    }
  });
});
