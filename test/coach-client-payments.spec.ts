// CF-COACH-PAY-BE-128 — coaches list a client's payments, refund, pause/resume
// and cancel recurring billing. Only the seller coach or the seller's head
// coach acts; everything is behind FEATURE_COACH_PAYMENT_ACTIONS (default off).
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { User } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { CoachClientPaymentsController } from '../src/checkout/coach-client-payments.controller';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';
import { CoachPaymentActionsFeatureGuard } from '../src/checkout/coach-payment-actions.feature';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { NoActiveSubCoachGuard } from '../src/common/guards/no-active-sub-coach.guard';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';
import { FeatureFlagsService } from '../src/feature-flags/feature-flags.service';
import { PrismaService } from '../src/prisma.service';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const at = (d: string) => new Date(`2026-10-0${d}T12:00:00Z`);

function plan(over: Record<string, unknown> = {}) {
  return {
    id: 'p1', client_user_id: CLIENT, coach_user_id: 'coach-a', package_id: 'pkg',
    amount_cents: 5000, currency: 'usd', billing_type: 'recurring', status: 'active',
    entitlement_active: true, access_expires_at: null, current_period_end: at('9'),
    cancel_at_period_end: false, canceled_at: null, last_error: null, source: null,
    created_at: at('1'), updated_at: at('1'), stripe_subscription_id: 'sub_1',
    package: { name: 'Monthly coaching' }, dunning: null,
    settlements: [
      { stripe_charge_id: 'ch_2', currency: 'usd', gross_cents: 5000, refunded_cents: 1000, dispute_withdrawn_cents: 0, created_at: at('5') },
      { stripe_charge_id: 'ch_1', currency: 'usd', gross_cents: 5000, refunded_cents: 0, dispute_withdrawn_cents: 0, created_at: at('1') },
    ],
    refunds: [
      { id: 'r2', stripe_charge_id: 'ch_2', amount_cents: 500, status: 'pending', initiated_by_user_id: 'admin', created_at: at('6') },
      { id: 'r1', stripe_charge_id: 'ch_2', amount_cents: 1000, status: 'succeeded', initiated_by_user_id: 'coach-a', created_at: at('6') },
    ],
    ...over,
  };
}

function build(rows: Array<ReturnType<typeof plan>>, paused = false) {
  const findMany = jest.fn(async ({ where }: { where: { client_user_id: string; id?: string } }) =>
    rows.filter((r) => r.client_user_id === where.client_user_id && (!where.id || r.id === where.id)),
  );
  const sub = (p: boolean) => ({ id: 'sub_1', status: 'active', pause_collection: p ? { behavior: 'void' } : null });
  const stripe = {
    retrieveSubscription: jest.fn(async () => sub(paused)),
    pauseSubscriptionCollection: jest.fn(async () => sub(true)),
    resumeSubscriptionCollection: jest.fn(async () => sub(false)),
  };
  const refunds = {
    createAdminRefund: jest.fn(async (a: { amount_cents?: number; charge_id?: string }) => ({
      id: 'r3', stripe_charge_id: a.charge_id, amount_cents: a.amount_cents, currency: 'usd', status: 'succeeded',
    })),
  };
  const billing = {
    cancelPlan: jest.fn(async () => ({
      outcome: 'scheduled' as const, purchase_id: 'p1', access_ends_at: at('9').toISOString(),
      voided_invoice_count: 0, voided_amount_cents: 0, currency: 'usd', paid_period_kept: false, message: 'client copy',
    })),
  };
  // sub-1 sells on head-1's team; coach-a and coach-b have no team.
  const feePolicy = { resolveHeadCoachId: jest.fn(async (seller: string) => (seller === 'sub-1' ? 'head-1' : null)) };
  const audit = { write: jest.fn(async () => undefined) };
  const make = <T extends object>(cls: { prototype: T }, value: object): T => Object.assign(Object.create(cls.prototype), value);
  const service = new CoachClientPaymentsService(
    make(PrismaService, { clientPurchase: { findMany } }),
    make(StripeConnectApiService, stripe),
    make(RefundDisputeHandlerService, refunds),
    make(ClientBillingService, billing),
    make(FeePolicyService, feePolicy),
    make(AuditService, audit),
  );
  return { service, stripe, refunds, billing, audit };
}

const user = (id: string): User => Object.assign(Object.create(null), { id, role: 'coach' });
const A = user('coach-a');

describe('CF-COACH-PAY-BE-128 coach client payments', () => {
  it('lists per-payment refundable amounts net of refunds in flight, and reads the Stripe pause', async () => {
    const w = build([plan(), plan({ id: 'p2', coach_user_id: 'coach-b' })], true);
    const { plans } = await w.service.list(A, CLIENT);
    expect(plans.map((p) => p.purchase_id)).toEqual(['p1']);
    expect(plans[0].billing).toBe('paused');
    expect(plans[0].actions).toEqual({ refund: true, pause: false, resume: true, cancel: true, restart: false });
    expect(plans[0].payments[0]).toEqual(expect.objectContaining({
      charge_id: 'ch_2', amount_cents: 5000, refunded_cents: 1000, refundable_cents: 3500,
    }));
    expect(plans[0].payments[0].refunds.map((r) => r.by_you)).toEqual([false, true]);
    expect(JSON.stringify(plans)).not.toMatch(/sub_1|secret|idempotency/);
  });

  it('the head coach of the seller may act; any other coach gets 404 and nothing reaches Stripe', async () => {
    const w = build([plan({ coach_user_id: 'sub-1' })]);
    expect((await w.service.list(user('head-1'), CLIENT)).plans).toHaveLength(1);
    expect((await w.service.list(user('coach-b'), CLIENT)).plans).toHaveLength(0);
    for (const act of [
      () => w.service.refund(user('coach-b'), CLIENT, 'p1', { idempotency_key: KEY }),
      () => w.service.pause(user('coach-b'), CLIENT, 'p1', KEY),
      () => w.service.cancel(user('coach-b'), CLIENT, 'p1', KEY),
    ]) {
      await expect(act()).rejects.toMatchObject({ status: 404, response: { code: 'PLAN_NOT_FOUND' } });
    }
    expect(w.refunds.createAdminRefund).not.toHaveBeenCalled();
    expect(w.stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
    expect(w.billing.cancelPlan).not.toHaveBeenCalled();
  });

  it('refunds the named payment under a per-tap key and audits it; over-refunds are refused first', async () => {
    const w = build([plan()]);
    const res = await w.service.refund(A, CLIENT, 'p1', { idempotency_key: KEY, charge_id: 'ch_2', amount_cents: 2000 });
    expect(w.refunds.createAdminRefund).toHaveBeenCalledWith(expect.objectContaining({
      purchase_id: 'p1', charge_id: 'ch_2', amount_cents: 2000, initiated_by_user_id: 'coach-a',
      reason: 'requested_by_customer', idempotency_key: `tgp-coach-refund-p1-${KEY}`,
    }));
    expect(res.refund).toEqual({ id: 'r3', charge_id: 'ch_2', amount_cents: 2000, currency: 'usd', status: 'succeeded' });
    expect(w.audit.write).toHaveBeenCalledWith(expect.objectContaining({
      action: 'coach_payments.refund_issued', actorId: 'coach-a', targetUserId: CLIENT, targetId: 'p1', tenantCoachId: 'coach-a',
    }));
    await expect(w.service.refund(A, CLIENT, 'p1', { idempotency_key: KEY, charge_id: 'ch_2', amount_cents: 3501 }))
      .rejects.toMatchObject({ status: 409, response: { code: 'REFUND_AMOUNT_TOO_LARGE' } });
    await expect(w.service.refund(A, CLIENT, 'p1', { idempotency_key: KEY, charge_id: 'ch_other' }))
      .rejects.toMatchObject({ status: 404, response: { code: 'PAYMENT_NOT_FOUND' } });
    await w.service.refund(A, CLIENT, 'p1', { idempotency_key: KEY, charge_id: 'ch_1' });
    expect(w.refunds.createAdminRefund).toHaveBeenLastCalledWith(expect.objectContaining({ charge_id: 'ch_1', amount_cents: 5000 }));
    expect(w.refunds.createAdminRefund).toHaveBeenCalledTimes(2);
  });

  it('a Stripe refusal reads as STRIPE_REFUSED and writes no audit row', async () => {
    const w = build([plan()]);
    w.refunds.createAdminRefund.mockRejectedValueOnce(new StripeConnectApiError('no', 400, 'charge_already_refunded', 'invalid_request_error'));
    await expect(w.service.refund(A, CLIENT, 'p1', { idempotency_key: KEY })).rejects.toMatchObject({
      status: 409, response: { code: 'STRIPE_REFUSED' },
    });
    expect(w.audit.write).not.toHaveBeenCalled();
  });

  it('pause and resume send keyed Stripe calls; refund/dispute pauses and failed payments are refused', async () => {
    const w = build([plan()]);
    const paused = await w.service.pause(A, CLIENT, 'p1', KEY);
    expect(w.stripe.pauseSubscriptionCollection).toHaveBeenCalledWith({ subscriptionId: 'sub_1', idempotencyKey: `tgp-coach-pause-p1-${KEY}` });
    expect(paused.plan.billing).toBe('paused');
    expect(w.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'coach_payments.billing_paused' }));

    const p = build([plan()], true);
    expect((await p.service.resume(A, CLIENT, 'p1', KEY)).plan.billing).toBe('running');
    expect(p.stripe.resumeSubscriptionCollection).toHaveBeenCalledWith({ subscriptionId: 'sub_1', idempotencyKey: `tgp-coach-resume-p1-${KEY}` });

    const r = build([plan({ status: 'refunded', dunning: { status: 'active', last_failure_reason: 'charge_refunded' } })]);
    await expect(r.service.resume(A, CLIENT, 'p1', KEY)).rejects.toMatchObject({ response: { code: 'PLAN_PAUSED_BY_REFUND_OR_DISPUTE' } });
    expect((await r.service.list(A, CLIENT)).plans[0].actions.restart).toBe(true);
    const d = build([plan({ status: 'past_due' })]);
    await expect(d.service.pause(A, CLIENT, 'p1', KEY)).rejects.toMatchObject({ response: { code: 'PLAN_PAYMENT_FAILED' } });
    expect(r.stripe.resumeSubscriptionCollection).not.toHaveBeenCalled();
    expect(d.stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
  });

  it('cancel runs the client cancel path for that client and plan, with coach copy and an audit row', async () => {
    const w = build([plan()]);
    const res = await w.service.cancel(A, CLIENT, 'p1', KEY);
    expect(w.billing.cancelPlan).toHaveBeenCalledWith(CLIENT, 'p1');
    expect(res.outcome).toBe('scheduled');
    expect(res.message).toMatch(/^Billing stops at the end of the current period/);
    expect(w.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'coach_payments.plan_canceled' }));
    const done = build([plan({ status: 'canceled', settlements: [] })]);
    await expect(done.service.cancel(A, CLIENT, 'p1', KEY)).rejects.toMatchObject({ response: { code: 'ACTION_NOT_AVAILABLE' } });
  });

  describe('flag (default off)', () => {
    const saved = process.env.FEATURE_COACH_PAYMENT_ACTIONS;
    afterEach(() => {
      if (saved === undefined) delete process.env.FEATURE_COACH_PAYMENT_ACTIONS;
      else process.env.FEATURE_COACH_PAYMENT_ACTIONS = saved;
    });

    it('every route is 404 unless the flag is exactly "true"; the flag map reads it for coaches only', () => {
      const guard = new CoachPaymentActionsFeatureGuard();
      const flags = new FeatureFlagsService();
      for (const v of [undefined, 'false', 'TRUE', '1']) {
        if (v === undefined) delete process.env.FEATURE_COACH_PAYMENT_ACTIONS;
        else process.env.FEATURE_COACH_PAYMENT_ACTIONS = v;
        expect(() => guard.canActivate()).toThrow('Not Found');
        expect(flags.evaluate({ userId: 'c', role: 'coach' }).coach_payment_actions).toBe(false);
      }
      process.env.FEATURE_COACH_PAYMENT_ACTIONS = 'true';
      expect(guard.canActivate()).toBe(true);
      expect(flags.evaluate({ userId: 'c', role: 'coach' }).coach_payment_actions).toBe(true);
      expect(flags.evaluate({ userId: 's', role: 'student' }).coach_payment_actions).toBe(false);
    });

    it('the controller mounts the flag guard and blocks active sub-coaches', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, CoachClientPaymentsController);
      expect(guards).toEqual(expect.arrayContaining([CoachPaymentActionsFeatureGuard, NoActiveSubCoachGuard]));
    });
  });
});
