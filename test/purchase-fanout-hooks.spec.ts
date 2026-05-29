import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

// Verifies PR-4 fan-out seam is invoked from both webhook hook points
// (#1 applyCheckoutCompleted, #2 applyPaymentIntentSucceeded) with the
// right entrypoint tag.

class StripeStub extends StripeConnectApiService {
  retrieveSubscription = jest.fn();
  retrievePaymentMethod = jest.fn();
}

function makePrisma() {
  const packages: any[] = [];
  const purchases: any[] = [];
  const fanouts: any[] = [];
  return {
    _packages: packages,
    _purchases: purchases,
    _fanouts: fanouts,
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) =>
        packages.find((p) => p.id === where.id) ?? null,
      ),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => {
          if (where.stripe_checkout_session_id)
            return p.stripe_checkout_session_id === where.stripe_checkout_session_id;
          return false;
        }) ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        purchases.find((p) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    purchaseFanout: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = fanouts.find((f) => f.purchase_id === where.purchase_id);
        if (existing) return { ...existing };
        const row = { id: `fo-${fanouts.length + 1}`, state: 'pending', ...create };
        fanouts.push(row);
        return { ...row };
      }),
    },
  };
}

describe('PurchaseFanout seam wired into checkout webhook handler', () => {
  it('fires fanout with entrypoint=in_app_hosted on checkout.session.completed', async () => {
    const prisma = makePrisma();
    const fanout = new PurchaseFanoutService();
    const fanoutSpy = jest.spyOn(fanout, 'onPurchaseEntitled');
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined, // splits
      undefined, // dunning
      undefined, // refundDispute
      fanout,
    );

    prisma._packages.push({ id: 'pkg-1', coach_id: 'coach-1', billing_type: 'one_time', duration_periods: 12 });
    prisma._purchases.push({
      id: 'cp-1',
      package_id: 'pkg-1',
      coach_user_id: 'coach-1',
      client_user_id: 'client-1',
      stripe_checkout_session_id: 'cs_hosted',
      status: 'pending',
      entitlement_active: false,
      billing_type: 'one_time',
      created_at: new Date(),
    });

    const result = await svc.handle({
      id: 'evt_hosted',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_hosted', mode: 'payment', payment_intent: 'pi_1', customer: 'cus_1' } },
    });

    expect(result.claimed).toBe(true);
    expect(fanoutSpy).toHaveBeenCalledTimes(1);
    expect(fanoutSpy.mock.calls[0][1]).toMatchObject({ entrypoint: 'in_app_hosted', coachId: 'coach-1', clientId: 'client-1' });
    expect(prisma._fanouts).toHaveLength(1);
    expect(prisma._fanouts[0]).toMatchObject({ purchase_id: 'cp-1', entrypoint: 'in_app_hosted', state: 'pending' });
  });

  it('fires fanout with entrypoint=in_app_ps on payment_intent.succeeded', async () => {
    const prisma = makePrisma();
    const fanout = new PurchaseFanoutService();
    const fanoutSpy = jest.spyOn(fanout, 'onPurchaseEntitled');
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined,
      undefined,
      undefined,
      fanout,
    );

    prisma._purchases.push({
      id: 'cp-2',
      package_id: 'pkg-2',
      coach_user_id: 'coach-2',
      client_user_id: 'client-2',
      stripe_payment_intent_id: 'pi_ps',
      status: 'pending',
      entitlement_active: false,
      created_at: new Date(),
    });

    await svc.handle({
      id: 'evt_ps',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_ps' } },
    });

    expect(fanoutSpy).toHaveBeenCalledTimes(1);
    expect(fanoutSpy.mock.calls[0][1]).toMatchObject({ entrypoint: 'in_app_ps' });
    expect(prisma._fanouts).toHaveLength(1);
    expect(prisma._fanouts[0].entrypoint).toBe('in_app_ps');
  });

  it('webhook replay does NOT create a second fanout row + does not throw', async () => {
    const prisma = makePrisma();
    const fanout = new PurchaseFanoutService();
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined,
      undefined,
      undefined,
      fanout,
    );

    prisma._purchases.push({
      id: 'cp-3',
      coach_user_id: 'coach-3',
      client_user_id: 'client-3',
      stripe_payment_intent_id: 'pi_replay',
      status: 'pending',
      entitlement_active: false,
      created_at: new Date(),
    });

    const evt = {
      id: 'evt_replay',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_replay' } },
    };
    await svc.handle(evt);
    // findFirst guard means the second handle() call exits early on
    // `status:'pending'` filter mismatch — simulate true replay by
    // resetting status to 'pending' so we reach the fanout call again.
    prisma._purchases[0].status = 'pending';
    await svc.handle(evt);

    expect(prisma._fanouts).toHaveLength(1);
  });
});
