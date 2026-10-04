// Independent agent 118 Sol probe: complete activated-owner selection and
// recovery rollback on exact #702 source (which includes exact #661 source).
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { PrismaService } from '../src/prisma.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const url = process.env.MWB3_TEST_DATABASE_URL || '';
const live = url ? describe : describe.skip;
live('AUD-SOL-661-118 complete recovery boundary', () => {
  let prisma: PrismaService;
  let handler: CheckoutWebhookHandlerService;
  let fanout: PurchaseFanoutService;
  const CLIENT = 'sol118-client', COACH = 'sol118-coach', PKG = 'sol118-pkg';
  const success = (id: string) => ({
    id: `evt_${id}`, type: 'payment_intent.succeeded', data: { object: { id } },
  });
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    for (const id of [CLIENT, COACH]) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: id } });
    }
    await prisma.coachPackage.create({ data: { id: PKG, coach_id: COACH, name: 'Probe', amount_cents: 5000 } });
    fanout = new PurchaseFanoutService(undefined, undefined, undefined, prisma);
    handler = new CheckoutWebhookHandlerService(prisma, new StripeConnectApiService(), undefined, undefined, undefined, fanout);
  }, 180_000);
  afterAll(async () => { if (prisma) await prisma.$disconnect(); });
  async function seed(id: string, pi: string, billing = 'one_time', subscription: string | null = null, activated = true) {
    await prisma.clientPurchase.create({ data: {
      id, client_user_id: CLIENT, coach_user_id: COACH, package_id: PKG, amount_cents: 5000,
      idempotency_key: id, stripe_checkout_session_id: `cs_${id}`, stripe_payment_intent_id: pi,
      status: 'payment_failed', billing_type: billing, stripe_subscription_id: subscription,
      entitlement_active: false, stripe_client_secret: `${pi}_secret_test`, stripe_ephemeral_key: 'ek_test_test',
    } });
    if (activated) await prisma.purchaseFanout.create({ data: { purchase_id: id, entrypoint: 'in_app_hosted', state: 'succeeded' } });
  }
  it('over ten activated recurring/subscribed distractors cannot hide a one-time owner; two workers recover once', async () => {
    const pi = 'pi_118_mixed';
    // Physical insertion order is adversarial: distractors precede the owner.
    for (let i = 0; i < 12; i += 1) await seed(`recurring-${i}`, pi, 'recurring');
    for (let i = 0; i < 12; i += 1) await seed(`subscribed-${i}`, pi, 'one_time', `sub_118_${i}`);
    for (let i = 0; i < 12; i += 1) await seed(`unactivated-${i}`, pi, 'one_time', null, false);
    await seed('owner', pi);
    await prisma.scheduledDrop.create({ data: {
      id: 'drop-owner', client_purchase_id: 'owner', content_id: 'owner', asset_type: 'workout',
      asset_id: 'asset', cadence_kind: 'offset_days', cadence_payload: {}, fire_at: new Date(),
      status: 'canceled', failure_reason: 'canceled:payment_failed',
    } });
    const result = await Promise.all([1, 2].map(() =>
      prisma.$transaction((tx) => handler.handle(success(pi), tx)),
    ));
    expect(result.filter((r) => r.reason === 'payment_recovered')).toHaveLength(1);
    expect(await prisma.clientPurchase.findUniqueOrThrow({ where: { id: 'owner' } }))
      .toMatchObject({ status: 'paid', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null });
    expect(await prisma.scheduledDrop.findUniqueOrThrow({ where: { id: 'drop-owner' } }))
      .toMatchObject({ status: 'pending', failure_reason: null });
    expect(await prisma.clientPurchase.count({ where: { stripe_payment_intent_id: pi, entitlement_active: true } })).toBe(1);
    expect(await prisma.clientPurchase.count({ where: { stripe_payment_intent_id: pi, status: 'payment_failed' } })).toBe(36);
  }, 60_000);
  it('drop restoration failure rolls back paid access and credential erasure; retry recovers', async () => {
    const pi = 'pi_118_rollback';
    await seed('rollback-owner', pi);
    jest.spyOn(fanout, 'restoreAfterPaymentRecovered').mockRejectedValueOnce(new Error('probe_restore_failed'));
    await expect(prisma.$transaction((tx) => handler.handle(success(pi), tx))).rejects.toThrow('probe_restore_failed');
    expect(await prisma.clientPurchase.findUniqueOrThrow({ where: { id: 'rollback-owner' } }))
      .toMatchObject({ status: 'payment_failed', entitlement_active: false, stripe_client_secret: `${pi}_secret_test` });
    expect(await prisma.$transaction((tx) => handler.handle(success(pi), tx)))
      .toMatchObject({ claimed: true, reason: 'payment_recovered' });
  }, 60_000);
});
