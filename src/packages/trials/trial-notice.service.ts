import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { ClientPurchase, PackageTrialNotice, Prisma } from '@prisma/client';
import { EmailService } from '../../email/email.service';
import { EmailTemplateKey } from '../../email/email.types';
import { NotificationKind } from '../../notifications/notification-kind';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma.service';
import { formatTrialAmount, formatTrialDate, trialEndingCopy } from './trial-copy';

// B-TRIALS (OR-113-2) — "your free trial ends soon" notice.
//
// Stripe sends customer.subscription.trial_will_end three days before a
// trial ends (or right away for a trial of three days or less). The webhook
// calls recordTrialWillEnd() INSIDE its transaction:
//   * one PackageTrialNotice row per (purchase, trial end) — the unique index
//     makes a redelivered event, or a second event for the same trial end, a
//     no-op (INSERT ... ON CONFLICT DO NOTHING, safe inside the tx);
//   * the in-app notification row, committed or rolled back with it.
// Push and email are HTTP calls, so they run AFTER the transaction commits
// (deliver()), and sweep() retries anything undelivered every 10 minutes
// until it is delivered, hits the attempt cap, or the trial has ended.

export const TRIAL_NOTICE_MAX_ATTEMPTS = 5;
/** Give the post-commit delivery a head start before the sweeper retries. */
const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
const SWEEP_BATCH = 50;

type Tx = Prisma.TransactionClient | PrismaService;

/** The Stripe subscription fields the notice reads (2024-09-30.acacia). */
export interface TrialWillEndSubscription {
  id?: string;
  status?: string;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  default_payment_method?: string | { id?: string } | null;
  items?: {
    data?: Array<{
      quantity?: number | null;
      price?: { unit_amount?: number | null; currency?: string | null } | null;
    }>;
  } | null;
}

/** True when the subscription has a saved card (the trial truly started). */
export function hasSavedPaymentMethod(sub: { default_payment_method?: unknown }): boolean {
  const pm = sub?.default_payment_method;
  if (typeof pm === 'string') return pm.length > 0;
  return !!(pm && typeof pm === 'object' && typeof (pm as { id?: unknown }).id === 'string');
}

/** What the card will be charged when the trial ends, from Stripe's own items. */
export function upcomingChargeCents(sub: TrialWillEndSubscription, fallbackCents: number): number {
  const items = sub.items?.data ?? [];
  let total = 0;
  let priced = false;
  for (const item of items) {
    const unit = item?.price?.unit_amount;
    if (typeof unit === 'number' && Number.isFinite(unit)) {
      total += unit * (typeof item.quantity === 'number' ? item.quantity : 1);
      priced = true;
    }
  }
  return priced ? total : fallbackCents;
}

@Injectable()
export class TrialNoticeService {
  private readonly logger = new Logger(TrialNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Record the trial-ending notice inside the webhook transaction. Returns the
   * notice id to deliver after commit, or null when nothing should be sent
   * (already noticed for this trial end, trial over, no card saved, not
   * trialing).
   */
  async recordTrialWillEnd(
    tx: Tx,
    args: { purchase: ClientPurchase; sub: TrialWillEndSubscription; eventId: string; now?: Date },
  ): Promise<string | null> {
    const now = args.now ?? new Date();
    const { purchase, sub } = args;
    const trialEndsAt =
      typeof sub.trial_end === 'number' && Number.isFinite(sub.trial_end)
        ? new Date(sub.trial_end * 1000)
        : null;
    if (sub.status !== 'trialing' || !trialEndsAt || trialEndsAt.getTime() <= now.getTime()) {
      return null;
    }
    // No card saved = the trial never started; Stripe cancels the subscription
    // at the trial end (missing_payment_method=cancel) and nobody is charged,
    // so "your card will be charged" would be untrue.
    if (!hasSavedPaymentMethod(sub)) return null;

    const amountCents = upcomingChargeCents(sub, purchase.amount_cents);
    const currency = (
      sub.items?.data?.[0]?.price?.currency ??
      purchase.currency ??
      'usd'
    ).toLowerCase();
    const created = await tx.packageTrialNotice.createMany({
      data: [
        {
          purchase_id: purchase.id,
          client_user_id: purchase.client_user_id,
          trial_ends_at: trialEndsAt,
          amount_cents: amountCents,
          currency,
          stripe_event_id: args.eventId,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return null;
    const notice = await tx.packageTrialNotice.findUnique({
      where: {
        purchase_id_trial_ends_at: { purchase_id: purchase.id, trial_ends_at: trialEndsAt },
      },
      select: { id: true },
    });
    if (!notice) return null;

    const timeZone = await this.clientTimeZone(purchase.client_user_id, tx);
    const copy = trialEndingCopy({
      trialEndsAt,
      amountCents,
      currency,
      timeZone,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    });
    await this.notifications.createNotification(
      {
        user_id: purchase.client_user_id,
        kind: NotificationKind.TRIAL_ENDING,
        body: copy.body,
        deep_link: 'tgp://plan',
        channel: 'inapp',
        payload: {
          purchase_id: purchase.id,
          package_id: purchase.package_id,
          trial_ends_at: trialEndsAt.toISOString(),
          amount_cents: amountCents,
          currency,
          will_charge: !sub.cancel_at_period_end,
        },
      },
      tx,
    );
    return notice.id;
  }

  /** Deliver push + email for a recorded notice. Never throws. */
  async deliver(noticeId: string, now: Date = new Date()): Promise<void> {
    try {
      const notice = await this.prisma.packageTrialNotice.findUnique({ where: { id: noticeId } });
      if (!notice) return;
      if (notice.trial_ends_at.getTime() <= now.getTime()) return;
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: notice.purchase_id },
        select: {
          id: true,
          cancel_at_period_end: true,
          status: true,
          package: { select: { name: true, interval: true, interval_count: true } },
          coach: { select: { name: true } },
          client: { select: { email: true, name: true } },
        },
      });
      if (!purchase || purchase.status === 'canceled') return;
      const timeZone = await this.clientTimeZone(notice.client_user_id);
      const copy = trialEndingCopy({
        trialEndsAt: notice.trial_ends_at,
        amountCents: notice.amount_cents,
        currency: notice.currency,
        timeZone,
        cancelAtPeriodEnd: purchase.cancel_at_period_end,
      });
      await this.deliverPush(notice, copy.title, copy.body);
      await this.deliverEmail(notice, {
        recipient: purchase.client,
        planName: purchase.package?.name ?? 'your plan',
        coachName: purchase.coach?.name ?? null,
        dateLabel: formatTrialDate(notice.trial_ends_at, timeZone),
        amountLabel: formatTrialAmount(notice.amount_cents, notice.currency),
        cancelAtPeriodEnd: purchase.cancel_at_period_end,
        cadence: cadenceLabel(purchase.package?.interval, purchase.package?.interval_count),
      });
    } catch (err) {
      this.logger.error(
        `trial notice delivery failed notice=${noticeId}: ${(err as Error)?.name ?? 'error'}`,
      );
    }
  }

  /** Retry undelivered notices. Multi-replica safe (per-channel CAS claims). */
  @Cron('*/10 * * * *', { name: 'trial-notice-sweep', timeZone: 'UTC' })
  async sweep(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.packageTrialNotice.findMany({
      where: {
        trial_ends_at: { gt: now },
        created_at: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
        OR: [
          { push_status: 'pending', push_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS } },
          { email_status: 'pending', email_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS } },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true },
    });
    for (const row of due) await this.deliver(row.id, now);
    return due.length;
  }

  private async deliverPush(notice: PackageTrialNotice, title: string, body: string) {
    if (notice.push_status !== 'pending' || notice.push_attempts >= TRIAL_NOTICE_MAX_ATTEMPTS)
      return;
    const claimed = await this.prisma.packageTrialNotice.updateMany({
      where: { id: notice.id, push_status: 'pending', push_attempts: notice.push_attempts },
      data: { push_attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;
    const attempt = notice.push_attempts + 1;
    const result = await this.notifications.pushToUser(notice.client_user_id, title, body, {
      kind: NotificationKind.TRIAL_ENDING,
      purchase_id: notice.purchase_id,
      deep_link: 'tgp://plan',
    });
    const status = result.delivered
      ? 'delivered'
      : result.code === 'no-token' || result.code === 'invalid-token'
        ? 'no_token'
        : attempt >= TRIAL_NOTICE_MAX_ATTEMPTS
          ? 'failed'
          : 'pending';
    await this.prisma.packageTrialNotice.update({
      where: { id: notice.id },
      data: {
        push_status: status,
        last_error: result.delivered ? notice.last_error : `push:${result.code}`,
      },
    });
  }

  private async deliverEmail(
    notice: PackageTrialNotice,
    ctx: {
      recipient: { email: string | null; name: string | null } | null;
      planName: string;
      coachName: string | null;
      dateLabel: string;
      amountLabel: string;
      cancelAtPeriodEnd: boolean;
      cadence: string;
    },
  ) {
    if (notice.email_status !== 'pending' || notice.email_attempts >= TRIAL_NOTICE_MAX_ATTEMPTS) {
      return;
    }
    if (!this.email) return;
    const claimed = await this.prisma.packageTrialNotice.updateMany({
      where: { id: notice.id, email_status: 'pending', email_attempts: notice.email_attempts },
      data: { email_attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;
    const attempt = notice.email_attempts + 1;
    if (!ctx.recipient?.email) {
      await this.prisma.packageTrialNotice.update({
        where: { id: notice.id },
        data: { email_status: 'no_email' },
      });
      return;
    }
    let status: 'sent' | 'pending' | 'failed' = 'pending';
    let error: string | null = null;
    try {
      const res = await this.email.send({
        to: ctx.recipient.email,
        template: EmailTemplateKey.TRIAL_ENDING,
        idempotencyKey: `trial-ending:${notice.purchase_id}:${notice.trial_ends_at.getTime()}`,
        data: {
          recipient_name: firstName(ctx.recipient.name),
          plan_name: ctx.planName,
          coach_name: ctx.coachName,
          trial_end_date: ctx.dateLabel,
          amount_display: ctx.amountLabel,
          cadence: ctx.cadence,
          will_charge: !ctx.cancelAtPeriodEnd,
        },
      });
      if (res.status === 'failed') error = `email:${res.error ? 'provider_failed' : 'failed'}`;
      else status = 'sent';
    } catch (err) {
      error = `email:${(err as Error)?.name ?? 'error'}`;
    }
    if (status !== 'sent' && attempt >= TRIAL_NOTICE_MAX_ATTEMPTS) status = 'failed';
    await this.prisma.packageTrialNotice.update({
      where: { id: notice.id },
      data: { email_status: status, ...(error ? { last_error: error } : {}) },
    });
  }

  private async clientTimeZone(userId: string, tx?: Tx): Promise<string | null> {
    const db = tx ?? this.prisma;
    try {
      const prefs = await db.notificationPreferences.findUnique({
        where: { user_id: userId },
        select: { timezone: true },
      });
      return prefs?.timezone ?? null;
    } catch {
      return null;
    }
  }
}

function firstName(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? first : null;
}

/** "monthly", "every 3 months", "yearly", "weekly". */
export function cadenceLabel(interval?: string | null, count?: number | null): string {
  const n = count && count > 1 ? count : 1;
  const unit = interval === 'week' || interval === 'year' ? interval : 'month';
  if (n === 1) return unit === 'week' ? 'weekly' : unit === 'year' ? 'yearly' : 'monthly';
  return `every ${n} ${unit}s`;
}
