// A279-P1-1 — LostWebhookReconcileService uses the existing valid terminal
// status `conversion_failed_terminal` when bailing out after >MAX attempts.
//
// Pre-fix, this code wrote `status: 'reconcile_failed'`, a value not in
// either GUEST_CHECKOUT_STATUSES or the GuestCheckout_status_check CHECK
// constraint. In production Postgres raises 23514, the outer try/catch
// swallows it, and the row sits in 'pending' forever — every minute the
// cron polls Stripe for that row, burning API quota and producing log
// spam, all of it silent.
//
// These tests pin the contract that the >MAX path:
//   (a) writes a status that is a member of GUEST_CHECKOUT_STATUSES, AND
//   (b) writes exactly 'conversion_failed_terminal'.
//
// Both assertions fail against the previous (`reconcile_failed`) source.

import { LostWebhookReconcileService } from '../src/storefront/lost-webhook-reconcile.service';
import {
  GUEST_CHECKOUT_STATUSES,
  isGuestCheckoutStatus,
} from '../src/storefront/guest-checkout-status';

// Minimal Prisma stub that records the writes the service issues.
function makePrismaStub(rowAttempts: number) {
  const writes: Array<{ where: any; data: any }> = [];
  return {
    writes,
    guestCheckout: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'gc_test_1',
          stripe_payment_intent_id: 'pi_test_123',
          created_at: new Date(0),
        },
      ]),
      update: jest.fn().mockResolvedValue({
        // `claimed` after the increment+select
        reconcile_attempts: rowAttempts,
        status: 'pending',
      }),
      updateMany: jest.fn().mockImplementation(async (args: any) => {
        writes.push({ where: args.where, data: args.data });
        return { count: 1 };
      }),
    },
  };
}

describe('LostWebhookReconcileService > >MAX_RECONCILE_ATTEMPTS bail-out (A279-P1-1)', () => {
  it('writes a status that is a member of GUEST_CHECKOUT_STATUSES (would fail with reconcile_failed)', async () => {
    const prisma = makePrismaStub(/* >5 */ 6);
    const stripe = { retrievePaymentIntent: jest.fn() } as any;
    const guestCheckout = { handlePaymentSucceeded: jest.fn() } as any;
    const svc = new LostWebhookReconcileService(
      prisma as any,
      stripe,
      guestCheckout,
    );

    const changes = await svc.runOnce(new Date());

    expect(changes).toBe(1);
    expect(prisma.writes).toHaveLength(1);
    const writtenStatus = prisma.writes[0].data.status as string;
    // The exact thing that simulates the Postgres CHECK constraint at the
    // TS layer. Pre-fix this was 'reconcile_failed' — not in the set, so
    // isGuestCheckoutStatus returns false and the spec fails.
    expect(isGuestCheckoutStatus(writtenStatus)).toBe(true);
    expect(GUEST_CHECKOUT_STATUSES).toContain(writtenStatus as any);
  });

  it('writes the exact existing terminal status conversion_failed_terminal', async () => {
    const prisma = makePrismaStub(7);
    const stripe = { retrievePaymentIntent: jest.fn() } as any;
    const guestCheckout = { handlePaymentSucceeded: jest.fn() } as any;
    const svc = new LostWebhookReconcileService(
      prisma as any,
      stripe,
      guestCheckout,
    );

    await svc.runOnce(new Date());

    expect(prisma.writes[0]).toEqual({
      where: { id: 'gc_test_1', status: 'pending' },
      data: { status: 'conversion_failed_terminal' },
    });
    // Stripe must NOT be polled on a bail-out row — we already gave up.
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('does NOT bail out at exactly MAX_RECONCILE_ATTEMPTS (=5); polls Stripe instead', async () => {
    // Boundary: code uses `> MAX_RECONCILE_ATTEMPTS` (strict). At attempt 5
    // we still poll; at 6 we bail. This pins the boundary so a future
    // refactor that flips to `>=` doesn't silently start writing the
    // terminal status one tick too early.
    const prisma = makePrismaStub(5);
    const stripe = {
      retrievePaymentIntent: jest.fn().mockResolvedValue({ status: 'processing' }),
    } as any;
    const guestCheckout = { handlePaymentSucceeded: jest.fn() } as any;
    const svc = new LostWebhookReconcileService(
      prisma as any,
      stripe,
      guestCheckout,
    );

    const changes = await svc.runOnce(new Date());

    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_test_123');
    // No terminal write — processing is not a state change.
    expect(prisma.writes).toHaveLength(0);
    expect(changes).toBe(0);
  });

  it('source contains no `reconcile_failed` data-write literal (A279-P1-1 regression guard)', () => {
    // Belt + braces: even if a future change reintroduces the literal,
    // this test catches it before CI ships it. The doc comments may
    // mention the old name in historical context, but `data: { status:
    // 'reconcile_failed' }` must never reappear.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(
      require('path').join(
        __dirname,
        '..',
        'src',
        'storefront',
        'lost-webhook-reconcile.service.ts',
      ),
      'utf-8',
    );
    expect(src).not.toMatch(/status:\s*['"]reconcile_failed['"]/);
  });
});
