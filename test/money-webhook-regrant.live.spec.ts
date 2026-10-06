// MONEY-WEBHOOK-124 B-WH-1 on real PostgreSQL (mwb-3-live-tests, gated on MWB3_TEST_DATABASE_URL).
// A client's plan was granted once, then locked for an unpaid renewal; the client pays. The
// real BillingService -> CheckoutWebhookHandlerService -> PurchaseFanoutService path must
// give access back on that delivery. Before the fix the repeat grant's coach-alert marker
// INSERT raised a unique violation inside the webhook transaction, PostgreSQL aborted it,
// and every Stripe delivery failed (25P02), so the client paid and stayed locked out.
import { BillingService } from '../src/billing/billing.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { PrismaService } from '../src/prisma.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = DB_URL ? describe : describe.skip;
const [CLIENT, COACH, PKG, SUB] = ['l124-client', 'l124-coach', 'l124-pkg', 'sub_l124'];
const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 86_400;

class StripeStub extends StripeConnectApiService {
  sub = {
    id: SUB,
    status: 'active',
    customer: 'cus_l124',
    current_period_end: PERIOD_END,
    cancel_at_period_end: false,
    canceled_at: null,
    default_payment_method: 'pm_l124',
    metadata: {},
  };
  retrieveSubscription = jest.fn(async (): Promise<any> => this.sub);
  retrieveSubscriptionForCheckout = jest.fn(async (): Promise<any> => this.sub);
}

liveDescribe('MONEY-WEBHOOK-124 B-WH-1 repeat grant on real PostgreSQL', () => {
  let prisma: PrismaService;
  let billing: BillingService;
  const splits = { onChargeSucceeded: jest.fn(async () => undefined) };

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    for (const id of [CLIENT, COACH]) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: id } });
    }
    await prisma.coachPackage.create({
      data: { id: PKG, coach_id: COACH, name: 'Monthly coaching', amount_cents: 4900 },
    });
    const fanout = new PurchaseFanoutService(undefined, undefined, undefined, prisma);
    // Reflect.construct keeps the partial doubles untyped without a banned cast.
    const handler: CheckoutWebhookHandlerService = Reflect.construct(CheckoutWebhookHandlerService, [
      prisma,
      new StripeStub(),
      splits,
      undefined,
      undefined,
      fanout,
    ]);
    billing = Reflect.construct(BillingService, [
      prisma,
      { capture: jest.fn(), identify: jest.fn() },
      { write: jest.fn(async () => undefined), list: jest.fn(async () => []) },
      undefined,
      handler,
    ]);
  }, 180_000);
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('a locked-out client pays the overdue renewal: invoice.paid gives access back on the first delivery', async () => {
    await prisma.clientPurchase.create({
      data: {
        id: 'cp-l124',
        client_user_id: CLIENT,
        coach_user_id: COACH,
        package_id: PKG,
        amount_cents: 4900,
        billing_type: 'recurring',
        stripe_subscription_id: SUB,
        stripe_checkout_session_id: SUB,
        stripe_customer_id: 'cus_l124',
        idempotency_key: 'cp-l124',
        status: 'unpaid',
        entitlement_active: false,
      },
    });
    // The first grant ran the fan-out and claimed the coach's "new purchase" alert.
    await prisma.purchaseFanout.create({
      data: { purchase_id: 'cp-l124', entrypoint: 'in_app_ps', state: 'succeeded' },
    });
    await prisma.dripResolverMarker.create({
      data: { purpose: 'coach_new_purchase', purchase_id: 'cp-l124', content_id: '-' },
    });

    const paid = {
      id: 'evt_l124_paid',
      type: 'invoice.paid',
      data: {
        object: { id: 'in_l124', subscription: SUB, amount_paid: 4900, currency: 'usd', charge: 'ch_l124' },
      },
    };
    await expect(billing.handleEvent(paid)).resolves.toEqual({ processed: true });

    const row = await prisma.clientPurchase.findUniqueOrThrow({ where: { id: 'cp-l124' } });
    expect(row).toMatchObject({ status: 'active', entitlement_active: true });
    const done = await prisma.stripeProcessedEvent.findUniqueOrThrow({
      where: { stripe_event_id: 'evt_l124_paid' },
    });
    expect(done.handler_completed_at).toBeInstanceOf(Date);
    expect(splits.onChargeSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_amount_cents: 4900, invoice_charge_id: 'ch_l124' }),
    );
    expect(
      await prisma.dripResolverMarker.count({ where: { purchase_id: 'cp-l124', purpose: 'coach_new_purchase' } }),
    ).toBe(1);
  });
});
