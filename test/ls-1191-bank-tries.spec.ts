import 'reflect-metadata';
import type { ClientPurchase } from '@prisma/client';
import { DunningService } from '../src/checkout/dunning.service';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

describe('LS-1191 B2: Money counts the current invoice, not past recovered failures', () => {
  it.each([1, 3])(
    'LS-1191 B2: first try of a new invoice stays 1 after %i recovered failures',
    async (pastFailures) => {
      let state: Record<string, unknown> = {
        id: 'review-dunning', purchase_id: 'review-purchase', status: 'resolved',
        failure_count: pastFailures, last_attempt_number: pastFailures,
        step_index: 2, last_failure_reason: 'card_declined',
        last_failed_amount_cents: 14900, locked_out_at: null,
        grace_period_ends_at: null, cancel_scheduled_at: null,
        recovered_at: new Date('2026-09-30T09:00:00Z'),
      };
      const prisma = {
        dunningState: {
          findUnique: jest.fn(async () => ({ ...state })),
          update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const next = { ...data };
            if (typeof data.failure_count === 'object' && data.failure_count !== null) {
              const increment = (data.failure_count as { increment: number }).increment;
              next.failure_count = Number(state.failure_count) + increment;
            }
            state = { ...state, ...next };
            return { ...state };
          }),
        },
        dunningAttempt: {
          deleteMany: jest.fn(async () => ({ count: 0 })),
          create: jest.fn(async ({ data }: { data: unknown }) => data),
        },
        paymentReminder: { create: jest.fn(async ({ data }: { data: unknown }) => data) },
        clientPurchase: {
          findMany: jest.fn(async () => [{
            id: 'review-purchase', amount_cents: 14900, currency: 'usd',
            updated_at: new Date('2026-10-30T09:00:00Z'), last_error: 'card_declined',
            client: { id: 'review-client', name: 'Test client' },
            package: { name: 'Monthly coaching' }, dunning: { ...state, attempts: [] },
          }]),
        },
        chargeDispute: { findMany: jest.fn(async () => []) },
        connectAccount: { findUnique: jest.fn(async () => null) },
        user: { findMany: jest.fn(async () => []) },
      };
      const dunning: DunningService = Reflect.construct(DunningService, [prisma, {}]);
      // A later month's first invoice decline goes through the real writer,
      // reopening the resolved window without clearing the lifetime counter.
      await dunning.recordFailure({
        purchase: { id: 'review-purchase', client_user_id: 'review-client' } as ClientPurchase,
        stripe_invoice_id: null, amount_due_cents: 14900,
        attempt_number: 1, reason: 'card_declined',
      });
      expect(state.status).toBe('active');
      expect(state.last_attempt_number).toBe(1);
      expect(state.failure_count).toBe(pastFailures + 1);
      const money: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
      const result = await money.getAttention('review-coach');
      expect(result.items[0].failed_payment).toMatchObject({ attempt: 1, max_attempts: 4, next_retry_at: null });
    },
  );
});
