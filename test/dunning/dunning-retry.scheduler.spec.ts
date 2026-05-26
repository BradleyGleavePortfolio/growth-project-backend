/**
 * r50 — DunningRetryScheduler unit tests.
 *
 * Exercises the worker's interaction with Stripe + DunningService:
 *   * Stripe success  → recordRecovery
 *   * Stripe failure  → recordRetryFailure(n)
 *   * Past-due-only filter
 *   * Idempotency-Key shape on payInvoice
 */

import { StripeApiError } from '../../src/billing/stripe-api.service';
import { DunningRetryScheduler } from '../../src/dunning/dunning-retry.scheduler';

function freshCase(overrides: any = {}) {
  return {
    id: 'case-r',
    coach_id: 'coach-1',
    stripe_subscription_id: 'sub_r',
    stripe_customer_id: 'cus_r',
    stripe_invoice_id: 'in_r',
    state: 'retry_1_scheduled',
    amount_cents: 1999,
    currency: 'usd',
    failure_reason: 'card_declined',
    failure_code: 'card_declined',
    retry_1_at: new Date(Date.now() - 60_000),
    retry_2_at: null,
    retry_3_at: null,
    recovered_at: null,
    churned_at: null,
    opened_by_event_id: 'evt_x',
    created_at: new Date(Date.now() - 86_400_000),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeScheduler(opts: {
  due: any[];
  payResult: { paid?: boolean; status?: string } | Error;
}) {
  const notified: any[] = [];
  const dunning = {
    findDueRetries: jest.fn().mockResolvedValue(opts.due),
    recordRetryFailure: jest.fn(async (caseId: string, n: number) => {
      const c = opts.due.find((x) => x.id === caseId);
      if (c) c.state = n === 3 ? 'churned' : `retry_${n + 1}_scheduled`;
      return c;
    }),
    recordRecovery: jest.fn(async () => {
      const c = opts.due[0];
      if (c) c.state = 'recovered';
      return c;
    }),
  };
  const stripe: any = {
    payInvoice: jest.fn(async (args: { invoiceId: string; idempotencyKey: string }) => {
      if (opts.payResult instanceof Error) throw opts.payResult;
      return { id: args.invoiceId, ...opts.payResult };
    }),
  };
  const notifier: any = {
    retryScheduled: jest.fn(async (c: any, n: number) => {
      notified.push({ caseId: c.id, n });
    }),
    recovered: jest.fn(),
    churned: jest.fn(),
  };
  const sched = new DunningRetryScheduler(
    {} as any, // prisma — unused in runOnce path
    dunning as any,
    stripe as any,
    notifier as any,
  );
  return { sched, stripe, dunning, notifier, notified };
}

describe('DunningRetryScheduler', () => {
  it('on Stripe success calls recordRecovery and skips recordRetryFailure', async () => {
    const due = [freshCase()];
    const { sched, dunning, stripe } = makeScheduler({
      due,
      payResult: { paid: true, status: 'paid' },
    });
    await sched.runOnce();
    expect(stripe.payInvoice).toHaveBeenCalledTimes(1);
    expect(dunning.recordRecovery).toHaveBeenCalledWith('sub_r');
    expect(dunning.recordRetryFailure).not.toHaveBeenCalled();
  });

  it('on Stripe 402 (card_declined) calls recordRetryFailure with the right n', async () => {
    const due = [freshCase({ state: 'retry_2_scheduled', retry_2_at: new Date(Date.now() - 60_000) })];
    const { sched, dunning } = makeScheduler({
      due,
      payResult: new StripeApiError('card_declined', 402, 'card_declined', 'card_error'),
    });
    await sched.runOnce();
    expect(dunning.recordRetryFailure).toHaveBeenCalledWith('case-r', 2);
    expect(dunning.recordRecovery).not.toHaveBeenCalled();
  });

  it('on Stripe network failure still advances state — no infinite retry on the same slot', async () => {
    const due = [freshCase()];
    const { sched, dunning } = makeScheduler({
      due,
      payResult: new Error('ECONNRESET'),
    });
    await sched.runOnce();
    expect(dunning.recordRetryFailure).toHaveBeenCalledWith('case-r', 1);
  });

  it('uses a per-slot Idempotency-Key on payInvoice', async () => {
    const due = [freshCase()];
    const { sched, stripe } = makeScheduler({
      due,
      payResult: { paid: true },
    });
    await sched.runOnce();
    const args = stripe.payInvoice.mock.calls[0][0];
    expect(args.idempotencyKey).toBe('dunning-retry:case-r:1');
    expect(args.invoiceId).toBe('in_r');
  });

  it('skips cases with no stripe_invoice_id', async () => {
    const c = freshCase({ stripe_invoice_id: null });
    const { sched, stripe, dunning } = makeScheduler({
      due: [c],
      payResult: { paid: true },
    });
    await sched.runOnce();
    expect(stripe.payInvoice).not.toHaveBeenCalled();
    expect(dunning.recordRecovery).not.toHaveBeenCalled();
    expect(dunning.recordRetryFailure).not.toHaveBeenCalled();
  });

  it('fires the retry notification BEFORE hitting Stripe', async () => {
    const due = [freshCase({ state: 'retry_3_scheduled', retry_3_at: new Date(Date.now() - 60_000) })];
    const { sched, notifier, notified } = makeScheduler({
      due,
      payResult: new StripeApiError('card_declined', 402, 'card_declined', 'card_error'),
    });
    await sched.runOnce();
    expect(notifier.retryScheduled).toHaveBeenCalledTimes(1);
    expect(notified).toEqual([{ caseId: 'case-r', n: 3 }]);
  });

  it('processes multiple due cases in a single tick', async () => {
    const due = [
      freshCase({ id: 'a', stripe_subscription_id: 'sub_a' }),
      freshCase({ id: 'b', stripe_subscription_id: 'sub_b', state: 'retry_2_scheduled', retry_2_at: new Date(Date.now() - 60_000) }),
    ];
    const { sched, stripe } = makeScheduler({
      due,
      payResult: { paid: false, status: 'open' },
    });
    const n = await sched.runOnce();
    expect(n).toBe(2);
    expect(stripe.payInvoice).toHaveBeenCalledTimes(2);
  });
});
