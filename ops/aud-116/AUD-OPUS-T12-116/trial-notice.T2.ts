import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { ClientPurchase, PackageTrialNotice, Prisma } from '@prisma/client';
import { EmailService } from '../../email/email.service';
import { EmailTemplateKey } from '../../email/email.types';
import { NotificationKind } from '../../notifications/notification-kind';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma.service';
import {
  formatTrialAmount,
  formatTrialDate,
  trialEndingCopy,
  trialNoChargeReason,
  willChargeCard,
} from './trial-copy';

import { trialErrorClass, trialPushCode } from './trial-diagnostics';

export { willChargeCard } from './trial-copy';

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

//
// B-TRIALS-3 (agent 115) — fix round for Sol B-656-2/3/4/5:
//   * the notice no longer depends on the trial_will_end event alone: it is
//     also recorded when a trial starts inside the warning window
//     (recordIfDue, from the webhook) and by the reconciler in sweep()
//     (started trials ending within TRIAL_NOTICE_LEAD_MS without a notice).
//     A one-day trial whose only trial_will_end event arrived before the card
//     was saved is noticed once the card is saved (B-656-3);
//   * every channel claim is an exclusive lease (fresh token + expiry) and the
//     outcome is written only by the token holder, so a stale or slow caller
//     can never send twice in parallel or overwrite a delivered state; the
//     transport is bounded below the lease (B-656-2). Delivery is honestly
//     at-least-once: a process that dies after the provider accepted the
//     message but before the outcome write is retried after the lease
//     expires (email retries use a new per-attempt idempotency key only
//     after a definite failure);
//   * push re-reads the client's notification preferences at delivery: a
//     global mute records push_status 'suppressed' and sends nothing. The
//     email is a billing notice about an upcoming card charge and is sent
//     regardless of the push mute (B-656-4);
//   * the copy says what will really happen: a card is charged only when the
//     subscription or the customer still holds a payment method; a client who
//     removed the card mid-trial is told nothing will be charged (B-656-5).

export const TRIAL_NOTICE_MAX_ATTEMPTS = 5;
/** Stripe's default trial_will_end lead: three days before the trial end. */
export const TRIAL_NOTICE_LEAD_MS = 3 * 24 * 60 * 60 * 1000;
/** A channel claim expires after this; the transport is bounded below it. */
export const TRIAL_NOTICE_LEASE_MS = 2 * 60 * 1000;
export const TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS = 30 * 1000;
const RECONCILE_BATCH = 100;
/** Pages one reconcile sweep reads before it resumes on the next sweep. */
export const RECONCILE_MAX_PAGES = 50;
/** Mobile route the notice opens (Your plan: trial end date + cancel). */
export const TRIAL_ACTION_SCREEN = 'ClientPackages';
/** Give the post-commit delivery a head start before the sweeper retries. */
const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
const SWEEP_BATCH = 50;

type Tx = Prisma.TransactionClient | PrismaService;

export type TrialNoticeSource = 'trial_will_end' | 'trial_start' | 'sweep';

type NoticePurchase = Pick<
  ClientPurchase,
  'id' | 'client_user_id' | 'package_id' | 'amount_cents' | 'currency'
>;

export interface RecordTrialNoticeArgs {
  purchase: NoticePurchase;
  trialEndsAt: Date;
  amountCents: number;
  currency: string;
  cancelAtPeriodEnd: boolean;
  /** A payment method will really be charged at the trial end. */
  cardOnFile: boolean;
  source: TrialNoticeSource;
  eventId?: string | null;
  now?: Date;
}

/** True when the subscription itself holds a payment method. */
export function subscriptionHasPaymentMethod(sub: {
  default_payment_method?: unknown;
  default_source?: unknown;
}): boolean {
  if (hasSavedPaymentMethod(sub)) return true;
  const src = sub?.default_source;
  if (typeof src === 'string') return src.length > 0;
  return !!(src && typeof src === 'object' && typeof (src as { id?: unknown }).id === 'string');
}

/** The Stripe subscription fields the notice reads (2024-09-30.acacia). */
export interface TrialWillEndSubscription {
  id?: string;
  status?: string;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  default_payment_method?: unknown;
  default_source?: unknown;
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
  /** B-656-3 — keyset position when a reconcile sweep hit the page cap. */
  private reconcileCursor: { endsAt: Date; id: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * customer.subscription.trial_will_end, inside the webhook transaction.
   * Returns the notice id to deliver after commit, or null when nothing is
   * recorded now (already noticed for this trial end, trial over, not
   * trialing, or the trial has not started yet).
   */
  async recordTrialWillEnd(
    tx: Tx,
    args: {
      purchase: NoticePurchase & Pick<ClientPurchase, 'entitlement_active'>;
      sub: TrialWillEndSubscription;
      eventId: string;
      now?: Date;
    },
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
    // B-656-3 — the trial has not started (card not saved yet, or this
    // purchase lost the one-trial race): no access, nothing to warn about
    // yet. The notice is not lost: the trial start (recordIfDue) or the
    // reconciler records it as soon as the trial really starts.
    if (!purchase.entitlement_active) return null;
    // B-656-5 — card authority is tri-state; unknown (a failed read) never
    // becomes "no card". The reconciler records it once the read succeeds.
    const cardOnFile = await this.cardAuthority(
      subscriptionHasPaymentMethod(sub),
      purchase.client_user_id,
      tx,
    );
    if (cardOnFile === null) return null;
    return this.recordNotice(tx, {
      purchase,
      trialEndsAt,
      amountCents: upcomingChargeCents(sub, purchase.amount_cents),
      currency: (sub.items?.data?.[0]?.price?.currency ?? purchase.currency ?? 'usd').toLowerCase(),
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      cardOnFile,
      source: 'trial_will_end',
      eventId: args.eventId,
      now,
    });
  }

  /**
   * B-656-3 — the trial just started (card saved, access granted) inside the
   * warning window: record the notice now, on the webhook transaction, rather
   * than waiting for a trial_will_end event that may already have been sent.
   */
  async recordIfDue(
    tx: Tx,
    args: {
      purchase: NoticePurchase;
      sub: TrialWillEndSubscription;
      trialEndsAt: Date | null;
      eventId?: string | null;
      now?: Date;
    },
  ): Promise<string | null> {
    const now = args.now ?? new Date();
    const end = args.trialEndsAt;
    if (!end) return null;
    const left = end.getTime() - now.getTime();
    if (left <= 0 || left > TRIAL_NOTICE_LEAD_MS) return null;
    const cardOnFile = await this.cardAuthority(
      subscriptionHasPaymentMethod(args.sub),
      args.purchase.client_user_id,
      tx,
    );
    if (cardOnFile === null) return null; // unknown: the reconciler records it
    return this.recordNotice(tx, {
      purchase: args.purchase,
      trialEndsAt: end,
      amountCents: upcomingChargeCents(args.sub, args.purchase.amount_cents),
      currency: (
        args.sub.items?.data?.[0]?.price?.currency ??
        args.purchase.currency ??
        'usd'
      ).toLowerCase(),
      cancelAtPeriodEnd: !!args.sub.cancel_at_period_end,
      cardOnFile,
      source: 'trial_start',
      eventId: args.eventId ?? null,
      now,
    });
  }

  /**
   * One notice per (purchase, trial end): the ledger row and the in-app row,
   * on the caller's transaction. Returns the notice id when this call wrote
   * it, else null (already recorded).
   */
  async recordNotice(tx: Tx, args: RecordTrialNoticeArgs): Promise<string | null> {
    const { purchase, trialEndsAt } = args;
    const created = await tx.packageTrialNotice.createMany({
      data: [
        {
          purchase_id: purchase.id,
          client_user_id: purchase.client_user_id,
          trial_ends_at: trialEndsAt,
          amount_cents: args.amountCents,
          currency: args.currency,
          stripe_event_id: args.eventId ?? null,
          source: args.source,
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
      amountCents: args.amountCents,
      currency: args.currency,
      timeZone,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      cardOnFile: args.cardOnFile,
    });
    // Global mute / per-kind prefs are enforced inside createNotification.
    await this.notifications.createNotification(
      {
        user_id: purchase.client_user_id,
        kind: NotificationKind.TRIAL_ENDING,
        body: copy.body,
        deep_link: 'tgp://plan',
        channel: 'inapp',
        payload: {
          actionScreen: TRIAL_ACTION_SCREEN,
          purchase_id: purchase.id,
          package_id: purchase.package_id,
          trial_ends_at: trialEndsAt.toISOString(),
          amount_cents: args.amountCents,
          currency: args.currency,
          will_charge: trialNoChargeReason(args) === null,
          card_on_file: args.cardOnFile,
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
          card_on_file: true,
          status: true,
          package: { select: { name: true, interval: true, interval_count: true } },
          coach: { select: { name: true } },
          client: { select: { email: true, name: true } },
        },
      });
      if (!purchase || purchase.status === 'canceled') return;
      const timeZone = await this.clientTimeZone(notice.client_user_id);
      // B-656-5 — the truth at delivery time (the card may have been removed
      // or replaced since the notice was recorded).
      const cardOnFile = await this.cardAuthority(purchase.card_on_file, notice.client_user_id);
      if (cardOnFile === null) {
        // Unknown card state (the read failed): send nothing rather than a
        // wrong promise; both channels stay pending and the sweep retries.
        this.logger.warn(
          `trial notice delivery deferred notice=${noticeId} code=card_state_unknown`,
        );
        return;
      }
      const copy = trialEndingCopy({
        trialEndsAt: notice.trial_ends_at,
        amountCents: notice.amount_cents,
        currency: notice.currency,
        timeZone,
        cancelAtPeriodEnd: purchase.cancel_at_period_end,
        cardOnFile,
      });
      await this.deliverPush(notice, copy.title, copy.body, now);
      await this.deliverEmail(
        notice,
        {
          recipient: purchase.client,
          planName: purchase.package?.name ?? 'your plan',
          coachName: purchase.coach?.name ?? null,
          dateLabel: formatTrialDate(notice.trial_ends_at, timeZone),
          amountLabel: formatTrialAmount(notice.amount_cents, notice.currency),
          cancelAtPeriodEnd: purchase.cancel_at_period_end,
          cardOnFile,
          cadence: cadenceLabel(purchase.package?.interval, purchase.package?.interval_count),
        },
        now,
      );
    } catch (err) {
      this.logger.error(`trial notice delivery failed notice=${noticeId}: ${trialErrorClass(err)}`);
    }
  }

  /**
   * Every 10 minutes: record notices that are due but missing (B-656-3), then
   * retry undelivered channels. Multi-replica safe (unique notice key and
   * per-channel leases).
   */
  @Cron('*/10 * * * *', { name: 'trial-notice-sweep', timeZone: 'UTC' })
  async sweep(now: Date = new Date()): Promise<number> {
    let reconciled = 0;
    try {
      reconciled = await this.reconcileDue(now);
    } catch (err) {
      // A reconcile failure never blocks the delivery retries below.
      this.logger.error(`trial notice reconcile errored: ${trialErrorClass(err)}`);
    }
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
    return reconciled + due.length;
  }

  /**
   * B-656-3 — started trials (trialing with access) that end within the
   * warning window and have no notice for that trial end yet. Covers a
   * trial_will_end event that arrived before the card was saved, a trial
   * that started on a code path without the start hook, and a webhook
   * endpoint that is missing the event. Returns how many it recorded.
   */
  async reconcileDue(now: Date = new Date()): Promise<number> {
    const horizon = new Date(now.getTime() + TRIAL_NOTICE_LEAD_MS);
    // B-656-3 — keyset paging on (trial_ends_at, id): already-noticed rows
    // never hold back a due trial behind them. A sweep that hits the page cap
    // resumes from its cursor next time instead of rereading the first pages.
    let cursor = this.reconcileCursor;
    this.reconcileCursor = null;
    let recorded = 0;
    for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
      const candidates = await this.prisma.clientPurchase.findMany({
        where: {
          AND: [
            {
              status: 'trialing',
              entitlement_active: true,
              trial_ends_at: { gt: now, lte: horizon },
            },
            ...(cursor
              ? [
                  {
                    OR: [
                      { trial_ends_at: { gt: cursor.endsAt } },
                      { trial_ends_at: cursor.endsAt, id: { gt: cursor.id } },
                    ],
                  },
                ]
              : []),
          ],
        },
        orderBy: [{ trial_ends_at: 'asc' }, { id: 'asc' }],
        take: RECONCILE_BATCH,
        select: {
          id: true,
          client_user_id: true,
          package_id: true,
          amount_cents: true,
          currency: true,
          cancel_at_period_end: true,
          card_on_file: true,
          trial_ends_at: true,
        },
      });
      if (candidates.length === 0) return recorded;
      recorded += await this.reconcilePage(candidates, now);
      const last = candidates[candidates.length - 1];
      if (candidates.length < RECONCILE_BATCH || !last.trial_ends_at) return recorded;
      cursor = { endsAt: last.trial_ends_at, id: last.id };
    }
    this.reconcileCursor = cursor;
    this.logger.warn(
      `trial notice reconcile hit the page cap (${RECONCILE_MAX_PAGES}); resumes next sweep`,
    );
    return recorded;
  }

  private async reconcilePage(
    candidates: Array<
      NoticePurchase &
        Pick<ClientPurchase, 'cancel_at_period_end' | 'card_on_file' | 'trial_ends_at'>
    >,
    now: Date,
  ): Promise<number> {
    const existing = await this.prisma.packageTrialNotice.findMany({
      where: { purchase_id: { in: candidates.map((c) => c.id) } },
      select: { purchase_id: true, trial_ends_at: true },
    });
    const have = new Set(existing.map((n) => `${n.purchase_id}:${n.trial_ends_at.getTime()}`));
    let recorded = 0;
    for (const p of candidates) {
      const end = p.trial_ends_at;
      if (!end || have.has(`${p.id}:${end.getTime()}`)) continue;
      try {
        const cardOnFile = await this.cardAuthority(p.card_on_file, p.client_user_id);
        if (cardOnFile === null) continue; // unknown: retried next sweep
        // A concurrent writer may record the same notice: the unique
        // (purchase_id, trial_ends_at) makes the second insert a no-op.
        const id = await this.prisma.$transaction((tx) =>
          this.recordNotice(tx, {
            purchase: p,
            trialEndsAt: end,
            amountCents: p.amount_cents,
            currency: (p.currency || 'usd').toLowerCase(),
            cancelAtPeriodEnd: p.cancel_at_period_end,
            cardOnFile,
            source: 'sweep',
            now,
          }),
        );
        if (id) {
          recorded += 1;
          await this.deliver(id, now);
        }
      } catch (err) {
        this.logger.error(
          `trial notice reconcile failed purchase=${p.id}: ${trialErrorClass(err)}`,
        );
      }
    }
    return recorded;
  }

  private async deliverPush(
    notice: PackageTrialNotice,
    title: string,
    body: string,
    now: Date,
  ): Promise<void> {
    if (notice.push_status !== 'pending' || notice.push_attempts >= TRIAL_NOTICE_MAX_ATTEMPTS)
      return;
    const lease = await this.claim(notice.id, 'push', now);
    if (!lease) return;
    let status: 'delivered' | 'no_token' | 'suppressed' | 'pending' | 'failed';
    let error: string | null = null;
    // B-656-4 — the client's preferences at delivery time (a mute set after
    // the notice was recorded still applies).
    const prefs = await this.notifications.getPreferences(notice.client_user_id);
    if ((prefs as Record<string, unknown>).muted === true) {
      status = 'suppressed';
    } else {
      const controller = new AbortController();
      const result = await withTimeout(
        this.notifications.pushToUser(
          notice.client_user_id,
          title,
          body,
          {
            kind: NotificationKind.TRIAL_ENDING,
            purchase_id: notice.purchase_id,
            deep_link: 'tgp://plan',
            // The app's push-tap router (pushTapRouter CLIENT_PUSH_ROUTES) opens
            // Your plan, where the trial end date and the cancel path live.
            actionScreen: TRIAL_ACTION_SCREEN,
          },
          controller.signal,
        ),
        TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS,
        () => controller.abort(),
      );
      if (result === TIMED_OUT) {
        status = lease.attempt >= TRIAL_NOTICE_MAX_ATTEMPTS ? 'failed' : 'pending';
        error = 'push:timeout';
      } else if (result.delivered) {
        status = 'delivered';
      } else if (result.code === 'no-token' || result.code === 'invalid-token') {
        status = 'no_token';
        error = `push:${trialPushCode(result.code)}`;
      } else {
        status = lease.attempt >= TRIAL_NOTICE_MAX_ATTEMPTS ? 'failed' : 'pending';
        error = `push:${trialPushCode(result.code)}`;
      }
    }
    await this.complete(notice.id, 'push', lease.token, {
      push_status: status,
      ...(error ? { last_error: error } : {}),
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
      cardOnFile: boolean;
      cadence: string;
    },
    now: Date,
  ): Promise<void> {
    if (notice.email_status !== 'pending' || notice.email_attempts >= TRIAL_NOTICE_MAX_ATTEMPTS) {
      return;
    }
    if (!this.email) return;
    const lease = await this.claim(notice.id, 'email', now);
    if (!lease) return;
    if (!ctx.recipient?.email) {
      await this.complete(notice.id, 'email', lease.token, { email_status: 'no_email' });
      return;
    }
    const reason = trialNoChargeReason(ctx);
    // Attempt 1 keeps the original key; a retry after a definite failure gets
    // its own key (EmailService treats a reused key as already sent).
    const baseKey = `trial-ending:${notice.purchase_id}:${notice.trial_ends_at.getTime()}`;
    const idempotencyKey = lease.attempt === 1 ? baseKey : `${baseKey}:a${lease.attempt}`;
    let status: 'sent' | 'pending' | 'failed' = 'pending';
    let error: string | null = null;
    try {
      const res = await withTimeout(
        this.email.send({
          to: ctx.recipient.email,
          template: EmailTemplateKey.TRIAL_ENDING,
          idempotencyKey,
          data: {
            recipient_name: firstName(ctx.recipient.name),
            plan_name: ctx.planName,
            coach_name: ctx.coachName,
            trial_end_date: ctx.dateLabel,
            amount_display: ctx.amountLabel,
            cadence: ctx.cadence,
            will_charge: reason === null,
            no_card: reason === 'no_card',
          },
        }),
        TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS,
      );
      if (res === TIMED_OUT) error = 'email:timeout';
      else if (res.status === 'failed') error = `email:${res.error ? 'provider_failed' : 'failed'}`;
      else status = 'sent';
    } catch (err) {
      error = `email:${trialErrorClass(err)}`;
    }
    if (status !== 'sent' && lease.attempt >= TRIAL_NOTICE_MAX_ATTEMPTS) status = 'failed';
    await this.complete(notice.id, 'email', lease.token, {
      email_status: status,
      ...(error ? { last_error: error } : {}),
    });
  }

  /**
   * B-656-2 — exclusive claim on one channel: pending, under the attempt cap,
   * and no live lease. Returns the lease token and this attempt's number.
   */
  private async claim(
    noticeId: string,
    channel: 'push' | 'email',
    now: Date,
  ): Promise<{ token: string; attempt: number } | null> {
    const token = randomUUID();
    const until = new Date(now.getTime() + TRIAL_NOTICE_LEASE_MS);
    const where: Prisma.PackageTrialNoticeWhereInput =
      channel === 'push'
        ? {
            id: noticeId,
            push_status: 'pending',
            push_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS },
            OR: [{ push_lease_until: null }, { push_lease_until: { lt: now } }],
          }
        : {
            id: noticeId,
            email_status: 'pending',
            email_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS },
            OR: [{ email_lease_until: null }, { email_lease_until: { lt: now } }],
          };
    const data: Prisma.PackageTrialNoticeUpdateManyMutationInput =
      channel === 'push'
        ? { push_attempts: { increment: 1 }, push_lease_token: token, push_lease_until: until }
        : { email_attempts: { increment: 1 }, email_lease_token: token, email_lease_until: until };
    const claimed = await this.prisma.packageTrialNotice.updateMany({ where, data });
    if (claimed.count !== 1) return null;
    const row = await this.prisma.packageTrialNotice.findUnique({
      where: { id: noticeId },
      select: {
        push_attempts: true,
        email_attempts: true,
        push_lease_token: true,
        email_lease_token: true,
      },
    });
    const held = channel === 'push' ? row?.push_lease_token : row?.email_lease_token;
    if (!row || held !== token) return null;
    return { token, attempt: channel === 'push' ? row.push_attempts : row.email_attempts };
  }

  /** Fenced outcome: only the current lease holder may write it. */
  private async complete(
    noticeId: string,
    channel: 'push' | 'email',
    token: string,
    data: Prisma.PackageTrialNoticeUpdateManyMutationInput,
  ): Promise<boolean> {
    const res = await this.prisma.packageTrialNotice.updateMany({
      where:
        channel === 'push'
          ? { id: noticeId, push_lease_token: token }
          : { id: noticeId, email_lease_token: token },
      data:
        channel === 'push'
          ? { ...data, push_lease_token: null, push_lease_until: null }
          : { ...data, email_lease_token: null, email_lease_until: null },
    });
    if (res.count !== 1) {
      this.logger.warn(`trial notice ${channel} outcome dropped (lease lost) notice=${noticeId}`);
      return false;
    }
    return true;
  }

  /**
   * B-656-5 — will the trial end charge a card? true / false, or null when
   * it cannot be known right now (the customer read failed). The customer
   * default is read only when the subscription itself has no card.
   */
  private async cardAuthority(
    subscriptionCard: boolean | null | undefined,
    userId: string,
    tx?: Tx,
  ): Promise<boolean | null> {
    if (subscriptionCard === true) return true;
    return willChargeCard(subscriptionCard, await this.customerHasDefaultCard(userId, tx));
  }

  /**
   * The client's customer-level default card (Stripe invoice default):
   * true / false, or null when the read failed (unknown, never "no card").
   */
  private async customerHasDefaultCard(userId: string, tx?: Tx): Promise<boolean | null> {
    const db = tx ?? this.prisma;
    try {
      const row = await db.connectCustomer.findUnique({
        where: { client_user_id: userId },
        select: { default_payment_method_id: true },
      });
      return !!row?.default_payment_method_id;
    } catch (err) {
      this.logger.warn(`trial notice card lookup failed: ${trialErrorClass(err)}`);
      return null;
    }
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

const TIMED_OUT = Symbol('trial-notice-timeout');

/** Resolve the promise, or TIMED_OUT after ms (calling onTimeout once). */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.();
          resolve(TIMED_OUT);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
