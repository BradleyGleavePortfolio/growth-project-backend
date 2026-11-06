// Independent LS-1225R2 proof: a trial can charge its renewal while its
// purchase retains no initial payment-intent pointer. Charge settlement records
// that charge before fee retrieval; a failed fee fetch leaves awaiting_fee.
// checkout-webhook-handler.service.ts:2544-2560,2689-2699,2714-2725;
// charge-settlement.service.ts:520-541,570-599,2103-2118.
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';

describe('LS-1225R2 B2: charge evidence cannot become never_charged', () => {
  it.each([
    ['canceled', 'awaiting_fee'],
    ['past_due', 'awaiting_fee'],
    ['canceled', 'error'],
    ['past_due', 'error'],
  ] as const)('%s purchase with a charged %s settlement is not clean never_charged', async (status, settlementStatus) => {
    const purchase = {
      id: 'charged-trial-example',
      source: null,
      billing_type: 'recurring',
      status,
      amount_cents: 10_000,
      stripe_payment_intent_id: null,
    };
    const settlement = {
      id: 'settlement-example',
      purchase_id: purchase.id,
      mechanism: 'separate_charge_transfer',
      stripe_charge_id: 'charge-example',
      stripe_invoice_id: 'invoice-example',
      status: settlementStatus,
      gross_cents: 10_000,
    };
    const prisma = {
      clientPurchase: { findUnique: jest.fn(async () => purchase) },
      splitLedgerEntry: { findMany: jest.fn(async () => []) },
      connectTransfer: { findMany: jest.fn(async () => []) },
      chargeSettlement: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where.purchase_id !== purchase.id) return [];
          if (where.mechanism && where.mechanism !== settlement.mechanism) return [];
          if (!where.status) return [settlement];
          const accepted = typeof where.status === 'string'
            ? where.status === settlement.status
            : where.status.in?.includes(settlement.status);
          return accepted ? [settlement] : [];
        }),
        findFirst: jest.fn(async () => settlement),
        count: jest.fn(async () => 1),
      },
      reconciliationSnapshot: {
        upsert: jest.fn(async ({ create }: any) => create),
      },
    };
    const stripe = {
      retrievePaymentIntent: jest.fn(),
      retrieveCharge: jest.fn(async () => ({ amount: 10_000, amount_refunded: 0, application_fee_amount: 0 })),
    };
    const service = new ReconciliationService(prisma as any, stripe as any);

    const result = await service.reconcilePurchase(purchase.id);

    // An incomplete charged settlement can be unknown or drift; it cannot
    // truthfully attest that no charge happened and all money matches.
    expect(result).not.toMatchObject({ status: 'ok' });
    expect(result.notes).not.toContain('never_charged');
  });
});
