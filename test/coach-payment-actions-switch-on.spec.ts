// PAYREADY (agent 149): the coach payment actions end to end with FEATURE_COACH_PAYMENT_ACTIONS=true.
// A coach refunds (part, then all), pauses, resumes and cancels a client's payment through the
// controller's own guard chain and the app's ValidationPipe settings, the real coach payments,
// refund, settlement, payout notice and billing services, and the real Stripe client: only its
// HTTP boundary (`fetchImpl`) and the settlement fakes' charge/transfer reads are synthetic.
// 4,900 sale, 172 Stripe fee, TGP 2% = 98, coach paid 4,630 (owner ruling: TGP takes 2% of GMV).
import 'reflect-metadata';
import { ForbiddenException, ParseUUIDPipe, ValidationPipe, type CanActivate, type ExecutionContext, type HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ClientPurchase, CoachPackage, User } from '@prisma/client';
import type { AuthedRequest } from '../src/auth/auth-request';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { AuditService } from '../src/audit/audit.service';
import type { AppRole } from '../src/common/decorators/roles.decorator';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { CoachClientPaymentsController, CoachPaymentActionDto, CoachRefundDto } from '../src/checkout/coach-client-payments.controller';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';
import { CoachPaymentActionsFeatureGuard } from '../src/checkout/coach-payment-actions.feature';
import { FULL_REFUND_PAUSE_REASON, type DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { planView } from '../src/checkout/subscription-plan';
import { CoachOrOwnerGuard } from '../src/common/guards/coach-or-owner.guard';
import { NoActiveSubCoachGuard } from '../src/common/guards/no-active-sub-coach.guard';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { EmailService } from '../src/email/email.service';
import { FeatureFlagsService } from '../src/feature-flags/feature-flags.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { NotificationsService } from '../src/notifications/notifications.service';
import type { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import type { PartialRefundDecisionService } from '../src/regimes/partial-refund-decision.service';
import { FakeStripe, Table, asPrisma, makeCharge, makeSettlementPrisma, type Row } from './utils/settlement-fakes';

const id = (n: number) => `00000000-0000-4000-8000-00000000014${n}`;
const [COACH, HEAD, SUB, OTHER, CLIENT, OWNER] = [1, 2, 3, 4, 5, 6].map(id);
const [PLAN, ONE] = ['a', 'b'].map((x) => `00000000-0000-4000-8000-0000000149${x}0`);
const PERIOD_END = new Date('2026-11-15T00:00:00.000Z');
const PKG: object = { id: 'pkg_1', name: 'Monthly coaching', billing_type: 'recurring', interval: 'month', interval_count: 1 };
const key = (n: number) => `00000000-0000-4000-8000-0000001490${n}0`;
const person = (userId: string, role: string): User => {
  const u: object = { id: userId, role };
  return u as User;
};

type Sent = { method: string; path: string; form: Record<string, string>; headers: Record<string, string> };

/** The settlement Stripe fake plus Stripe's HTTP API for refunds and subscriptions (keys replay). */
class PayStripe extends FakeStripe {
  sent: Sent[] = [];
  subs = new Map<string, Row>();
  private replies = new Map<string, Row>();
  protected fetchImpl: typeof fetch = async (input, init) => {
    const headers = { ...(init?.headers as Record<string, string>) };
    const sent = { method: init?.method ?? 'GET', path: new URL(String(input)).pathname, headers,
      form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) };
    this.sent.push(sent);
    const idem = headers['Idempotency-Key'];
    const body = (idem && this.replies.get(idem)) || this.answer(sent);
    if (idem) this.replies.set(idem, body);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  private answer({ method, path, form }: Sent): Row {
    if (path === '/v1/refunds') {
      const charge = this.charges.get(form.charge)!;
      const amount = Number(form.amount ?? charge.amount - (charge.amount_refunded ?? 0));
      const refund = { id: `re_${this.sent.length}`, object: 'refund', amount, currency: 'usd', charge: charge.id, status: 'succeeded' };
      this.refundsByCharge.set(charge.id, [refund, ...(this.refundsByCharge.get(charge.id) ?? [])]);
      const refunded = (charge.amount_refunded ?? 0) + amount;
      this.charges.set(charge.id, { ...charge, amount_refunded: refunded, refunded: refunded >= charge.amount });
      return refund;
    }
    const sub = this.subs.get(decodeURIComponent(path.replace('/v1/subscriptions/', '')))!;
    if (method === 'POST' && 'pause_collection[behavior]' in form) sub.pause_collection = { behavior: form['pause_collection[behavior]'] };
    if (method === 'POST' && form.pause_collection === '') sub.pause_collection = null;
    if (method === 'POST' && form.cancel_at_period_end === 'true') sub.cancel_at_period_end = true;
    return { ...sub };
  }
}

async function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const dunning: Row[] = [];
  const audit = new Table([], { prefix: 'al' });
  Object.assign(prisma, {
    user: new Table([{ id: COACH, email: 'payee@example.invalid', name: null }], { prefix: 'u' }),
    emailSendLog: new Table([], { prefix: 'em' }),
    auditLog: audit,
    clientBillingOperation: new Table([], { prefix: 'cbo' }),
  });
  const stripe = new PayStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const fee = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  const fns = {
    createNotification: jest.fn(async (..._a: unknown[]): Promise<{ id: string } | null> => ({ id: 'n_1' })),
    channelGate: jest.fn(async (..._a: unknown[]) => 'enabled'),
    pushToUser: jest.fn(async (..._a: unknown[]) => ({ delivered: true, code: 'delivered' })),
    send: jest.fn(async (..._a: unknown[]) => ({ status: 'sent' })),
  };
  const stub: object = fns;
  const fanout: object = { cancelPendingForPurchase: jest.fn(async (..._a: unknown[]) => 0) };
  const decisions: object = { onPartialRefund: jest.fn(async (..._a: unknown[]) => undefined) };
  // The billing pause itself (DunningState + Stripe) is DunningV2Service's own spec
  // (test/money-refund-124.spec.ts); here it records the pause the coach view reads.
  const pauseAfterFullRefund = jest.fn(async (purchaseId: string) => {
    dunning.push({ purchase_id: purchaseId, status: 'active', last_failure_reason: FULL_REFUND_PAUSE_REASON });
  });
  const dunningV2: object = { pauseAfterFullRefund };
  const notices = new PayoutNoticeService(asPrisma(prisma), stub as NotificationsService, stub as EmailService);
  const refunds = new RefundDisputeHandlerService(asPrisma(prisma), stripe, ledger, transfers,
    new PayoutReadinessService(asPrisma(prisma), stripe), stub as NotificationsService, fanout as PurchaseFanoutService,
    decisions as PartialRefundDecisionService, settlements, notices, dunningV2 as DunningV2Service);
  const router = new CheckoutWebhookHandlerService(asPrisma(prisma), stripe, undefined, undefined, refunds);
  // Prisma's nested select of the coach view (package, dunning, settlements, refunds), joined from the same rows.
  const newest = (rows: Row[]) => [...rows].sort((a, b) => b.created_at - a.created_at);
  const plans = prisma.clientPurchase;
  const coachDb = { ...prisma, clientPurchase: { ...plans, findMany: async (args: Row) => (await plans.findMany(args)).map((r) => ({
    ...r, package: { name: 'Monthly coaching' }, dunning: dunning.find((d) => d.purchase_id === r.id) ?? null,
    settlements: newest(db.settlements.filter((s) => s.purchase_id === r.id)),
    refunds: newest(db.refunds.filter((f) => f.purchase_id === r.id)) })) } };
  const service = new CoachClientPaymentsService(asPrisma(coachDb), stripe, refunds,
    new ClientBillingService(asPrisma(prisma), stripe), fee, new AuditService(asPrisma(prisma)));
  const controller = new CoachClientPaymentsController(service);
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_1' });
  db.assignments.push({ id: 'tsa_1', sub_coach_id: SUB, head_coach_id: HEAD, archived_at: null, created_at: new Date() });
  for (const [pid, billing_type] of [[PLAN, 'recurring'], [ONE, 'one_time']]) {
    const recurring = billing_type === 'recurring';
    db.purchases.push({ id: pid, coach_user_id: COACH, client_user_id: CLIENT, package_id: 'pkg_1', amount_cents: 4_900,
      currency: 'usd', billing_type, status: recurring ? 'active' : 'paid', source: null, entitlement_active: true,
      stripe_payment_intent_id: null, stripe_subscription_id: recurring ? 'sub_plan' : null, checkout_terms: null,
      cancel_at_period_end: false, current_period_end: recurring ? PERIOD_END : null, access_expires_at: null,
      canceled_at: null, trial_days: null, created_at: new Date(), updated_at: new Date() });
    const charge = `ch_${billing_type}`;
    stripe.charges.set(charge, makeCharge({ id: charge, amount: 4_900, fee: 172 }));
    await settlements.settleCharge({ purchase: db.purchases[db.purchases.length - 1] as ClientPurchase, charge_id: charge });
  }
  stripe.subs.set('sub_plan', { id: 'sub_plan', object: 'subscription', status: 'active', pause_collection: null,
    cancel_at_period_end: false, current_period_end: PERIOD_END.getTime() / 1000 });
  const signedIn: CanActivate = { canActivate: () => true }; // req.user is set; JWT checks are the auth module's spec
  const live = new Map<unknown, CanActivate>([
    [CoachPaymentActionsFeatureGuard, new CoachPaymentActionsFeatureGuard()], [JwtAuthGuard, signedIn],
    [CoachOrOwnerGuard, new CoachOrOwnerGuard()], [NoActiveSubCoachGuard, new NoActiveSubCoachGuard(asPrisma(prisma))]]);
  const chain: unknown[] = Reflect.getMetadata(GUARDS_METADATA, CoachClientPaymentsController);
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }); // as src/main.ts
  const uuid = new ParseUUIDPipe();
  /** One request: guard chain in declared order, param and body pipes, then the handler. */
  async function call(user: User, route: 'list' | 'refund' | 'pause' | 'resume' | 'cancel', purchaseId = PLAN, body: Row = {}) {
    const request: object = { user };
    const req = request as AuthedRequest;
    const ctx: object = { switchToHttp: () => ({ getRequest: () => req }) };
    for (const g of chain) {
      if (!(await live.get(g)!.canActivate(ctx as ExecutionContext))) throw new ForbiddenException();
    }
    const clientId: string = await uuid.transform(CLIENT, { type: 'param' });
    if (route === 'list') return controller.list(req, clientId);
    const pid: string = await uuid.transform(purchaseId, { type: 'param' });
    const dto = await pipe.transform(body, { type: 'body', metatype: route === 'refund' ? CoachRefundDto : CoachPaymentActionDto });
    return controller[route](req, clientId, pid, dto);
  }
  const plan = (pid = PLAN) => db.purchases.find((p) => p.id === pid) as ClientPurchase;
  const settlement = (charge: string) => db.settlements.find((s) => s.stripe_charge_id === charge)!;
  const noticeFor = (charge: string) => (db.notices ?? []).filter((n) => n.stripe_charge_id === charge);
  const audits = () => audit.rows.map((r) => r.action);
  const stripeWrites = () => stripe.sent.filter((s) => s.method === 'POST');
  const chargeRefunded = (charge: string) => {
    const data = stripe.refundsByCharge.get(charge) ?? [];
    return { id: `evt_${charge}_${data.length}`, type: 'charge.refunded', data: { object: { id: charge, amount: 4_900,
      amount_refunded: data.reduce((n, r) => n + r.amount, 0), refunds: { data, has_more: false } } } };
  };
  return { db, stripe, fns, pauseAfterFullRefund, router, chain, call, plan, settlement, noticeFor, audits, stripeWrites, chargeRefunded };
}

const coach = person(COACH, 'coach');
const refusal = (p: Promise<unknown>) =>
  p.then(() => { throw new Error('expected a refusal'); }, (e: HttpException) => ({ status: e.getStatus(), body: e.getResponse() }));

const saved = { flag: process.env.FEATURE_COACH_PAYMENT_ACTIONS, key: process.env.STRIPE_SECRET_KEY };
beforeEach(() => {
  process.env.FEATURE_COACH_PAYMENT_ACTIONS = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_payready_synthetic';
});
afterAll(() => {
  for (const [name, value] of [['FEATURE_COACH_PAYMENT_ACTIONS', saved.flag], ['STRIPE_SECRET_KEY', saved.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('PAYREADY: the switch and who may act', () => {
  it('off, every route is a 404; on, /me/feature-flags shows coach_payment_actions to coaches and the owner only', async () => {
    const c = await setup();
    expect(c.chain).toEqual([CoachPaymentActionsFeatureGuard, JwtAuthGuard, CoachOrOwnerGuard, NoActiveSubCoachGuard]);
    const flags = new FeatureFlagsService();
    const shown = (role: AppRole) => flags.evaluate({ userId: COACH, role }).coach_payment_actions;
    expect([shown('coach'), shown('owner'), shown('student')]).toEqual([true, true, false]);
    process.env.FEATURE_COACH_PAYMENT_ACTIONS = 'TRUE';
    for (const route of ['list', 'refund', 'pause', 'resume', 'cancel'] as const) {
      expect(await refusal(c.call(coach, route, PLAN, { idempotency_key: key(1) }))).toMatchObject({ status: 404 });
    }
    expect(shown('coach')).toBe(false);
    expect(c.stripe.sent).toEqual([]);
  });

  it('a sub-coach gets 403 sub_coach_billing_blocked, a client 403, another coach 404; bad bodies 400; Stripe untouched', async () => {
    const c = await setup();
    const body = { idempotency_key: key(1) };
    expect(await refusal(c.call(person(SUB, 'coach'), 'refund', PLAN, body))).toMatchObject({ status: 403, body: { kind: 'sub_coach_billing_blocked' } });
    expect(await refusal(c.call(person(CLIENT, 'student'), 'pause', PLAN, body))).toMatchObject({ status: 403 });
    expect(await refusal(c.call(person(OTHER, 'coach'), 'cancel', PLAN, body))).toMatchObject({ status: 404, body: { code: 'PLAN_NOT_FOUND' } });
    expect(await c.call(person(OTHER, 'coach'), 'list')).toEqual({ plans: [] });
    for (const bad of [{}, { idempotency_key: 'tap-1' }, { ...body, amount_cents: 0 }, { ...body, amount_cents: 10.5 }, { ...body, coach_id: OTHER }]) {
      expect(await refusal(c.call(coach, 'refund', PLAN, bad))).toMatchObject({ status: 400 });
    }
    expect(await c.call(person(OWNER, 'owner'), 'list')).toEqual({ plans: [] }); // the owner passes the guards; sees only own sales
    expect(c.stripeWrites()).toEqual([]);
    expect(c.db.refunds).toEqual([]);
  });
});

describe('PAYREADY: refund', () => {
  it('partial: 1,000 back on the platform account, the payout drops by exactly 1,000, TGP keeps its 98, access stays; a retried tap and the webhook move nothing more', async () => {
    const c = await setup();
    const paid = c.stripe.netTo('acct_1');
    const body = { idempotency_key: key(1), amount_cents: 1_000 };
    const res = await c.call(coach, 'refund', PLAN, body);
    const [write] = c.stripeWrites();
    expect(write).toMatchObject({ path: '/v1/refunds', headers: { 'Idempotency-Key': `tgp-coach-refund-${PLAN}-${key(1)}` },
      form: { charge: 'ch_recurring', amount: '1000', reason: 'requested_by_customer', 'metadata[tgp_initiated_by]': COACH } });
    expect(write.form).not.toHaveProperty('reverse_transfer');
    expect(write.form).not.toHaveProperty('refund_application_fee');
    expect(c.stripe.sent.every((s) => !('Stripe-Account' in s.headers))).toBe(true);
    expect(c.db.refunds).toEqual([expect.objectContaining({ purchase_id: PLAN, amount_cents: 1_000, status: 'succeeded',
      initiated_by_user_id: COACH, ledger_reversed: true })]);
    expect(c.settlement('ch_recurring')).toMatchObject({ refunded_cents: 1_000, target_platform_fee_cents: 98 });
    expect(paid - c.stripe.netTo('acct_1')).toBe(1_000);
    expect(c.plan()).toMatchObject({ status: 'active', entitlement_active: true });
    expect(res).toMatchObject({ refund: { amount_cents: 1_000, status: 'succeeded', charge_id: 'ch_recurring' },
      plan: { billing: 'running', payments: [{ charge_id: 'ch_recurring', refunded_cents: 1_000, refundable_cents: 3_900 }] } });
    expect(c.audits()).toEqual(['coach_payments.refund_issued']);
    await c.call(coach, 'refund', PLAN, body); // the same tap again (lost reply): Stripe replays its answer
    await c.router.handle(c.chargeRefunded('ch_recurring'));
    expect(c.db.refunds).toHaveLength(1);
    expect(paid - c.stripe.netTo('acct_1')).toBe(1_000);
    expect(c.noticeFor('ch_recurring')).toEqual([expect.objectContaining({ payee_user_id: COACH, reversed_cents: 1_000, held_cents: 0, inapp_status: 'sent' })]);
  });

  it('full, one-time: 4,900 back, the 4,630 payout reversed, 270 held from the next sale (TGP 2% 98 + Stripe 172), access ends', async () => {
    const c = await setup();
    const paid = c.stripe.netTo('acct_1');
    await c.call(coach, 'refund', ONE, { idempotency_key: key(2) });
    expect(c.stripeWrites()).toEqual([expect.objectContaining({ path: '/v1/refunds', form: expect.objectContaining({ charge: 'ch_one_time', amount: '4900' }) })]);
    expect(paid - c.stripe.netTo('acct_1')).toBe(4_630);
    expect(c.settlement('ch_one_time')).toMatchObject({ refunded_cents: 4_900, target_platform_fee_cents: 98, target_coach_net_cents: -270 });
    expect(c.db.recoveries).toEqual([expect.objectContaining({ payee_user_id: COACH, amount_cents: 270, reason: 'refund', status: 'open' })]);
    expect(c.noticeFor('ch_one_time')).toEqual([expect.objectContaining({ reversed_cents: 4_630, held_cents: 270, held_tgp_fee_cents: 98, held_stripe_fee_cents: 172 })]);
    expect(c.plan(ONE)).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(await refusal(c.call(coach, 'refund', ONE, { idempotency_key: key(3) }))).toMatchObject({ status: 409, body: { code: 'REFUND_AMOUNT_TOO_LARGE' } });
  });

  it('full, monthly: billing is paused (never canceled), access ends, the client is told and only the selling coach may restart', async () => {
    const c = await setup();
    const res = await c.call(coach, 'refund', PLAN, { idempotency_key: key(4) });
    expect(c.pauseAfterFullRefund).toHaveBeenCalledWith(PLAN);
    expect(c.stripeWrites().map((w) => w.path)).toEqual(['/v1/refunds']);
    expect(c.plan()).toMatchObject({ status: 'refunded', entitlement_active: false, cancel_at_period_end: false });
    expect(c.fns.createNotification).toHaveBeenCalledWith(expect.objectContaining({ user_id: CLIENT, kind: NotificationKind.DUNNING_BLOCKER }));
    expect(res).toMatchObject({ plan: { billing: 'paused_by_refund_or_dispute', actions: { restart: true, pause: false, resume: false } } });
  });
});

describe('PAYREADY: pause, resume and cancel', () => {
  it('pause voids invoices while paused and the client keeps access; resume bills again; replays send nothing new', async () => {
    const c = await setup();
    const paused = await c.call(coach, 'pause', PLAN, { idempotency_key: key(5) });
    expect(c.stripeWrites()).toEqual([expect.objectContaining({ path: '/v1/subscriptions/sub_plan',
      form: { 'pause_collection[behavior]': 'void' }, headers: expect.objectContaining({ 'Idempotency-Key': `tgp-coach-pause-${PLAN}-${key(5)}` }) })]);
    expect(paused).toMatchObject({ plan: { billing: 'paused', actions: { pause: false, resume: true, cancel: true } } });
    expect(c.plan()).toMatchObject({ status: 'active', entitlement_active: true });
    await c.call(coach, 'pause', PLAN, { idempotency_key: key(6) });
    expect(c.stripeWrites()).toHaveLength(1);
    const resumed = await c.call(coach, 'resume', PLAN, { idempotency_key: key(7) });
    expect(c.stripeWrites()[1]).toMatchObject({ form: { pause_collection: '' }, headers: { 'Idempotency-Key': `tgp-coach-resume-${PLAN}-${key(7)}` } });
    expect(resumed).toMatchObject({ plan: { billing: 'running', actions: { pause: true, resume: false } } });
    expect(c.audits()).toEqual(['coach_payments.billing_paused', 'coach_payments.billing_resumed']);
    expect(c.stripe.sent.every((s) => !('Stripe-Account' in s.headers))).toBe(true);
  });

  it('cancel: billing stops at the period end, the client keeps the paid period and sees no next charge, nothing is refunded', async () => {
    const c = await setup();
    const res = await c.call(coach, 'cancel', PLAN, { idempotency_key: key(8) });
    const [write] = c.stripeWrites();
    expect(write).toMatchObject({ path: '/v1/subscriptions/sub_plan', form: { cancel_at_period_end: 'true', proration_behavior: 'none' } });
    expect(write.headers['Idempotency-Key']).toMatch(/^tgp-cancel-ape-sub_plan-/);
    expect(res).toMatchObject({ outcome: 'scheduled', access_ends_at: PERIOD_END.toISOString(),
      plan: { cancel_at_period_end: true, actions: { cancel: false, pause: false } } });
    expect(planView(c.plan(), PKG as CoachPackage)).toMatchObject({ state: 'active', next_charge_at: null,
      access_ends_at: PERIOD_END.toISOString(), can_resume: true });
    expect(c.audits()).toEqual(['coach_payments.plan_canceled']);
    expect(c.db.refunds).toEqual([]);
    expect(await refusal(c.call(coach, 'cancel', PLAN, { idempotency_key: key(9) }))).toMatchObject({ status: 409, body: { code: 'ACTION_NOT_AVAILABLE' } });
  });

  // Open findings (own PRs, report ops149/reports/PAYREADY.md). Each asserts the right outcome and is
  // expected to fail on main; when its fix lands this flips red and becomes a plain `it`.
  it.failing('OPEN B1: while a coach has billing paused, the client plan names no next charge', async () => {
    const c = await setup();
    await c.call(coach, 'pause', PLAN, { idempotency_key: key(5) });
    expect(planView(c.plan(), PKG as CoachPackage).next_charge_at).toBeNull();
  });

  it.failing('OPEN B2: the client is told in the app when their coach pauses or cancels their billing', async () => {
    const c = await setup();
    await c.call(coach, 'pause', PLAN, { idempotency_key: key(5) });
    expect(c.fns.createNotification).toHaveBeenCalledWith(expect.objectContaining({ user_id: CLIENT }));
  });
});
