import type { Prisma } from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PrismaService } from '../src/prisma.service';

class StripeSnapshotStub extends StripeConnectApiService {
  statusNow = 'requires_payment_method';
  retrievePaymentIntent = jest.fn(async (id: string) => ({
    id,
    status: this.statusNow,
    latest_charge: 'ch_r4',
  }));
}

function harness(checkoutId = 'cs_r4', initialStatus = 'paid') {
  const seededAt = new Date('2026-10-04T04:34:26Z');
  const row: Record<string, unknown> = {
    id: 'cp_r4',
    package_id: 'pkg_r4',
    coach_user_id: 'coach_r4',
    client_user_id: 'client_r4',
    stripe_checkout_session_id: checkoutId,
    stripe_payment_intent_id: 'pi_r4',
    status: initialStatus,
    entitlement_active: initialStatus === 'paid',
    stripe_client_secret: null,
    stripe_ephemeral_key: null,
    last_error: null,
    created_at: seededAt,
    updated_at: seededAt,
  };
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (value instanceof Date) return (row[key] as Date).getTime() === value.getTime();
      if (value && typeof value === 'object' && 'in' in value)
        return (value as { in: unknown[] }).in.includes(row[key]);
      if (value && typeof value === 'object' && 'notIn' in value)
        return !(value as { notIn: unknown[] }).notIn.includes(row[key]);
      return row[key] === value;
    });
  const snapshot = () => ({
    ...row,
    updated_at: new Date((row.updated_at as Date).getTime()),
  });
  const write = (data: Record<string, unknown>) => {
    Object.assign(row, data);
    // Prisma @updatedAt is an application-clock timestamp, not an increment.
    if (!('updated_at' in data)) row.updated_at = new Date();
    return snapshot();
  };
  const db = {
    clientPurchase: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matches(where) ? snapshot() : null,
      ),
      findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matches(where) ? snapshot() : null,
      ),
      update: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (!matches(where)) throw Object.assign(new Error('record not found'), { code: 'P2025' });
          return write(data);
        },
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (!matches(where)) return { count: 0 };
          write(data);
          return { count: 1 };
        },
      ),
    },
    coachPackage: {
      findUnique: jest.fn(async () => ({
        id: 'pkg_r4',
        billing_type: 'one_time',
        duration_periods: 4,
      })),
    },
    $queryRaw: jest.fn(async () => []),
  };
  const stripe = new StripeSnapshotStub();
  const svc = new CheckoutWebhookHandlerService(db as unknown as PrismaService, stripe);
  const tx = db as unknown as Prisma.TransactionClient;
  return { row, db, stripe, svc, tx, seededAt };
}

const decline = (id: string) => ({
  id,
  type: 'payment_intent.payment_failed',
  data: { object: { id: 'pi_r4', last_payment_error: { message: 'card_declined' } } },
});
const success = {
  id: 'evt_r4_success',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_r4', latest_charge: 'ch_r4' } },
};

describe('independent Sol round-4 settlement acceptance', () => {
  afterEach(() => jest.useRealTimers());

  it('control: a distinctly newer success timestamp invalidates an old failure prefetch', async () => {
    const h = harness();
    const event = decline('evt_r4_newer');
    const prefetched = await h.svc.prefetchForOuterTx(event);
    jest.useFakeTimers({ now: h.seededAt.getTime() + 1 });
    h.stripe.statusNow = 'succeeded';
    await h.svc.handle(success, h.tx, {});
    await expect(h.svc.handle(event, h.tx, prefetched)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(h.row).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('B-661-3: successful settlement at the witnessed millisecond still dominates stale failure evidence', async () => {
    const h = harness();
    const event = decline('evt_r4_same_ms');
    const prefetched = await h.svc.prefetchForOuterTx(event);
    // Two machines can report the same application-clock millisecond;
    // the new explicit success write is then byte-identical to the witness.
    jest.useFakeTimers({ now: h.seededAt });
    h.stripe.statusNow = 'succeeded';
    await h.svc.handle(success, h.tx, {});
    expect(h.db.clientPurchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { updated_at: h.seededAt },
      }),
    );
    try {
      await h.svc.handle(event, h.tx, prefetched);
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
    }
    expect(h.row).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('control: PaymentSheet failure then same-PI success restores paid access', async () => {
    const h = harness('pi_r4', 'payment_failed');
    h.stripe.statusNow = 'succeeded';
    const result = await h.svc.handle(success, h.tx, await h.svc.prefetchForOuterTx(success));
    expect(result.claimed).toBe(true);
    expect(h.row).toMatchObject({ status: 'paid', entitlement_active: true, last_error: null });
  });

  it('a previously completed hosted purchase regains access when its failed PI subsequently succeeds', async () => {
    const h = harness();
    const event = decline('evt_r4_hosted_failure');
    await h.svc.handle(event, h.tx, await h.svc.prefetchForOuterTx(event));
    expect(h.row).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    h.stripe.statusNow = 'succeeded';
    await h.svc.handle(success, h.tx, await h.svc.prefetchForOuterTx(success));
    // The checkout already completed. Recovery must not require another
    // completion event or recreate fanout/coach-new-purchase markers.
    expect(h.row).toMatchObject({ status: 'paid', entitlement_active: true, last_error: null });
  });

  it('control: a never-activated adopted hosted purchase still waits for its own completion', async () => {
    const h = harness('cs_r4', 'payment_failed');
    const result = await h.svc.handle(success, h.tx, await h.svc.prefetchForOuterTx(success));
    expect(result).toEqual({ claimed: false, reason: 'checkout_session_activates' });
    expect(h.row).toMatchObject({ status: 'payment_failed', entitlement_active: false });
  });

  it('control: a terminal refund present before the success read remains terminal', async () => {
    const h = harness('pi_r4', 'refunded');
    await h.svc.handle(success, h.tx, {});
    expect(h.row).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(h.db.clientPurchase.update).not.toHaveBeenCalled();
  });

  it('a delayed duplicate completion cannot resurrect a hosted purchase after a real async failure', async () => {
    const h = harness();
    const event = decline('evt_r4_failure_then_completion');
    await h.svc.handle(event, h.tx, await h.svc.prefetchForOuterTx(event));
    expect(h.row).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    await h.svc.handle(
      {
        id: 'evt_r4_old_completion',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_r4', payment_intent: 'pi_r4', mode: 'payment' } },
      },
      h.tx,
      {},
    );
    expect(h.row).toMatchObject({ status: 'payment_failed', entitlement_active: false });
  });

  it.each(['refunded', 'canceled', 'expired', 'disputed', 'chargeback_lost'])(
    'a successful retry read cannot overwrite terminal %s committed before its activation write',
    async (terminalStatus) => {
      const h = harness('pi_r4', 'payment_failed');
      const terminalEntitlement = terminalStatus === 'disputed';
      h.db.clientPurchase.findFirst.mockImplementationOnce(async () => {
        const snapshot = { ...h.row, updated_at: new Date((h.row.updated_at as Date).getTime()) };
        // Refund/account termination owns the later terminal state.
        Object.assign(h.row, {
          status: terminalStatus,
          entitlement_active: terminalEntitlement,
          updated_at: new Date(h.seededAt.getTime() + 2),
        });
        return snapshot;
      });
      try {
        await h.svc.handle(success, h.tx, {});
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(h.row).toMatchObject({
        status: terminalStatus,
        entitlement_active: terminalEntitlement,
      });
    },
  );
});
