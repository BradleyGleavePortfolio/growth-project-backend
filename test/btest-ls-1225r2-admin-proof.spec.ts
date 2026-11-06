import { ValidationPipe } from '@nestjs/common';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { UpdateNotificationPreferencesDto } from '../src/notifications/notifications.dto';

describe('LS-1225R2 independent shared-admin and request boundary coverage', () => {
  const cases = ['refunded', 'disputed', 'chargeback_lost'].flatMap((status) =>
    ['balanced', 'drifted', 'stripe_unavailable'].map((money) => [status, money]),
  );
  it.each(cases)('%s / %s keeps the three-number admin response', async (status, money) => {
    const purchase = {
      id: 'purchase-example',
      status,
      source: null,
      stripe_payment_intent_id: 'intent-example',
    };
    const prisma = {
      clientPurchase: {
        findMany: jest.fn(async ({ where }: any) =>
          where.source === null && where.status.in.includes(status) ? [purchase] : [],
        ),
      },
      splitLedgerEntry: {
        findMany: jest.fn(async () => [{
          kind: 'destination',
          amount_cents: money === 'drifted' ? 9_500 : 10_000,
          reversed_cents: status === 'refunded' || status === 'chargeback_lost' ? 10_000 : 0,
          status: 'posted',
        }]),
      },
      connectTransfer: { findMany: jest.fn(async () => []) },
      chargeSettlement: { findMany: jest.fn(async () => []) },
      chargeDispute: { findMany: jest.fn(async () => status === 'chargeback_lost' ? [{ amount_cents: 10_000 }] : []) },
      reconciliationSnapshot: { upsert: jest.fn(async ({ create }: any) => create) },
    };
    const stripe = {
      retrievePaymentIntent: jest.fn(async () => ({ latest_charge: 'charge-example' })),
      retrieveCharge: jest.fn(async () => {
        if (money === 'stripe_unavailable') throw new Error('offline-example');
        return {
          amount: 10_000,
          amount_refunded: status === 'refunded' ? 10_000 : 0,
          application_fee_amount: 0,
        };
      }),
    };
    const controller = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
    (controller as any).reconciliation = new ReconciliationService(prisma as any, stripe as any);

    const response = await controller.runReconciliationSweeper('50');

    expect(response).toEqual({
      scanned: 1,
      drifted: money === 'drifted' ? 1 : 0,
      unknown: money === 'stripe_unavailable' ? 1 : 0,
    });
    expect(Object.keys(response).sort()).toEqual(['drifted', 'scanned', 'unknown']);
    expect(prisma.reconciliationSnapshot.upsert).toHaveBeenCalledTimes(1);
  });

  it('a request cannot set the in-process sender_words option through preferences', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(pipe.transform(
      { muted: false, sender_words: true },
      { type: 'body', metatype: UpdateNotificationPreferencesDto },
    )).rejects.toThrow();
    await expect(pipe.transform(
      { muted: false },
      { type: 'body', metatype: UpdateNotificationPreferencesDto },
    )).resolves.toMatchObject({ muted: false });
  });
});
