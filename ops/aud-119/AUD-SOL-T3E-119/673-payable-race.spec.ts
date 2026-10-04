import { TrialConflictService, trialPaidHistory } from '../src/packages/trials/trial-conflict.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { makeTrialConflictTable, makeTrialUsageTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
type C = ConstructorParameters<typeof TrialConflictService>;

afterEach(() => { jest.restoreAllMocks(); });

describe('AUD-SOL-T3E-119 — payable invoice completeness after confirmed open void', () => {
  it.each([
    ['past_due', 'open'],
    ['unpaid', 'open'],
    ['past_due', 'uncollectible'],
    ['unpaid', 'uncollectible'],
  ])(
    '%s / %s: preserve a paid plan while the active webhook is delayed',
    async (status, payingStatus) => {
      const table = makeTrialConflictTable();
      await table.createMany({ data: [{
        id: 'conflict-payment', purchase_id: 'purchase-payment',
        stripe_subscription_id: 'sub-payment', next_attempt_at: NOW,
      }] });
      const purchase: Record<string, unknown> = {
        id: 'purchase-payment', client_user_id: 'client-payment',
        coach_user_id: 'coach-payment', package_id: 'package-payment',
        stripe_subscription_id: 'sub-payment', billing_type: 'recurring',
        status: 'trialing', entitlement_active: false, trial_days: 7,
        trial_ends_at: new Date(NOW.getTime() - 86400000),
        amount_cents: 4900, currency: 'usd', created_at: NOW,
      };
      const rawDb = {
        packageTrialConflict: table,
        packageTrialUsage: makeTrialUsageTable(),
        clientPurchase: {
          findUnique: jest.fn(async () => ({ ...purchase })),
          update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(purchase, data);
            return { ...purchase };
          }),
        },
        coachPackage: { findUnique: jest.fn(async () => ({
          id: 'package-payment', duration_periods: null,
        })) },
        $queryRaw: jest.fn(async () => []),
      };
      const db = stub<C[0]>(rawDb);
      const previousSecret = process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_SECRET_KEY = 'sk_test_AUDITSYNTHETIC';
      const stripe = new StripeConnectApiService();
      const service = new TrialConflictService(db, stripe);
      const usage = new TrialUsageService(db);
      const handler = new CheckoutWebhookHandlerService(
        db, stripe, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, usage, undefined, service,
      );
      const tx = stub<Parameters<CheckoutWebhookHandlerService['handle']>[1]>(rawDb);
      const calls: string[] = [];
      let paidCents = 0;
      let accessBeforeDeleted: unknown;
      let paidRemote = false;
      const voidedIds: string[] = [];
      const activeEvent = async () => handler.handle({
        id: 'evt-payment-active', type: 'customer.subscription.updated',
        data: { object: {
          id: 'sub-payment', status: 'active',
          trial_end: Math.floor(NOW.getTime() / 1000) - 86400,
          current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
        } },
      }, tx);
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const method = init?.method ?? 'GET';
        const path = String(url).replace(/^https:\/\/api\.stripe\.com\/v1/, '');
        calls.push(`${method} ${path}`);
        let body: unknown;
        if (path.startsWith('/invoices?')) {
          const queryStatus = new URLSearchParams(path.split('?')[1]).get('status');
          if (queryStatus === 'open') {
            // The newest unpaid invoice is open. An older uncollectible
            // invoice is not part of this complete status-filtered page.
            body = { data: [{ id: 'in-new-open', status: 'open' }], has_more: false };
          } else if (queryStatus === 'uncollectible') {
            body = {
              data: payingStatus === 'uncollectible'
                ? [{ id: 'in-old-uncollectible', status: 'uncollectible' }] : [],
              has_more: false,
            };
          } else if (queryStatus === 'paid') {
            // The response is prepared before the first positive payment,
            // which succeeds on the still-payable old invoice before delivery.
            body = { data: [{ id: 'in-trial', amount_paid: 0, total: 0 }], has_more: false };
            paidCents = 4900;
            paidRemote = true;
          } else {
            throw new Error(`unexpected invoice status filter ${queryStatus}`);
          }
        } else if (method === 'POST' && path.endsWith('/void')) {
          const invoiceId = path.split('/')[2];
          const paymentWonThisInvoice =
            payingStatus === 'open' || invoiceId === 'in-old-uncollectible';
          if (paymentWonThisInvoice) {
            return new Response(JSON.stringify({
              error: { type: 'invalid_request_error', code: 'invoice_not_open' },
            }), { status: 400 });
          }
          // Voiding the newest open invoice does not invalidate a separate
          // payment on the older uncollectible invoice.
          voidedIds.push(invoiceId);
          body = { id: invoiceId, status: 'void' };
        } else if (method === 'DELETE') {
          // This is already destructive dispatch. Delayed active delivery
          // grants paid access; the cancellation's real handler then removes it.
          await activeEvent();
          accessBeforeDeleted = purchase.entitlement_active;
          await handler.handle({
            id: 'evt-payment-deleted', type: 'customer.subscription.deleted',
            data: { object: { id: 'sub-payment' } },
          }, tx);
          body = { id: 'sub-payment', status: 'canceled' };
        } else {
          body = {
            id: 'sub-payment', status: paidRemote ? 'active' : status,
            latest_invoice: 'in-new-open',
            trial_end: Math.floor(NOW.getTime() / 1000) - 86400,
          };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      });
      try {
        const outcome = await service.settle('purchase-payment', NOW);
        expect(paidCents).toBe(4900);
        expect(calls.filter((c) => c.startsWith('GET /invoices?'))).toEqual(
          expect.arrayContaining([
            'GET /invoices?subscription=sub-payment&status=open&limit=100',
            'GET /invoices?subscription=sub-payment&status=paid&limit=100',
          ]),
        );
        const deleted = calls.filter((c) => c.startsWith('DELETE'));
        if (deleted.length) {
          expect(accessBeforeDeleted).toBe(true);
          expect(purchase.entitlement_active).toBe(false);
          expect(voidedIds).toEqual(['in-new-open']);
        }
        console.info('AUD-SOL-T3E-119 PAYABLE_INVOICE_RACE', {
          status, payingStatus, voidedIds, calls,
          paidCents, accessBeforeDeleted, accessAfterDeleted: purchase.entitlement_active,
          outcome, conflict: table.rows[0].status, deletes: deleted.length,
        });
        expect({
          deleted, outcome, conflict: table.rows[0].status,
          entitlement: purchase.entitlement_active,
        }).toMatchObject({ deleted: [] });
        await activeEvent();
        expect(purchase.entitlement_active).toBe(true);
      } finally {
        if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = previousSecret;
      }
    },
  );
});

describe('AUD-SOL-T3E-119 — retained malformed-money controls', () => {
  it.each([
    { amount_paid: -1, total: 0 },
    { amount_paid: 0 }, // missing total cannot distinguish a credit-funded paid invoice
    { amount_paid: Number.NaN, total: 0 },
  ])('does not prove none from malformed monetary evidence %p', (invoice) => {
    expect(trialPaidHistory({ data: [invoice], has_more: false })).toBe('unknown');
  });
  it('controls: valid no-charge history, partial no-charge history, and positive paid evidence', () => {
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: 0 }], has_more: false })).toBe('none');
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: 0 }], has_more: true })).toBe('unknown');
    expect(trialPaidHistory({ data: [{ amount_paid: 4900, total: 4900 }], has_more: true })).toBe('charged');
  });
});
