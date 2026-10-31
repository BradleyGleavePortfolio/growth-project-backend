import 'reflect-metadata';
import type { ClientPurchase } from '@prisma/client';
import { DunningService } from '../src/checkout/dunning.service';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

// Stripe documents both skipped hard-decline retries (attempt_count rises,
// no new Charge) and a recommended eight-try Smart Retries policy:
// https://docs.stripe.com/billing/revenue-recovery/smart-retries
// This exercises the real DunningState writer, then the Money projection.
describe('LS-1191R2 B1: bank try evidence is not a reminder budget', () => {
  it.each([
    { label: 'hard-decline schedule count 3 after one executed charge', providerCount: 3, executedCount: 1, reason: 'lost_card' },
    { label: 'fifth executed try under an eight-try policy', providerCount: 5, executedCount: 5, reason: 'insufficient_funds' },
    { label: 'final scheduled hard-decline slot after one executed charge', providerCount: 4, executedCount: 1, reason: 'lost_card' },
  ])('LS-1191R2 B1: $label is not shown as an invented bank try fraction', async ({ providerCount, executedCount, reason }) => {
    let state: Record<string, unknown> = {
      id: 'review-cycle', purchase_id: 'review-purchase', status: 'active',
      failure_count: 1, last_attempt_number: 1, step_index: 0,
      last_failure_reason: 'Your card was declined.',
      last_failed_amount_cents: 14900, locked_out_at: null,
      grace_period_ends_at: null, cancel_scheduled_at: null,
    };
    const prisma = {
      dunningState: {
        findUnique: jest.fn(async () => ({ ...state })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const increment = data.failure_count as { increment: number };
          state = { ...state, ...data, failure_count: Number(state.failure_count) + increment.increment };
          return { ...state };
        }),
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
    await dunning.recordFailure({
      purchase: { id: 'review-purchase', client_user_id: 'review-client' } as ClientPurchase,
      stripe_invoice_id: null, amount_due_cents: 14900,
      attempt_number: providerCount, reason,
    });
    expect(state.last_attempt_number).toBe(providerCount);
    expect(state.last_failure_reason).toBe(reason);
    const money: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
    const out = await money.getAttention('review-coach');
    const fp = out.items[0].failed_payment!;
    // Existing phone contract: max_attempts=0 hides an unproven fraction.
    // A visible fraction must instead use executed tries and a real budget.
    const hiddenOrSupported = fp.max_attempts === 0 ||
      (fp.attempt === executedCount && fp.max_attempts >= executedCount);
    expect({ attempt: fp.attempt, max: fp.max_attempts, hiddenOrSupported })
      .toMatchObject({ hiddenOrSupported: true });
  });
});
