// LO-1191 B1 (lens LO-1191 on b#1191 PF-5-BE): class 3, "every reader of a
// purchase's collection status counts unpaid as failed". When every Stripe try
// fails and Stripe leaves the subscription unpaid, the coach's client Payments
// page must still treat the plan as a live plan with a failed payment (the
// phone then says the latest payment did not go through), never "This plan has
// ended. Nothing more is charged." The brief and the Money card say access
// comes back when the client pays.
import 'reflect-metadata';
import type { User } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PrismaService } from '../src/prisma.service';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const at = (d: string) => new Date(`2026-10-0${d}T12:00:00Z`);

function unpaidPlan() {
  return {
    id: 'p1', client_user_id: CLIENT, coach_user_id: 'coach-a', package_id: 'pkg',
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring', status: 'unpaid',
    entitlement_active: true, access_expires_at: null, current_period_end: at('9'),
    cancel_at_period_end: false, canceled_at: null, last_error: 'card_declined', source: null,
    created_at: at('1'), updated_at: at('1'), stripe_subscription_id: 'sub_1',
    package: { name: 'Monthly coaching' },
    dunning: { status: 'active', last_failure_reason: 'card_declined' },
    settlements: [
      { stripe_charge_id: 'ch_1', currency: 'usd', gross_cents: 14900, refunded_cents: 0, dispute_withdrawn_cents: 0, created_at: at('1') },
    ],
    refunds: [],
  };
}

function build(rows: Array<ReturnType<typeof unpaidPlan>>) {
  const findMany = jest.fn(async ({ where }: { where: { client_user_id: string; id?: string } }) =>
    rows.filter((r) => r.client_user_id === where.client_user_id && (!where.id || r.id === where.id)),
  );
  const stripe = {
    retrieveSubscription: jest.fn(async () => ({ id: 'sub_1', status: 'unpaid', pause_collection: null })),
  };
  const make = <T extends object>(cls: { prototype: T }, value: object): T => Object.assign(Object.create(cls.prototype), value);
  return new CoachClientPaymentsService(
    make(PrismaService, { clientPurchase: { findMany }, user: { findMany: async () => [] } }),
    make(StripeConnectApiService, stripe),
    make(RefundDisputeHandlerService, {}),
    make(ClientBillingService, {}),
    make(FeePolicyService, { resolveHeadCoachId: jest.fn(async () => null) }),
    make(AuditService, { write: jest.fn(async () => undefined) }),
  );
}

const coachA = Object.assign(Object.create(null), { id: 'coach-a', role: 'coach' }) as User;

describe('LO-1191 B1 an unpaid plan is a failed payment, not an ended plan', () => {
  it('an unpaid recurring plan is not shown to its coach as ended', async () => {
    const { plans } = await build([unpaidPlan()]).list(coachA, CLIENT);
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('unpaid');
    expect(plans[0].billing).not.toBe('ended');
    expect(plans[0].billing).toBe('running');
    expect(plans[0].actions.cancel).toBe(true);
  });
});
