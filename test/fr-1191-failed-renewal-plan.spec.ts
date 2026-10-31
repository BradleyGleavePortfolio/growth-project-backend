// FR-1191 (LS-1191 B3, LO-1191 B1) class-first: every failed-renewal status a
// recurring plan can hold (past_due while Stripe still retries, unpaid once the
// tries ran out and the subscription stays open) reads to the coach as a
// running plan with a failed payment: listed, cancellable, never "ended", and
// pause is refused with the existing PLAN_PAYMENT_FAILED message.
import 'reflect-metadata';
import type { User } from '@prisma/client';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-10-30T09:00:00Z');
const coach = { id: 'coach-a', role: 'coach' } as User;

function build(status: string) {
  const row = {
    id: 'p1', coach_user_id: 'coach-a', client_user_id: CLIENT, package_id: 'pkg',
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring', status,
    stripe_subscription_id: 'sub_1', created_at: at, current_period_end: at,
    access_expires_at: at, cancel_at_period_end: false, entitlement_active: true,
    package: { name: 'Monthly coaching' }, dunning: null, refunds: [], settlements: [],
  };
  const stripe = {
    retrieveSubscription: jest.fn(async () => ({ id: 'sub_1', status, pause_collection: null })),
    pauseSubscriptionCollection: jest.fn(),
  };
  const prisma = {
    clientPurchase: { findMany: jest.fn(async () => [row]) },
    user: { findMany: jest.fn(async () => []) },
  };
  const feePolicy = { resolveHeadCoachId: jest.fn(async () => null) };
  const service: CoachClientPaymentsService = Reflect.construct(
    CoachClientPaymentsService,
    [prisma, stripe, {}, {}, feePolicy, { write: jest.fn() }],
  );
  return { service, stripe };
}

describe('FR-1191: failed-renewal plans stay live for the coach', () => {
  it.each([['past_due'], ['unpaid']])('%s: running, cancellable, pause refused', async (status) => {
    const { service, stripe } = build(status);
    const { plans } = await service.list(coach, CLIENT);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ status, billing: 'running', actions: { cancel: true, pause: false } });
    await expect(service.pause(coach, CLIENT, 'p1', KEY)).rejects.toMatchObject({
      response: { code: 'PLAN_PAYMENT_FAILED' },
    });
    expect(stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
  });

  it.each([['canceled'], ['incomplete_expired']])('%s with no payment is not listed as a live plan', async (status) => {
    const { service } = build(status);
    expect((await service.list(coach, CLIENT)).plans).toHaveLength(0);
  });
});
