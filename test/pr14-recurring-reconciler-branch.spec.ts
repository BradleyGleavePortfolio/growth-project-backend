import { LostWebhookReconcileService } from '../src/storefront/lost-webhook-reconcile.service';

// PR-14 R2 P1-2 / P1-4 — extended lost-webhook reconciler. The previous
// reconciler only looked at the PaymentIntent status; for a recurring
// guest whose PI is in `requires_action` / `processing` but whose
// subscription has already transitioned to `active` on Stripe's side
// (Stripe's bookkeeping can lag the PI relative to the subscription on
// some card networks), the old code would tick out at
// MAX_RECONCILE_ATTEMPTS and bail. The recurring branch now asks Stripe
// for the subscription status as a second-opinion signal and converts
// against the persisted PI id when the subscription is paying.
//
// Tests:
//   1. PI status = requires_action + sub status = active → convert.
//   2. PI status = canceled + sub status = active → STILL convert (the
//      buyer paid; Stripe sometimes leaves the old PI dead after a retry).
//   3. PI status = canceled + sub status = canceled → mark failed.
//   4. PI succeeded path still works (regression guard).
//   5. One-time path (no subscription id) ignores the new branch.

function makePrismaStub(row: any) {
  return {
    guestCheckout: {
      findMany: jest.fn().mockResolvedValue([row]),
      update: jest.fn().mockResolvedValue({
        reconcile_attempts: 1,
        status: 'pending',
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('PR-14 R2 — LostWebhookReconcileService recurring branch', () => {
  it('converts when PI is requires_action but the subscription is active (P1-2)', async () => {
    const row = {
      id: 'gc-rec',
      stripe_payment_intent_id: 'pi_rec_pending',
      stripe_subscription_id: 'sub_rec_active',
      created_at: new Date(0),
    };
    const prisma = makePrismaStub(row) as any;
    const stripe = {
      retrievePaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_rec_pending',
        status: 'requires_action',
      }),
      retrieveSubscription: jest.fn().mockResolvedValue({
        id: 'sub_rec_active',
        status: 'active',
      }),
    } as any;
    const guestCheckout = {
      handlePaymentSucceeded: jest.fn().mockResolvedValue(undefined),
    } as any;
    const svc = new LostWebhookReconcileService(prisma, stripe, guestCheckout);

    const changes = await svc.runOnce(new Date());

    expect(changes).toBe(1);
    expect(stripe.retrieveSubscription).toHaveBeenCalledWith('sub_rec_active');
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledWith(
      'pi_rec_pending',
    );
  });

  it('converts when PI is canceled but the subscription is active (P1-2 — old PI dead, new PI took the payment)', async () => {
    const row = {
      id: 'gc-rec',
      stripe_payment_intent_id: 'pi_old_canceled',
      stripe_subscription_id: 'sub_paying',
      created_at: new Date(0),
    };
    const prisma = makePrismaStub(row) as any;
    const stripe = {
      retrievePaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_old_canceled',
        status: 'canceled',
      }),
      retrieveSubscription: jest.fn().mockResolvedValue({
        id: 'sub_paying',
        status: 'active',
      }),
    } as any;
    const guestCheckout = {
      handlePaymentSucceeded: jest.fn().mockResolvedValue(undefined),
    } as any;
    const svc = new LostWebhookReconcileService(prisma, stripe, guestCheckout);

    const changes = await svc.runOnce(new Date());

    expect(changes).toBe(1);
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledWith(
      'pi_old_canceled',
    );
    // We did NOT flip to 'failed' on this row (the subscription is paying).
    expect(prisma.guestCheckout.updateMany).not.toHaveBeenCalled();
  });

  it('marks failed when PI is canceled AND the subscription is canceled (genuinely dead)', async () => {
    const row = {
      id: 'gc-dead',
      stripe_payment_intent_id: 'pi_dead',
      stripe_subscription_id: 'sub_dead',
      created_at: new Date(0),
    };
    const prisma = makePrismaStub(row) as any;
    const stripe = {
      retrievePaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_dead',
        status: 'canceled',
      }),
      retrieveSubscription: jest.fn().mockResolvedValue({
        id: 'sub_dead',
        status: 'canceled',
      }),
    } as any;
    const guestCheckout = {
      handlePaymentSucceeded: jest.fn().mockResolvedValue(undefined),
    } as any;
    const svc = new LostWebhookReconcileService(prisma, stripe, guestCheckout);

    const changes = await svc.runOnce(new Date());
    expect(changes).toBe(1);
    expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
    // failed status written
    const failedWrite = prisma.guestCheckout.updateMany.mock.calls.find(
      (c: any) => c[0].data?.status === 'failed',
    );
    expect(failedWrite).toBeDefined();
  });

  it('one-time guest path (no stripe_subscription_id) does NOT consult retrieveSubscription', async () => {
    const row = {
      id: 'gc-one',
      stripe_payment_intent_id: 'pi_one_pending',
      stripe_subscription_id: null,
      created_at: new Date(0),
    };
    const prisma = makePrismaStub(row) as any;
    const stripe = {
      retrievePaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_one_pending',
        status: 'requires_action',
      }),
      retrieveSubscription: jest.fn(),
    } as any;
    const guestCheckout = {
      handlePaymentSucceeded: jest.fn(),
    } as any;
    const svc = new LostWebhookReconcileService(prisma, stripe, guestCheckout);

    await svc.runOnce(new Date());
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('regression: PI succeeded route still drives conversion exactly once', async () => {
    const row = {
      id: 'gc-pi-good',
      stripe_payment_intent_id: 'pi_succ',
      stripe_subscription_id: 'sub_succ',
      created_at: new Date(0),
    };
    const prisma = makePrismaStub(row) as any;
    const stripe = {
      retrievePaymentIntent: jest.fn().mockResolvedValue({
        id: 'pi_succ',
        status: 'succeeded',
      }),
      retrieveSubscription: jest.fn(),
    } as any;
    const guestCheckout = {
      handlePaymentSucceeded: jest.fn().mockResolvedValue(undefined),
    } as any;
    const svc = new LostWebhookReconcileService(prisma, stripe, guestCheckout);

    const changes = await svc.runOnce(new Date());
    expect(changes).toBe(1);
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
    // We didn't need the subscription check on the happy path.
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });
});
