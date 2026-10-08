import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { ClientPurchase, PackageTrialNotice, Prisma } from '@prisma/client';
import { EmailService } from '../../email/email.service';
import { EmailTemplateKey } from '../../email/email.types';
import { NotificationKind } from '../../notifications/notification-kind';
import { formatClock } from '../../notifications/local-time';
import { NotificationsService } from '../../notifications/notifications.service';
import { resolveRecipientTimeZoneWithSource } from '../../notifications/recipient-timezone';
import { PrismaService } from '../../prisma.service';
import {
  chargeLabel,
  formatTrialAmount,
  formatTrialDate,
  trialEndingCopy,
  trialNoChargeReason,
  willChargeCard,
  type TrialEndingCopy,
  type TrialEndingCopyInput,
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
//     can never send twice in parallel or overwrite a delivered state
//     (B-656-2). The lease is released only once the send has really
//     stopped (B-TR2-117, below). Delivery is honestly at-least-once: a
//     process that dies after the provider accepted the message but before
//     the outcome write is retried after the lease expires;
//   * push re-reads the client's notification preferences at delivery: a
//     global mute records push_status 'suppressed' and sends nothing. The
//     email is a billing notice about an upcoming card charge and is sent
//     regardless of the push mute (B-656-4);
//   * the copy says what will really happen: a card is charged only when the
//     subscription or the customer still holds a payment method; a client who
//     removed the card mid-trial is told nothing will be charged (B-656-5).
//
// B-T12-116 (agent 116) — fix round 6 for Sol B-672-1/2 and Opus B-672-1,
// C-672-1/2/3/5/6:
//   * every channel claim takes its eligibility and its lease from a fresh
//     clock at the claim (the caller's start time plus the time elapsed
//     since), never the sweep's start time, so a row reached late in a slow
//     sweep holds a full lease; a claim whose preparation already used up
//     the room for the bounded transport sends nothing and gives its
//     attempt back (B-672-1 Sol, C-672-1 Opus);
//   * a notice whose purchase was cancelled or is gone is settled 'skipped'
//     (terminal) on both channels, and the retry sweep pages by
//     (created_at, id) with a resumable cursor, so no prefix of skipped,
//     unknown-card or leased rows hides a later notice (B-672-2, C-672-2);
//   * the trial end is written in main's recipient time zone
//     (resolveRecipientTimeZone: a stamped preference, else the coach's
//     zone) (B-672-1 Opus; the label rule is C-672-7, below);
//   * "plus any tax" when the subscription has Stripe automatic tax
//     (C-672-5, operator ruling 2026-10-03).
//
// B-TR2-117 (agent 117) — fix round 8 (Sol B-672-3/4, Opus C-672-7/8/9):
//   * a channel is sent only while the notice describes the purchase's current
//     started, unended trial (claim and send re-check the end); else it is
//     retired with no attempt spent, and reopened by the reconciler if a stale
//     purchase row caused it;
//   * sends are aborted at the timeout (down to the email fetch); the lease is
//     released only once a send stopped; the provider key dedups a retry;
//   * C-672-7 (ruling): a zone that is not the client's own names the time
//     and the zone ("Oct 13 at 12:30 AM EDT"), never a bare date.
//
// B-TR3-118 (agent 118) — Sol B-672-3: a channel's copy is built at its
// admission, after the claim and the preference read, from the purchase read
// last; a trial extended, cancelled, converted or ended meanwhile is never
// sent on the older snapshot (admit()).

export const TRIAL_NOTICE_MAX_ATTEMPTS = 5;
/** Stripe's default trial_will_end lead: three days before the trial end. */
export const TRIAL_NOTICE_LEAD_MS = 3 * 24 * 60 * 60 * 1000;
/** A channel claim expires after this; the transport is bounded below it. */
export const TRIAL_NOTICE_LEASE_MS = 2 * 60 * 1000;
export const TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS = 30 * 1000;
/** B-672-4 — how long an aborted send gets to stop before its lease is held. */
export const TRIAL_NOTICE_ABORT_GRACE_MS = 5 * 1000;
const RECONCILE_BATCH = 100;
/** Pages one reconcile sweep reads before it resumes on the next sweep. */
export const RECONCILE_MAX_PAGES = 50;
/**
 * Mobile route the notice should open (Your plan: trial end date + cancel).
 * C-672-3 — mobile main's push-tap router (CLIENT_PUSH_ROUTES) does not list
 * this route yet, so a tap opens Notification Center until the mobile trials
 * piece adds it; the in-app row's deep link (tgp://plan) is unaffected.
 */
export const TRIAL_ACTION_SCREEN = 'ClientPackages';
/** Give the post-commit delivery a head start before the sweeper retries. */
const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
const SWEEP_BATCH = 50;
/** B-672-2 — pages one retry sweep reads before it resumes from its cursor. */
export const SWEEP_MAX_PAGES = 20;
/** B-672-2 — a sweep stops paging after this and resumes next time. */
export const SWEEP_BUDGET_MS = 8 * 60 * 1000;

type Tx = Prisma.TransactionClient | PrismaService;
type Channel = 'push' | 'email';

export type TrialNoticeSource = 'trial_will_end' | 'trial_start' | 'sweep';

/** B-672-3 — why a notice is retired instead of sent. */
export type TrialNoticeSkipCode =
  | 'purchase_canceled'
  | 'purchase_missing'
  | 'trial_ended'
  | 'trial_not_started'
  | 'trial_superseded';

/** B-672-3 — retirements an out-of-order event can cause; see reopen(). */
const REOPENABLE_SKIPS = new Set([
  'skip:trial_ended',
  'skip:trial_not_started',
  'skip:trial_superseded',
]);

/**
 * B-672-3 — does the notice still describe the purchase's current trial at
 * `at`? null when it does, else the code the notice is retired with.
 */
export function trialNoticeSkipCode(
  notice: { trial_ends_at: Date },
  purchase: { status: string; entitlement_active: boolean; trial_ends_at: Date | null } | null,
  at: Date,
): TrialNoticeSkipCode | null {
  if (!purchase) return 'purchase_missing';
  if (purchase.status === 'canceled') return 'purchase_canceled';
  const end = notice.trial_ends_at.getTime();
  if (end <= at.getTime() || purchase.status !== 'trialing') return 'trial_ended';
  if (!purchase.entitlement_active) return 'trial_not_started';
  if (purchase.trial_ends_at?.getTime() !== end) return 'trial_superseded';
  return null;
}

/** C-672-7 — the zone a trial end is written in, and whether it is the client's. */
export type TrialNoticeZone = { timeZone: string | null; own: boolean };

/**
 * C-672-7 (operator ruling) — "Oct 12" in the client's own zone; in any other
 * zone (the coach's, else UTC) the date alone can be a day off, so the time
 * and the zone are named: "Oct 13 at 12:30 AM EDT".
 */
export function trialEndLabel(end: Date, zone: TrialNoticeZone): string {
  const tz = zone.timeZone || 'UTC';
  const date = formatTrialDate(end, tz);
  return zone.own && zone.timeZone ? date : `${date} at ${formatClock(end, tz)}`;
}

/** The trial-ending copy with the C-672-7 end label (in-app, push, email lead). */
export function trialNoticeCopy(
  input: Omit<TrialEndingCopyInput, 'timeZone'>,
  zone: TrialNoticeZone,
): TrialEndingCopy {
  const copy = trialEndingCopy({ ...input, timeZone: zone.timeZone || 'UTC' });
  const label = trialEndLabel(input.trialEndsAt, zone);
  // Every trial-ending body opens with "Your free trial ends on <date>."
  const body = copy.body.replace(`ends on ${copy.dateLabel}.`, `ends on ${label}.`);
  return { ...copy, dateLabel: label, body };
}

type NoticePurchase = Pick<
  ClientPurchase,
  'id' | 'client_user_id' | 'package_id' | 'amount_cents' | 'currency'
>;

/** What a channel delivery reads of the purchase (B-672-3: trial truth too). */
const DELIVERY_PURCHASE_SELECT = {
  id: true,
  cancel_at_period_end: true,
  card_on_file: true,
  status: true,
  entitlement_active: true,
  trial_ends_at: true,
  coach_user_id: true,
  package: { select: { name: true, interval: true, interval_count: true } },
  coach: { select: { name: true } },
  client: { select: { email: true, name: true } },
} as const satisfies Prisma.ClientPurchaseSelect;
type DeliveryPurchase = Prisma.ClientPurchaseGetPayload<{
  select: typeof DELIVERY_PURCHASE_SELECT;
}>;
/** B-672-3 — the purchase truth, card state and copy one channel is sent on. */
type Prepared = { purchase: DeliveryPurchase; cardOnFile: boolean; copy: TrialEndingCopy };

export interface RecordTrialNoticeArgs {
  purchase: NoticePurchase;
  trialEndsAt: Date;
  amountCents: number;
  currency: string;
  cancelAtPeriodEnd: boolean;
  /** A payment method will really be charged at the trial end. */
  cardOnFile: boolean;
  /** C-672-5 — Stripe may add tax at the trial end (automatic tax). */
  taxMayApply?: boolean;
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
  /** C-672-5 — Stripe automatic tax on the subscription's invoices. */
  automatic_tax?: { enabled?: boolean | null } | null;
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

/** C-672-5 — Stripe may add tax to the trial-end invoice. */
export function subscriptionTaxMayApply(sub: TrialWillEndSubscription): boolean {
  return sub.automatic_tax?.enabled === true;
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
  /** B-672-2 — keyset position when a retry sweep hit its page/time budget. */
  private sweepCursor: { createdAt: Date; id: string } | null = null;
  /** B-672-4 — sends still running in this process, by `<notice>:<channel>`. */
  private readonly running = new Map<string, Promise<void>>();

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
      taxMayApply: subscriptionTaxMayApply(sub),
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
      taxMayApply: subscriptionTaxMayApply(args.sub),
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
          tax_may_apply: args.taxMayApply === true,
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

    const copy = trialNoticeCopy(
      {
        trialEndsAt,
        amountCents: args.amountCents,
        currency: args.currency,
        cancelAtPeriodEnd: args.cancelAtPeriodEnd,
        cardOnFile: args.cardOnFile,
        taxMayApply: args.taxMayApply === true,
      },
      await this.noticeZone(purchase.client_user_id, tx),
    );
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

  /**
   * Deliver push + email for a recorded notice. Never throws. Every claim
   * reads a fresh clock from `now` (B-672-1). Each channel is checked before
   * its claim (a retired notice spends no claim) and prepared again at its
   * admission, which builds the copy that is sent (B-672-3).
   */
  async deliver(noticeId: string, now: Date = new Date()): Promise<void> {
    const clock = elapsedClock(now);
    try {
      const notice = await this.prisma.packageTrialNotice.findUnique({ where: { id: noticeId } });
      if (!notice) return;
      if (channelOpen(notice, 'push')) {
        if (!(await this.prepare(notice, clock))) return;
        await this.deliverPush(notice, clock);
      }
      if (!channelOpen(notice, 'email') || !this.email) return;
      if (!(await this.prepare(notice, clock))) return;
      await this.deliverEmail(notice, clock);
    } catch (err) {
      this.logger.error(`trial notice delivery failed notice=${noticeId}: ${trialErrorClass(err)}`);
    }
  }

  /**
   * B-672-3 — the truth one channel is sent on: the notice must describe the
   * purchase's current started, unended trial (else it is retired) and the
   * card state must be known (else it stays pending). null: send nothing.
   * B-TR4-119 (Sol B-672-3): the zone is read first; the purchase and the
   * customer card then come from one REPEATABLE READ snapshot, so neither
   * authority can outdate the other (a later commit is a post-admission change).
   */
  private async prepare(notice: PackageTrialNotice, clock: () => Date): Promise<Prepared | null> {
    const zone = await this.noticeZone(notice.client_user_id);
    const [purchase, customerCard] = await this.prisma.$transaction(
      async (tx) =>
        [
          await tx.clientPurchase.findUnique({
            where: { id: notice.purchase_id },
            select: DELIVERY_PURCHASE_SELECT,
          }),
          await this.customerHasDefaultCard(notice.client_user_id, tx),
        ] as const,
      { isolationLevel: 'RepeatableRead' },
    );
    const skip = trialNoticeSkipCode(notice, purchase, clock());
    if (skip || !purchase) {
      await this.settleSkipped(notice.id, skip ?? 'purchase_missing');
      return null;
    }
    // B-656-5 — the truth at delivery time (the card may have been removed
    // or replaced since the notice was recorded).
    const cardOnFile = willChargeCard(purchase.card_on_file, customerCard);
    if (cardOnFile === null) {
      // Unknown card state (the read failed): send nothing rather than a
      // wrong promise; the channels stay pending and the sweep retries.
      this.logger.warn(
        `trial notice delivery deferred notice=${notice.id} code=card_state_unknown`,
      );
      return null;
    }
    const copy = trialNoticeCopy(
      {
        trialEndsAt: notice.trial_ends_at,
        amountCents: notice.amount_cents,
        currency: notice.currency,
        cancelAtPeriodEnd: purchase.cancel_at_period_end,
        cardOnFile,
        taxMayApply: notice.tax_may_apply,
      },
      zone,
    );
    return { purchase, cardOnFile, copy };
  }

  /**
   * Every 10 minutes: record notices that are due but missing (B-656-3), then
   * retry undelivered channels. Multi-replica safe (unique notice key and
   * per-channel leases).
   */
  @Cron('*/10 * * * *', { name: 'trial-notice-sweep', timeZone: 'UTC' })
  async sweep(now: Date = new Date()): Promise<number> {
    const clock = elapsedClock(now);
    let reconciled = 0;
    try {
      reconciled = await this.reconcileDue(now);
    } catch (err) {
      // A reconcile failure never blocks the delivery retries below.
      this.logger.error(`trial notice reconcile errored: ${trialErrorClass(err)}`);
    }
    // B-672-2 — keyset paging on (created_at, id): rows that stay pending
    // (unknown card, a live lease elsewhere) never hold back the rows after
    // them. A sweep that hits its page or time budget resumes from its
    // cursor next time; a sweep that reaches the end starts over next time.
    let cursor = this.sweepCursor;
    this.sweepCursor = null;
    let handled = 0;
    for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
      const at = clock();
      const due = await this.prisma.packageTrialNotice.findMany({
        where: {
          AND: [
            {
              trial_ends_at: { gt: at },
              created_at: { lt: new Date(at.getTime() - SWEEP_MIN_AGE_MS) },
              OR: [
                { push_status: 'pending', push_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS } },
                { email_status: 'pending', email_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS } },
              ],
            },
            ...(cursor
              ? [
                  {
                    OR: [
                      { created_at: { gt: cursor.createdAt } },
                      { created_at: cursor.createdAt, id: { gt: cursor.id } },
                    ],
                  },
                ]
              : []),
          ],
        },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: SWEEP_BATCH,
        select: { id: true, created_at: true },
      });
      for (const row of due) await this.deliver(row.id, clock());
      handled += due.length;
      if (due.length < SWEEP_BATCH) return reconciled + handled;
      const last = due[due.length - 1];
      cursor = { createdAt: last.created_at, id: last.id };
      if (clock().getTime() - now.getTime() >= SWEEP_BUDGET_MS) break;
    }
    this.sweepCursor = cursor;
    this.logger.warn('trial notice sweep hit its page or time budget; resumes next sweep');
    return reconciled + handled;
  }

  /**
   * B-656-3 — started trials (trialing with access) that end within the
   * warning window and have no notice for that trial end yet. Covers a
   * trial_will_end event that arrived before the card was saved, a trial
   * that started on a code path without the start hook, and a webhook
   * endpoint that is missing the event. Returns how many it recorded.
   */
  async reconcileDue(now: Date = new Date()): Promise<number> {
    const clock = elapsedClock(now);
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
      recorded += await this.reconcilePage(candidates, now, clock);
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
    clock: () => Date,
  ): Promise<number> {
    const existing = await this.prisma.packageTrialNotice.findMany({
      where: { purchase_id: { in: candidates.map((c) => c.id) } },
      select: { id: true, purchase_id: true, trial_ends_at: true, last_error: true },
    });
    const have = new Map(existing.map((n) => [`${n.purchase_id}:${n.trial_ends_at.getTime()}`, n]));
    let recorded = 0;
    for (const p of candidates) {
      const end = p.trial_ends_at;
      if (!end) continue;
      const prior = have.get(`${p.id}:${end.getTime()}`);
      try {
        if (prior) {
          // B-672-3 — retired while the purchase row disagreed (out of order).
          if (await this.reopen(prior.id, prior.last_error)) {
            recorded += 1;
            await this.deliver(prior.id, clock());
          }
          continue;
        }
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
          await this.deliver(id, clock());
        }
      } catch (err) {
        this.logger.error(
          `trial notice reconcile failed purchase=${p.id}: ${trialErrorClass(err)}`,
        );
      }
    }
    return recorded;
  }

  private async deliverPush(notice: PackageTrialNotice, clock: () => Date): Promise<void> {
    // B-672-4 — never a second push of this notice while one is still running here.
    if (this.running.has(`${notice.id}:push`)) return;
    const lease = await this.claim(notice.id, 'push', clock());
    if (!lease) return;
    let status: 'delivered' | 'no_token' | 'suppressed' | 'pending' | 'failed';
    let error: string | null = null;
    // B-656-4 — the client's preferences at delivery time (a mute set after
    // the notice was recorded still applies).
    const prefs = await this.notifications.getPreferences(notice.client_user_id);
    // B-672-1 / B-672-3 — the preference read may have used up the lease, run
    // past the trial end or outlived the purchase truth: the copy is built now.
    const ready = await this.admit(notice, 'push', lease, clock);
    if (!ready) return;
    let sent: Bounded<PushOutcome> | null = null;
    if ((prefs as Record<string, unknown>).muted === true) {
      status = 'suppressed';
    } else {
      sent = await this.bounded(`${notice.id}:push`, (signal) =>
        this.notifications.pushToUser(
          notice.client_user_id,
          ready.copy.title,
          ready.copy.body,
          {
            kind: NotificationKind.TRIAL_ENDING,
            purchase_id: notice.purchase_id,
            deep_link: 'tgp://plan',
            // Your plan, where the trial end date and the cancel path live,
            // once the app's push-tap router lists it (C-672-3, see above).
            actionScreen: TRIAL_ACTION_SCREEN,
          },
          signal,
        ),
      );
      const result = sent.result;
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
    const outcome = { push_status: status, ...(error ? { last_error: error } : {}) };
    if (sent && !sent.stopped) {
      await this.holdLease(notice.id, 'push', lease.token, outcome, sent.done, clock);
      return;
    }
    await this.complete(notice.id, 'push', lease.token, outcome);
  }

  private async deliverEmail(notice: PackageTrialNotice, clock: () => Date): Promise<void> {
    const mailer = this.email;
    if (!mailer) return;
    // B-672-4 — never a second email of this notice while one is still running here.
    if (this.running.has(`${notice.id}:email`)) return;
    const lease = await this.claim(notice.id, 'email', clock());
    if (!lease) return;
    // B-672-3 — the copy is built at admission, from the purchase as it is now.
    const ready = await this.admit(notice, 'email', lease, clock);
    if (!ready) return;
    const { purchase, copy } = ready;
    const to = purchase.client?.email;
    if (!to) {
      await this.complete(notice.id, 'email', lease.token, { email_status: 'no_email' });
      return;
    }
    const pkg = purchase.package;
    const reason = trialNoChargeReason({
      cancelAtPeriodEnd: purchase.cancel_at_period_end,
      cardOnFile: ready.cardOnFile,
    });
    // Attempt 1 keeps the original key; every later attempt gets its own key
    // (EmailService treats a reused key as already sent) and starts only once
    // the earlier send stopped (B-672-4). The provider key is the same on every
    // attempt, so the same message is not delivered twice; changed content is new.
    const baseKey = `trial-ending:${notice.purchase_id}:${notice.trial_ends_at.getTime()}`;
    const idempotencyKey = lease.attempt === 1 ? baseKey : `${baseKey}:a${lease.attempt}`;
    let status: 'sent' | 'pending' | 'failed' = 'pending';
    let error: string | null = null;
    let sent: Bounded<Awaited<ReturnType<EmailService['send']>>> | null = null;
    try {
      sent = await this.bounded(`${notice.id}:email`, (signal) =>
        mailer.send({
          to,
          template: EmailTemplateKey.TRIAL_ENDING,
          replyToCoachUserId: purchase.coach_user_id,
          idempotencyKey,
          providerIdempotencyKey: baseKey,
          signal,
          data: {
            recipient_name: firstName(purchase.client?.name),
            plan_name: pkg?.name ?? 'your plan',
            coach_name: purchase.coach?.name ?? null,
            trial_end_date: copy.dateLabel,
            amount_display: chargeLabel(
              formatTrialAmount(notice.amount_cents, notice.currency),
              notice.tax_may_apply,
            ),
            cadence: cadenceLabel(pkg?.interval, pkg?.interval_count),
            will_charge: reason === null,
            no_card: reason === 'no_card',
          },
        }),
      );
      const res = sent.result;
      if (res === TIMED_OUT) error = 'email:timeout';
      else if (res.status === 'failed') error = `email:${res.error ? 'provider_failed' : 'failed'}`;
      else status = 'sent';
    } catch (err) {
      error = `email:${trialErrorClass(err)}`;
    }
    if (status !== 'sent' && lease.attempt >= TRIAL_NOTICE_MAX_ATTEMPTS) status = 'failed';
    const outcome = { email_status: status, ...(error ? { last_error: error } : {}) };
    if (sent && !sent.stopped) {
      await this.holdLease(notice.id, 'email', lease.token, outcome, sent.done, clock);
      return;
    }
    await this.complete(notice.id, 'email', lease.token, outcome);
  }

  /**
   * B-656-2 — exclusive claim on one channel: pending, under the attempt cap,
   * and no live lease. Returns the lease token and this attempt's number.
   */
  private async claim(
    noticeId: string,
    channel: Channel,
    now: Date,
  ): Promise<{ token: string; attempt: number; until: Date } | null> {
    const token = randomUUID();
    const until = new Date(now.getTime() + TRIAL_NOTICE_LEASE_MS);
    const where: Prisma.PackageTrialNoticeWhereInput =
      channel === 'push'
        ? {
            id: noticeId,
            push_status: 'pending',
            push_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS },
            // B-672-3 — never admitted once the trial has ended.
            trial_ends_at: { gt: now },
            OR: [{ push_lease_until: null }, { push_lease_until: { lt: now } }],
          }
        : {
            id: noticeId,
            email_status: 'pending',
            email_attempts: { lt: TRIAL_NOTICE_MAX_ATTEMPTS },
            trial_ends_at: { gt: now },
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
    return {
      token,
      attempt: channel === 'push' ? row.push_attempts : row.email_attempts,
      until,
    };
  }

  /**
   * The last check before a send, after the claim and any preference read
   * (fenced; a refused claim gives its attempt back). B-672-3 (B-TR3-118): the
   * notice is prepared again here and only this copy is sent; a notice that no
   * longer describes the current trial retires, an unknown card stays pending.
   * B-672-1: the lease must still cover the bounded transport and its abort
   * grace (else retried later).
   */
  private async admit(
    notice: PackageTrialNotice,
    channel: Channel,
    lease: { token: string; until: Date },
    clock: () => Date,
  ): Promise<Prepared | null> {
    const ready = await this.prepare(notice, clock);
    const room =
      lease.until.getTime() - TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS - TRIAL_NOTICE_ABORT_GRACE_MS;
    if (ready && clock().getTime() < room) return ready;
    const why = ready ? { last_error: `${channel}:lease_exhausted` } : {};
    await this.complete(
      notice.id,
      channel,
      lease.token,
      channel === 'push'
        ? { push_attempts: { increment: -1 }, ...why }
        : { email_attempts: { increment: -1 }, ...why },
    );
    return null;
  }

  /** B-672-2 / B-672-3 — retire every still-pending channel ('skipped'; see reopen()). */
  private async settleSkipped(noticeId: string, code: TrialNoticeSkipCode): Promise<void> {
    const last_error = `skip:${code}`;
    await this.prisma.packageTrialNotice.updateMany({
      where: { id: noticeId, push_status: 'pending' },
      data: { push_status: 'skipped', last_error },
    });
    await this.prisma.packageTrialNotice.updateMany({
      where: { id: noticeId, email_status: 'pending' },
      data: { email_status: 'skipped', last_error },
    });
  }

  /** B-672-3 — the reconciler found the notice current again: reopen what a REOPENABLE_SKIPS retirement settled. */
  private async reopen(noticeId: string, lastError: string | null): Promise<boolean> {
    if (!lastError || !REOPENABLE_SKIPS.has(lastError)) return false;
    const push = await this.prisma.packageTrialNotice.updateMany({
      where: { id: noticeId, push_status: 'skipped', last_error: lastError },
      data: { push_status: 'pending' },
    });
    const email = await this.prisma.packageTrialNotice.updateMany({
      where: { id: noticeId, email_status: 'skipped', last_error: lastError },
      data: { email_status: 'pending' },
    });
    if (push.count + email.count === 0) return false;
    await this.prisma.packageTrialNotice.updateMany({
      where: { id: noticeId, last_error: lastError },
      data: { last_error: null },
    });
    return true;
  }

  /**
   * B-672-4 — one send, really bounded: aborted at the transport timeout,
   * then given the abort grace to stop (`stopped`); `done` settles when it
   * has ended. While it runs this process starts no other send of `key`.
   */
  private async bounded<T>(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
  ): Promise<Bounded<T>> {
    const controller = new AbortController();
    const op = Promise.resolve().then(() => start(controller.signal));
    const done = op.then(
      () => undefined,
      () => undefined,
    );
    this.running.set(key, done);
    void done.then(() => {
      if (this.running.get(key) === done) this.running.delete(key);
    });
    const result = await withTimeout(op, TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS, () =>
      controller.abort(),
    );
    if (result !== TIMED_OUT) return { result, stopped: true, done };
    const stopped = (await withTimeout(done, TRIAL_NOTICE_ABORT_GRACE_MS)) !== TIMED_OUT;
    return { result, stopped, done };
  }

  /**
   * B-672-4 — the send ignored its abort and may still reach the provider:
   * write the outcome but keep the lease, renewed while the send runs, so no
   * replica starts another attempt; release it once the send has ended.
   */
  private async holdLease(
    noticeId: string,
    channel: Channel,
    token: string,
    outcome: Prisma.PackageTrialNoticeUpdateManyMutationInput,
    done: Promise<void>,
    clock: () => Date,
  ): Promise<void> {
    const where =
      channel === 'push'
        ? { id: noticeId, push_lease_token: token }
        : { id: noticeId, email_lease_token: token };
    const renew = (data: Prisma.PackageTrialNoticeUpdateManyMutationInput) => {
      const until = new Date(clock().getTime() + TRIAL_NOTICE_LEASE_MS);
      const lease = channel === 'push' ? { push_lease_until: until } : { email_lease_until: until };
      return this.prisma.packageTrialNotice.updateMany({ where, data: { ...data, ...lease } });
    };
    const failed = (step: string) => (err: unknown) =>
      this.logger.warn(
        `trial notice ${channel} lease ${step} failed notice=${noticeId}: ${trialErrorClass(err)}`,
      );
    await renew(outcome);
    this.logger.warn(
      `trial notice ${channel} still running after abort notice=${noticeId}; lease held`,
    );
    const timer = setInterval(
      () => void renew({}).catch(failed('renew')),
      TRIAL_NOTICE_LEASE_MS / 2,
    );
    timer.unref?.();
    void done
      .then(() => {
        clearInterval(timer);
        return this.complete(noticeId, channel, token, {});
      })
      .catch(failed('release'));
  }

  /** Fenced outcome: only the current lease holder may write it. */
  private async complete(
    noticeId: string,
    channel: Channel,
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

  /** Main's recipient zone rule (B-672-1 Opus); C-672-7 `own`: it is the client's own zone. */
  private async noticeZone(userId: string, tx?: Tx): Promise<TrialNoticeZone> {
    const zone = await resolveRecipientTimeZoneWithSource(tx ?? this.prisma, userId);
    return {
      timeZone: zone?.timeZone ?? null,
      own: zone?.source === 'recipient' || zone?.source === 'own_coach_profile',
    };
  }
}

/** The channel is still owed (pending, under the attempt cap). */
function channelOpen(notice: PackageTrialNotice, channel: Channel): boolean {
  return channel === 'push'
    ? notice.push_status === 'pending' && notice.push_attempts < TRIAL_NOTICE_MAX_ATTEMPTS
    : notice.email_status === 'pending' && notice.email_attempts < TRIAL_NOTICE_MAX_ATTEMPTS;
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

/**
 * B-672-1 — a clock that starts at `start` (the caller's notion of now, so
 * tests and replays can pin it) and advances with real elapsed time.
 */
function elapsedClock(start: Date): () => Date {
  const wallAtStart = Date.now();
  return () => new Date(start.getTime() + (Date.now() - wallAtStart));
}

const TIMED_OUT = Symbol('trial-notice-timeout');

/** B-672-4 — a bounded send: its result, whether it stopped, when it ends. */
type Bounded<T> = { result: T | typeof TIMED_OUT; stopped: boolean; done: Promise<void> };
type PushOutcome = Awaited<ReturnType<NotificationsService['pushToUser']>>;

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
