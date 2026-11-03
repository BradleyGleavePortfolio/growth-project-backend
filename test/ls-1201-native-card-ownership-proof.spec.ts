import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';

describe('LS-1201: native card update uses every owned subscription and no foreign one', () => {
  it.each([false, true])('101 owned plans and another client/coach; foreign SI=%s', async (foreignIntent) => {
    const own = Array.from({ length: 101 }, (_, i) => ({
      id: `purchase-${String(i).padStart(3, '0')}`,
      client_user_id: 'client-own', coach_user_id: 'coach-own',
      billing_type: 'recurring', status: 'active', dunning: null,
      stripe_subscription_id: `subscription-${i}`, created_at: new Date(i),
    }));
    const foreign = {
      ...own[0], id: 'purchase-foreign', client_user_id: 'client-other',
      coach_user_id: 'coach-other', stripe_subscription_id: 'subscription-foreign',
    };
    type Where = {
      client_user_id: string; billing_type: string;
      status: { in: string[] }; stripe_subscription_id: { not: null };
      id?: { gt: string };
    };
    const db = {
      connectCustomer: {
        findUnique: jest.fn(async () => ({
          id: 'binding-own', client_user_id: 'client-own',
          stripe_customer_id: 'customer-own',
        })),
        update: jest.fn(async () => ({})),
      },
      clientPurchase: {
        findMany: jest.fn(async ({ where, take }: { where: Where; take: number }) =>
          [...own, foreign].filter((p) =>
            p.client_user_id === where.client_user_id &&
            p.billing_type === where.billing_type &&
            where.status.in.includes(p.status) &&
            p.stripe_subscription_id !== where.stripe_subscription_id.not &&
            (!where.id || p.id > where.id.gt),
          ).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take)),
      },
      clientBillingOperation: { findMany: jest.fn(async () => []) },
      user: { findMany: jest.fn(async () => []) },
    };
    const stripe = {
      retrieveSetupIntent: jest.fn(async () => ({
        id: 'setup-update', status: 'succeeded', payment_method: 'method-new',
        customer: foreignIntent ? 'customer-other' : 'customer-own',
        metadata: { tgp_client_user_id: foreignIntent ? 'client-other' : 'client-own' },
      })),
      setCustomerDefaultPaymentMethod: jest.fn(async () => ({})),
      setSubscriptionDefaultPaymentMethod: jest.fn(async (_args: {
        subscriptionId: string; paymentMethodId: string; idempotencyKey: string;
      }) => ({})),
      retrievePaymentMethod: jest.fn(async () => ({
        card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
      })),
      payInvoice: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        ClientBillingService,
        { provide: PrismaService, useValue: db },
        { provide: StripeConnectApiService, useValue: stripe },
      ],
    }).compile();
    try {
      const request = module.get(ClientBillingService).confirmCardUpdate('client-own', 'setup-update', []);
      if (foreignIntent) {
        await expect(request).rejects.toMatchObject({
          response: expect.objectContaining({ error: 'SETUP_INTENT_NOT_FOUND' }),
        });
        expect(db.clientPurchase.findMany).not.toHaveBeenCalled();
        expect(stripe.setCustomerDefaultPaymentMethod).not.toHaveBeenCalled();
        expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
        expect(db.connectCustomer.update).not.toHaveBeenCalled();
      } else {
        await expect(request).resolves.toMatchObject({ outcome: 'saved' });
        expect(db.clientPurchase.findMany).toHaveBeenCalledTimes(2);
        expect(db.clientPurchase.findMany.mock.calls[1][0]).toMatchObject({
          where: { client_user_id: 'client-own', id: { gt: 'purchase-099' } }, take: 100,
        });
        expect(stripe.setCustomerDefaultPaymentMethod).toHaveBeenCalledWith(
          expect.objectContaining({ customerId: 'customer-own', paymentMethodId: 'method-new' }),
        );
        expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(101);
        expect(new Set(stripe.setSubscriptionDefaultPaymentMethod.mock.calls.map(
          ([arg]) => arg.subscriptionId,
        ))).toEqual(new Set(own.map((p) => p.stripe_subscription_id)));
        expect(stripe.setSubscriptionDefaultPaymentMethod.mock.calls.every(
          ([arg]) => arg.paymentMethodId === 'method-new',
        )).toBe(true);
        expect(db.connectCustomer.update).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'binding-own' } }),
        );
      }
      expect(stripe.payInvoice).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
});
