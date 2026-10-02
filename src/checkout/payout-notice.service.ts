import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { PayoutAdjustmentNotice } from '@prisma/client';
import {
  formatMoney,
  heldBreakdownLines,
  type PayoutNoticeAmounts,
} from '../connect/fees/payout-notice-copy';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { NotificationKind } from '../notifications/notification-kind';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma.service';

// S-FEE round 5 (owner decision OR-111-1) — delivery and read side of the
// payee notices ChargeSettlementService writes after a refund / chargeback /
// dispute outcome converges.
//
// Delivery (at least once, never blocking the money path): an in-app
// Notification row (kind coach_alert), a push when the payee's coach-alert
// push preference is on, and the coach-payout-adjustment email through
// EmailService (EMAIL_TRANSPORT=log records it only; once the provider is
// live it is sent, keyed by the notice's idempotency key so a retry never
// sends twice). A notice is claimed with a CAS on dispatch_claimed_at before
// anything is sent, so two workers never deliver the same notice together;
// an expired claim (crash mid-delivery) is retried by the sweeper.
//
// Read side (Money page): the payee's open held balance per currency (every
// open PayeeRecovery: amount - collected) and their notices with the full
// breakdown, newest first, cursor-paginated, scoped to the caller.

export const PAYOUT_NOTICE_DEEP_LINK = 'tgp://coach/money';
export const PAYOUT_NOTICE_CLAIM_TTL_MS = 5 * 60_000;
export const PAYOUT_NOTICE_MAX_ATTEMPTS = 6;
export const PAYOUT_NOTICE_PAGE_MAX = 50;

export interface PayoutNoticeView {
  id: string;
  event: string;
  role: string;
  purchase_id: string;
  stripe_charge_id: string;
  currency: string;
  title: string;
  body: string;
  charge_gross_cents: number;
  customer_refunded_cents: number;
  reversed_cents: number;
  reinstated_cents: number;
  held_cents: number;
  held_open_cents: number;
  held_now_open_cents: number;
  held_breakdown: Array<{ code: string; label: string; cents: number; display: string }>;
  needs_attention: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

export interface PayoutAdjustmentsView {
  open_balance: Array<{ currency: string; held_cents: number; display: string; charges: number }>;
  needs_attention_count: number;
  notices: PayoutNoticeView[];
  next_cursor: string | null;
}

function amountsOf(n: PayoutAdjustmentNotice): PayoutNoticeAmounts {
  return {
    currency: n.currency,
    charge_gross_cents: n.charge_gross_cents,
    customer_refunded_cents: n.customer_refunded_cents,
    reversed_cents: n.reversed_cents,
    reinstated_cents: n.reinstated_cents,
    released_cents: 0,
    held_cents: n.held_cents,
    held_tgp_fee_cents: n.held_tgp_fee_cents,
    held_stripe_fee_cents: n.held_stripe_fee_cents,
    held_dispute_fee_cents: n.held_dispute_fee_cents,
    held_not_reversed_cents: n.held_not_reversed_cents,
    held_open_cents: n.held_open_cents,
  };
}

@Injectable()
export class PayoutNoticeService {
  private readonly logger = new Logger(PayoutNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Deliver every undelivered notice of one charge (after its adjustment).
   * `recorded` counts the charge's notices of any state, so a caller can tell
   * a settlement charge (exact-amount notice exists) from a legacy one.
   */
  async dispatchForCharge(chargeId: string): Promise<{ recorded: number; sent: number }> {
    const rows = await this.prisma.payoutAdjustmentNotice.findMany({
      where: { stripe_charge_id: chargeId },
      orderBy: { created_at: 'asc' },
    });
    let sent = 0;
    for (const n of rows) {
      if (n.dispatched_at) continue;
      if (await this.dispatchOne(n)) sent += 1;
    }
    return { recorded: rows.length, sent };
  }

  /** Sweeper: notices still undelivered a minute after they were written. */
  async dispatchPending(now: Date = new Date(), limit = 25): Promise<number> {
    const rows = await this.prisma.payoutAdjustmentNotice.findMany({
      where: {
        dispatched_at: null,
        dispatch_attempts: { lt: PAYOUT_NOTICE_MAX_ATTEMPTS },
        created_at: { lte: new Date(now.getTime() - 60_000) },
      },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    let sent = 0;
    for (const n of rows) if (await this.dispatchOne(n, now)) sent += 1;
    return sent;
  }

  private async dispatchOne(n: PayoutAdjustmentNotice, now: Date = new Date()): Promise<boolean> {
    if (n.dispatched_at) return false;
    const claim = await this.prisma.payoutAdjustmentNotice.updateMany({
      where: {
        id: n.id,
        dispatched_at: null,
        OR: [
          { dispatch_claimed_at: null },
          { dispatch_claimed_at: { lte: new Date(now.getTime() - PAYOUT_NOTICE_CLAIM_TTL_MS) } },
        ],
      },
      data: { dispatch_claimed_at: now, dispatch_attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return false;
    const amounts = amountsOf(n);
    const payload = {
      event: 'payout_adjustment',
      notice_id: n.id,
      notice_event: n.event,
      purchase_id: n.purchase_id,
      stripe_charge_id: n.stripe_charge_id,
      currency: n.currency,
      customer_refunded_cents: n.customer_refunded_cents,
      reversed_cents: n.reversed_cents,
      held_cents: n.held_cents,
      held_tgp_fee_cents: n.held_tgp_fee_cents,
      held_stripe_fee_cents: n.held_stripe_fee_cents,
      held_dispute_fee_cents: n.held_dispute_fee_cents,
      held_not_reversed_cents: n.held_not_reversed_cents,
    };
    let push = 'skipped';
    let email = 'skipped';
    let failed = false;
    try {
      await this.notifications.createNotification({
        user_id: n.payee_user_id,
        kind: NotificationKind.COACH_ALERT,
        body: n.body,
        payload,
        deep_link: PAYOUT_NOTICE_DEEP_LINK,
        channel: 'inapp',
      });
      // The push row honours the payee's coach-alert push preference and mute.
      const pushRow = await this.notifications.createNotification({
        user_id: n.payee_user_id,
        kind: NotificationKind.COACH_ALERT,
        body: n.body,
        payload,
        deep_link: PAYOUT_NOTICE_DEEP_LINK,
        channel: 'push',
      });
      if (pushRow) {
        const res = await this.notifications.pushToUser(n.payee_user_id, n.title, n.body, {
          type: 'payout_adjustment',
          notice_id: n.id,
          deep_link: PAYOUT_NOTICE_DEEP_LINK,
        });
        push = res.delivered ? 'sent' : res.code === 'no-token' ? 'skipped' : 'failed';
      }
    } catch (err) {
      failed = true;
      push = 'failed';
      this.logger.warn(
        `SFEE_NOTICE_PUSH_FAILED notice=${n.id} payee=${n.payee_user_id}: ${(err as Error).message}`,
      );
    }
    try {
      email = await this.sendEmail(n, amounts);
      if (email === 'failed') failed = true;
    } catch (err) {
      failed = true;
      email = 'failed';
      this.logger.warn(
        `SFEE_NOTICE_EMAIL_FAILED notice=${n.id} payee=${n.payee_user_id}: ${(err as Error).message}`,
      );
    }
    // A failure leaves the notice undelivered (claim expires, sweeper retries
    // up to PAYOUT_NOTICE_MAX_ATTEMPTS); the Money page shows it either way.
    const finalAttempt = n.dispatch_attempts + 1 >= PAYOUT_NOTICE_MAX_ATTEMPTS;
    await this.prisma.payoutAdjustmentNotice.updateMany({
      where: { id: n.id },
      data: {
        push_status: push,
        email_status: email,
        dispatched_at: failed && !finalAttempt ? null : new Date(),
      },
    });
    if (failed && finalAttempt) {
      this.logger.error(
        `SFEE_NOTICE_UNDELIVERED alert=true notice=${n.id} payee=${n.payee_user_id} push=${push} email=${email}: gave up after ${PAYOUT_NOTICE_MAX_ATTEMPTS} attempts; the payee still sees it on the Money page`,
      );
    }
    return !failed;
  }

  private async sendEmail(n: PayoutAdjustmentNotice, a: PayoutNoticeAmounts): Promise<string> {
    if (!this.email) return 'skipped';
    const user = await this.prisma.user.findUnique({
      where: { id: n.payee_user_id },
      select: { email: true, name: true },
    });
    if (!user?.email) return 'skipped';
    const m = (cents: number) => formatMoney(cents, n.currency);
    const res = await this.email.send({
      to: user.email,
      template: EmailTemplateKey.COACH_PAYOUT_ADJUSTMENT,
      idempotencyKey: n.idempotency_key,
      data: {
        subject: n.title,
        title: n.title,
        recipient_name: user.name,
        summary: n.body,
        charge_display: m(n.charge_gross_cents),
        customer_refunded_display: m(n.customer_refunded_cents),
        reversed_display: m(n.reversed_cents),
        reinstated_display: n.reinstated_cents > 0 ? m(n.reinstated_cents) : null,
        held_display: m(n.held_cents),
        held_open_display: m(n.held_open_cents),
        held_lines: heldBreakdownLines(a),
        has_hold: n.held_cents > 0,
      },
    });
    if (res.status === 'failed') {
      this.logger.warn(
        `SFEE_NOTICE_EMAIL_FAILED notice=${n.id} payee=${n.payee_user_id}: ${res.error ?? 'provider error'}`,
      );
    }
    return res.status;
  }

  /** Money page: open held balance + notices for one payee (newest first). */
  async listForPayee(
    payeeUserId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<PayoutAdjustmentsView> {
    const limit = Math.max(1, Math.min(PAYOUT_NOTICE_PAGE_MAX, opts.limit ?? 20));
    const [open, page, unacknowledged] = await Promise.all([
      this.prisma.payeeRecovery.findMany({
        where: { payee_user_id: payeeUserId, status: 'open' },
        select: { settlement_id: true, currency: true, amount_cents: true, collected_cents: true },
      }),
      this.prisma.payoutAdjustmentNotice.findMany({
        where: { payee_user_id: payeeUserId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      }),
      this.prisma.payoutAdjustmentNotice.count({
        where: { payee_user_id: payeeUserId, acknowledged_at: null },
      }),
    ]);
    const byCurrency = new Map<string, { cents: number; settlements: Set<string> }>();
    const openBySettlement = new Map<string, number>();
    for (const r of open) {
      const left = Math.max(0, r.amount_cents - r.collected_cents);
      if (left <= 0) continue;
      const e = byCurrency.get(r.currency) ?? { cents: 0, settlements: new Set<string>() };
      e.cents += left;
      e.settlements.add(r.settlement_id);
      byCurrency.set(r.currency, e);
      openBySettlement.set(r.settlement_id, (openBySettlement.get(r.settlement_id) ?? 0) + left);
    }
    const rows = page.slice(0, limit);
    // Only the newest notice of a charge carries its live open amount.
    const seen = new Set<string>();
    const notices = rows.map((n): PayoutNoticeView => {
      const live = seen.has(n.settlement_id) ? 0 : (openBySettlement.get(n.settlement_id) ?? 0);
      seen.add(n.settlement_id);
      return {
        id: n.id,
        event: n.event,
        role: n.role,
        purchase_id: n.purchase_id,
        stripe_charge_id: n.stripe_charge_id,
        currency: n.currency,
        title: n.title,
        body: n.body,
        charge_gross_cents: n.charge_gross_cents,
        customer_refunded_cents: n.customer_refunded_cents,
        reversed_cents: n.reversed_cents,
        reinstated_cents: n.reinstated_cents,
        held_cents: n.held_cents,
        held_open_cents: n.held_open_cents,
        held_now_open_cents: live,
        held_breakdown: heldBreakdownLines(amountsOf(n)),
        needs_attention: n.acknowledged_at === null || live > 0,
        acknowledged_at: n.acknowledged_at ? n.acknowledged_at.toISOString() : null,
        created_at: n.created_at.toISOString(),
      };
    });
    return {
      open_balance: [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, e]) => ({
          currency,
          held_cents: e.cents,
          display: formatMoney(e.cents, currency),
          charges: e.settlements.size,
        })),
      needs_attention_count: unacknowledged,
      notices,
      next_cursor: page.length > limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  /** The payee has seen a notice (its open amount, if any, still shows). */
  async acknowledge(payeeUserId: string, noticeId: string): Promise<{ acknowledged_at: string }> {
    const now = new Date();
    const res = await this.prisma.payoutAdjustmentNotice.updateMany({
      where: { id: noticeId, payee_user_id: payeeUserId },
      data: { acknowledged_at: now },
    });
    if (res.count !== 1) {
      throw new NotFoundException({
        code: 'PAYOUT_NOTICE_NOT_FOUND',
        message:
          'We could not find that payout notice on your account. Refresh Money to see your current notices.',
      });
    }
    return { acknowledged_at: now.toISOString() };
  }
}
