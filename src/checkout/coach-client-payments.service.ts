import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ChargeRefund, Prisma, User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
  type StripeSubscriptionObject,
} from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';
import {
  ClientBillingService,
  type CancelOutcome,
  type CancelPlanResult,
} from './client-billing.service';
import type { CoachRefundDto } from './coach-client-payments.controller';
import { COACH_PURCHASE_SELECT } from './coach-payments.select';
import { isBillingPauseReason } from './dunning-v2/dunning-v2.service';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';

// CF-COACH-PAY-BE-128: a coach's payments view of one client, with refund,
// pause/resume and cancel. Only the coach who sold the plan, or the head
// coach of that coach's team, sees or acts on it; anything else is a 404.
// Refunds reuse the admin refund path (platform-account refund, transfer
// reversal, fee recovery, ledger and the full-refund billing pause).

const PLAN_SELECT = {
  ...COACH_PURCHASE_SELECT,
  stripe_subscription_id: true,
  package: { select: { name: true } },
  dunning: { select: { status: true, last_failure_reason: true } },
  settlements: {
    orderBy: { created_at: 'desc' },
    select: {
      stripe_charge_id: true,
      currency: true,
      gross_cents: true,
      refunded_cents: true,
      dispute_withdrawn_cents: true,
      created_at: true,
    },
  },
  refunds: {
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      stripe_charge_id: true,
      amount_cents: true,
      status: true,
      initiated_by_user_id: true,
      created_at: true,
    },
  },
} as const satisfies Prisma.ClientPurchaseSelect;
type PlanRow = Prisma.ClientPurchaseGetPayload<{ select: typeof PLAN_SELECT }>;

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
const IN_FLIGHT_REFUND = new Set(['pending', 'requires_action']);
const PLAN_LIMIT = 50;

export type CoachPlanBilling =
  'one_time' | 'running' | 'paused' | 'paused_by_refund_or_dispute' | 'ended' | 'unknown';
export type CoachClientPlanView = ReturnType<typeof planView>;
type Action = 'refund' | 'pause' | 'resume' | 'cancel';

const NOT_ALLOWED: Record<Exclude<Action, 'refund'>, string> = {
  pause: 'Only an active plan that is billing normally can be paused.',
  resume: 'This plan is not paused, so there is nothing to resume.',
  cancel: 'This plan has no billing left to cancel.',
};
const CANCEL_COPY: Record<CancelOutcome, string> = {
  scheduled:
    'Billing stops at the end of the current period. The client keeps access until then and is not charged again.',
  ended: 'The plan ended now. Open invoices were voided, so nothing more is charged.',
  already_ended: 'This plan had already ended. Nothing was changed.',
};

function coded(code: string, message: string) {
  return { code, error: code, message };
}

@Injectable()
export class CoachClientPaymentsService {
  private readonly logger = new Logger(CoachClientPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
    private readonly refunds: RefundDisputeHandlerService,
    private readonly billing: ClientBillingService,
    private readonly feePolicy: FeePolicyService,
    private readonly auditLog: AuditService,
  ) {}

  async list(actor: User, clientId: string) {
    const rows = await this.scopedRows(actor, clientId);
    const shown = rows.filter(
      (r) => r.settlements.length > 0 || LIVE_STATUSES.has(r.status) || isRefundOrDisputePaused(r),
    );
    return { plans: await Promise.all(shown.map((r) => this.view(actor, r))) };
  }

  async refund(actor: User, clientId: string, purchaseId: string, input: CoachRefundDto) {
    const row = await this.scopedRow(actor, clientId, purchaseId);
    const payments = paymentsOf(row, actor.id);
    const payment = input.charge_id
      ? payments.find((p) => p.charge_id === input.charge_id)
      : payments[0];
    if (!payment) {
      throw new NotFoundException(
        coded(
          'PAYMENT_NOT_FOUND',
          'That payment is not on this plan, so nothing was refunded. Pull down to refresh.',
        ),
      );
    }
    const amount = input.amount_cents ?? payment.refundable_cents;
    if (payment.refundable_cents <= 0 || amount > payment.refundable_cents) {
      throw new ConflictException(
        coded(
          'REFUND_AMOUNT_TOO_LARGE',
          'That amount is more than is left to refund on this payment, so nothing was refunded. Pull down to refresh.',
        ),
      );
    }
    let created: ChargeRefund;
    try {
      created = await this.refunds.createAdminRefund({
        purchase_id: row.id,
        amount_cents: amount,
        reason: input.reason ?? 'requested_by_customer',
        note: input.note ?? null,
        initiated_by_user_id: actor.id,
        charge_id: payment.charge_id,
        idempotency_key: `tgp-coach-refund-${row.id}-${input.idempotency_key}`,
      });
    } catch (err) {
      throw this.failure(err, 'refund');
    }
    const refund = {
      id: created.id,
      charge_id: payment.charge_id,
      amount_cents: created.amount_cents,
      currency: payment.currency,
      status: created.status,
    };
    await this.audit(actor, row, 'coach_payments.refund_issued', {
      ...refund,
      request_key: input.idempotency_key,
    });
    return { refund, plan: await this.reload(actor, clientId, purchaseId) };
  }

  pause(actor: User, clientId: string, purchaseId: string, key: string) {
    return this.setPause(actor, clientId, purchaseId, key, 'pause');
  }

  resume(actor: User, clientId: string, purchaseId: string, key: string) {
    return this.setPause(actor, clientId, purchaseId, key, 'resume');
  }

  async cancel(actor: User, clientId: string, purchaseId: string, key: string) {
    const row = await this.scopedRow(actor, clientId, purchaseId);
    const current = await this.view(actor, row);
    if (!current.actions.cancel) throw this.notAllowed(current, 'cancel');
    let result: CancelPlanResult;
    try {
      result = await this.billing.cancelPlan(row.client_user_id, row.id);
    } catch (err) {
      throw this.failure(err, 'cancel');
    }
    const outcome = {
      outcome: result.outcome,
      access_ends_at: result.access_ends_at,
      voided_invoice_count: result.voided_invoice_count,
      voided_amount_cents: result.voided_amount_cents,
    };
    await this.audit(actor, row, 'coach_payments.plan_canceled', { ...outcome, request_key: key });
    return {
      ...outcome,
      message: CANCEL_COPY[result.outcome],
      plan: await this.reload(actor, clientId, purchaseId),
    };
  }

  /** Pause voids every invoice while paused (client keeps access); resume bills from the next renewal. */
  private async setPause(
    actor: User,
    clientId: string,
    purchaseId: string,
    key: string,
    action: 'pause' | 'resume',
  ) {
    const row = await this.scopedRow(actor, clientId, purchaseId);
    const current = await this.view(actor, row);
    if (current.billing === (action === 'pause' ? 'paused' : 'running')) return { plan: current };
    if (!current.actions[action] || !row.stripe_subscription_id) {
      throw this.notAllowed(current, action);
    }
    const args = {
      subscriptionId: row.stripe_subscription_id,
      idempotencyKey: `tgp-coach-${action}-${row.id}-${key}`,
    };
    let sub: StripeSubscriptionObject;
    try {
      sub =
        action === 'pause'
          ? await this.stripe.pauseSubscriptionCollection(args)
          : await this.stripe.resumeSubscriptionCollection(args);
    } catch (err) {
      throw this.failure(err, action);
    }
    const audited = action === 'pause' ? 'billing_paused' : 'billing_resumed';
    await this.audit(actor, row, `coach_payments.${audited}`, { request_key: key });
    return { plan: await this.view(actor, row, sub) };
  }

  /** The client's paid plans this actor sold, or sold by a coach on the actor's team. */
  private async scopedRows(actor: User, clientId: string, purchaseId?: string): Promise<PlanRow[]> {
    const rows = await this.prisma.clientPurchase.findMany({
      where: {
        client_user_id: clientId,
        source: null,
        amount_cents: { gt: 0 },
        ...(purchaseId ? { id: purchaseId } : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: PLAN_LIMIT,
      select: PLAN_SELECT,
    });
    const allowed = new Map<string, boolean>();
    const out: PlanRow[] = [];
    for (const row of rows) {
      let ok = allowed.get(row.coach_user_id);
      if (ok === undefined) {
        ok =
          row.coach_user_id === actor.id ||
          (await this.feePolicy.resolveHeadCoachId(row.coach_user_id)) === actor.id;
        allowed.set(row.coach_user_id, ok);
      }
      if (ok) out.push(row);
    }
    return out;
  }

  private async scopedRow(actor: User, clientId: string, purchaseId: string): Promise<PlanRow> {
    const [row] = await this.scopedRows(actor, clientId, purchaseId);
    if (!row) {
      throw new NotFoundException(
        coded(
          'PLAN_NOT_FOUND',
          'That plan is not one of your sales to this client, so nothing was changed. Pull down to refresh.',
        ),
      );
    }
    return row;
  }

  private async reload(actor: User, clientId: string, purchaseId: string) {
    return this.view(actor, await this.scopedRow(actor, clientId, purchaseId));
  }

  private async view(actor: User, row: PlanRow, sub?: StripeSubscriptionObject) {
    return planView(row, actor.id, await this.billingOf(row, sub));
  }

  private async billingOf(row: PlanRow, sub?: StripeSubscriptionObject): Promise<CoachPlanBilling> {
    if (row.billing_type !== 'recurring') return 'one_time';
    if (isRefundOrDisputePaused(row)) return 'paused_by_refund_or_dispute';
    if (!LIVE_STATUSES.has(row.status)) return 'ended';
    if (!row.stripe_subscription_id) return 'unknown';
    try {
      const live = sub ?? (await this.stripe.retrieveSubscription(row.stripe_subscription_id));
      return live.pause_collection ? 'paused' : 'running';
    } catch (err) {
      this.logger.warn(
        `coach payments: subscription read failed purchase=${row.id}: ${errName(err)}`,
      );
      return 'unknown';
    }
  }

  private notAllowed(plan: CoachClientPlanView, action: Exclude<Action, 'refund'>): HttpException {
    if (plan.billing === 'paused_by_refund_or_dispute') {
      return new ConflictException(
        coded(
          'PLAN_PAUSED_BY_REFUND_OR_DISPUTE',
          'Billing on this plan was paused by a full refund or a bank dispute. Use Restart plan instead.',
        ),
      );
    }
    if (plan.status === 'past_due' && action === 'pause') {
      return new ConflictException(
        coded(
          'PLAN_PAYMENT_FAILED',
          'The last payment on this plan failed, so it cannot be paused. Cancel it, or wait for the client to update their card.',
        ),
      );
    }
    return new ConflictException(
      coded('ACTION_NOT_AVAILABLE', `${NOT_ALLOWED[action]} Nothing was changed.`),
    );
  }

  private failure(err: unknown, action: Action): HttpException {
    if (err instanceof HttpException) return err;
    const s = err instanceof StripeConnectApiError ? err.httpStatus : 0;
    if (s >= 400 && s < 500 && s !== 429) {
      this.logger.warn(`coach payments ${action} refused by Stripe (${s})`);
      return new ConflictException(
        coded(
          'STRIPE_REFUSED',
          `The payment provider refused the ${action}, so nothing changed. Pull down to refresh this client.`,
        ),
      );
    }
    this.logger.error(`coach payments ${action} unconfirmed: ${errName(err)}`);
    return new ServiceUnavailableException(
      coded(
        'PAYMENT_ACTION_UNCONFIRMED',
        `The ${action} could not be confirmed. Pull down to refresh before trying again: anything that went through shows on this plan.`,
      ),
    );
  }

  private async audit(
    actor: User,
    row: PlanRow,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.auditLog.write({
      action,
      actorId: actor.id,
      actorRole: actor.role,
      targetUserId: row.client_user_id,
      targetType: 'client_purchase',
      targetId: row.id,
      tenantCoachId: row.coach_user_id,
      metadata,
    });
  }
}

function isRefundOrDisputePaused(row: PlanRow): boolean {
  return row.dunning?.status === 'active' && isBillingPauseReason(row.dunning.last_failure_reason);
}

function planView(row: PlanRow, actorId: string, billing: CoachPlanBilling) {
  const payments = paymentsOf(row, actorId);
  const open = ['running', 'paused', 'paused_by_refund_or_dispute'].includes(billing);
  return {
    purchase_id: row.id,
    package_name: row.package.name,
    billing_type: row.billing_type,
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.currency,
    created_at: row.created_at.toISOString(),
    current_period_end: row.current_period_end?.toISOString() ?? null,
    access_expires_at: row.access_expires_at?.toISOString() ?? null,
    cancel_at_period_end: row.cancel_at_period_end,
    entitlement_active: row.entitlement_active,
    billing,
    actions: {
      refund: payments.some((p) => p.refundable_cents > 0),
      pause: billing === 'running' && row.status === 'active' && !row.cancel_at_period_end,
      resume: billing === 'paused',
      cancel: open && !row.cancel_at_period_end,
      restart: billing === 'paused_by_refund_or_dispute' && row.coach_user_id === actorId,
    },
    payments,
  };
}

/** One entry per settled charge, newest first. Cross-currency settlements are not coach-refundable. */
function paymentsOf(row: PlanRow, actorId: string) {
  return row.settlements.map((s) => {
    const refunds = row.refunds.filter((r) => r.stripe_charge_id === s.stripe_charge_id);
    const sum = (pick: (status: string) => boolean) =>
      refunds.filter((r) => pick(r.status)).reduce((n, r) => n + r.amount_cents, 0);
    const refunded = Math.max(
      s.refunded_cents,
      sum((st) => st === 'succeeded'),
    );
    const left =
      s.gross_cents - refunded - sum((st) => IN_FLIGHT_REFUND.has(st)) - s.dispute_withdrawn_cents;
    const sameCurrency = s.currency.toLowerCase() === row.currency.toLowerCase();
    return {
      charge_id: s.stripe_charge_id,
      amount_cents: s.gross_cents,
      refunded_cents: refunded,
      refundable_cents: sameCurrency ? Math.max(0, left) : 0,
      currency: s.currency,
      paid_at: s.created_at.toISOString(),
      refunds: refunds.map((r) => ({
        id: r.id,
        amount_cents: r.amount_cents,
        status: r.status,
        created_at: r.created_at.toISOString(),
        by_you: r.initiated_by_user_id === actorId,
      })),
    };
  });
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}
