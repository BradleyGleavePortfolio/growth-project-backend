import 'reflect-metadata';
import type { User } from '@prisma/client';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';

describe('LS-1191 B3: coach client payments keep unpaid plans visible and cancellable', () => {
  it.each([
    ['past_due', true],
    ['unpaid', true],
    ['unpaid', false],
  ])(
    'LS-1191 B3: %s remains a live billing plan (earlier settled charge: %s)',
    async (status, previouslyPaid) => {
      const at = new Date('2026-10-30T09:00:00Z');
      const row = {
        id: 'review-purchase', coach_user_id: 'review-coach',
        client_user_id: 'review-client', package_id: 'review-package',
        amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
        status, stripe_subscription_id: 'review-subscription',
        created_at: at, current_period_end: at, access_expires_at: at,
        cancel_at_period_end: false, entitlement_active: true,
        package: { name: 'Monthly coaching' }, dunning: null, refunds: [],
        settlements: previouslyPaid ? [{
          stripe_charge_id: 'review-charge', currency: 'usd',
          gross_cents: 14900, refunded_cents: 0,
          dispute_withdrawn_cents: 0, created_at: at,
        }] : [],
      };
      const prisma = {
        clientPurchase: { findMany: jest.fn(async () => [row]) },
        user: { findMany: jest.fn(async () => []) },
      };
      const stripe = {
        retrieveSubscription: jest.fn(async () => ({ status, pause_collection: null })),
      };
      const service: CoachClientPaymentsService = Reflect.construct(
        CoachClientPaymentsService,
        [prisma, stripe, {}, {}, {}, {}],
      );
      const result = await service.list({ id: 'review-coach', role: 'coach' } as User, 'review-client');
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0]).toMatchObject({
        status, billing: 'running', actions: { cancel: true },
      });
    },
  );
});
