import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { ConnectService } from '../../connect/connect.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../../connect/stripe-connect-api.service';
import { isConnectAccountReadyForCheckout } from '../../storefront/storefront.service';
import { CoachAlertEmitter } from '../../notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../../notifications/notification-kind';
import { EmailService } from '../../email/email.service';
import { EmailTemplateKey } from '../../email/email.types';
import {
  DUNNING_NOTICE_CLAIM_MS,
  DUNNING_NOTICE_MAX_ATTEMPTS,
  DUNNING_V2_REVERSAL_REASON,
  DunningV2Service,
  FULL_REFUND_PAUSE_REASON,
  isBillingPauseReason,
} from './dunning-v2.service';
import { dunningErrorCode } from './dunning-v2.safe-error';
import { isDunningV2Enabled } from './dunning-v2.feature';
import {
  COACH_ACCOUNT_HOLD_REASON,
  COACH_ACCOUNT_HOLD_RETRY_MS,
  HOLD_NOTICE_CHANNELS,
  type HoldNoticeChannel,
  type HoldNoticeCursor,
  coachAccountHoldNotice,
  coachAccountHoldRetryKey,
  coachLocalDay,
  holdNoticeCursor,
  isCoachAccountHoldEnabled,
  isHeldRenewal,
  parseHoldNoticeCursor,
} from './coach-account-hold';

type Db = Prisma.TransactionClient | PrismaService;

/** The notice row's holder while no send holds it. */
const NOTICE_IDLE = 'pf7';

function noticeName(coachUserId: string): string {
  return `coach-account-hold-notice:${coachUserId}`;
}

/** FR-1195 (LS-1195 B2): one row per renewal invoice the hold saw paid. */
function paidName(invoiceId: string): string {
  return `coach-account-hold-paid:${invoiceId}`;
}

/** What invoice.paid does to a held renewal (onRenewalPaid). */
export type HeldRenewalPaid = 'keep' | 'end' | 'unknown';

/** Rows this file may move into a hold: open, not the client's own cancel, not a dispute/refund pause. */
function holdableWhere(purchaseId: string): Prisma.DunningStateWhereInput {
  return {
    purchase_id: purchaseId,
    status: 'active',
    client_canceled_at: null,
    // Explicit null arm: SQL `NOT IN` drops NULL reasons.
    OR: [
      { last_failure_reason: null },
      { last_failure_reason: { notIn: [DUNNING_V2_REVERSAL_REASON, FULL_REFUND_PAUSE_REASON] } },
    ],
  };
}

/** Waiting renewals the hourly sweep looks at. */
const HELD_WHERE: Prisma.DunningStateWhereInput = {
  status: 'active',
  client_canceled_at: null,
  last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
};

/**
 * PF-7-BE (owner #PF-STRIPE option 1, rulings R1-R6): a renewal that fails
 * while the coach's own Stripe account can't take payments waits, instead
 * of starting the client's ten failed-payment days. The cause is decided
 * from a fresh read of the coach's account through the one readiness rule
 * (isConnectAccountReadyForCheckout), never the saved row alone and never
 * anything the client sent. No webhook tells the platform when an Express
 * account is fixed, so the hourly sweep re-reads held coaches' accounts.
 */
@Injectable()
export class CoachAccountHoldService {
  private readonly logger = new Logger(CoachAccountHoldService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
    private readonly v2: DunningV2Service,
    @Optional() private readonly connect?: ConnectService,
    @Optional() private readonly coachAlert?: CoachAlertEmitter,
    @Optional() private readonly email?: EmailService,
  ) {}

  enabled(): boolean {
    return isCoachAccountHoldEnabled();
  }

  /**
   * True: the coach's account can take payments. False: it can't. Null: no
   * fresh answer from Stripe (unsure). Never throws.
   */
  async freshCoachAccountReady(coachUserId: string): Promise<boolean | null> {
    if (!this.connect) return null;
    try {
      const { row, fresh } = await this.connect.freshAccountForCoach(coachUserId);
      if (!fresh) return null;
      return isConnectAccountReadyForCheckout(row);
    } catch (err) {
      this.logger.warn(`coach account read failed: ${dunningErrorCode(err)}`);
      return null;
    }
  }

  /**
   * After v1 recordFailure, on invoice.payment_failed. Returns true when the
   * renewal now waits (the caller then starts no ten-day cycle). `ready`
   * undefined = not read (switch off), which leaves main's path untouched.
   * `db` is the webhook's transaction when there is one (the purchase row is
   * locked there; the lock lift of R3 must go through it).
   */
  async onRenewalFailed(
    purchase: Pick<
      ClientPurchase,
      'id' | 'client_user_id' | 'coach_user_id' | 'amount_cents' | 'billing_type' | 'stripe_subscription_id'
    >,
    ready: boolean | null | undefined,
    db: Db = this.prisma,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (ready === undefined || !this.enabled()) return false;
    if (!DunningV2Service.isEligiblePurchase(purchase)) return false;
    if (ready !== false) {
      // R2/R5: a failure on a ready account is the card. Unsure (no fresh
      // answer) is never a guess that the account is the cause: main's ten
      // days, so nothing changes for a coach whose account can take
      // payments. A renewal that was waiting leaves the hold; the caller's
      // Day 0 claim starts the ten days from now.
      await this.prisma.dunningState.updateMany({
        where: { purchase_id: purchase.id, last_failure_reason: COACH_ACCOUNT_HOLD_REASON },
        data: { last_failure_reason: null },
      });
      return false;
    }
    const before = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchase.id },
      select: { status: true, locked_out_at: true, last_failure_reason: true },
    });
    if (!before || before.status !== 'active' || isBillingPauseReason(before.last_failure_reason)) {
      return false;
    }
    // R1 + R3: wait. An open cycle stops (step -1; a new entered_at retires
    // its queued notices, which are keyed to the old cycle) and any Day-10
    // lock is lifted.
    const moved = await this.prisma.dunningState.updateMany({
      where: holdableWhere(purchase.id),
      data: {
        last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
        step_index: -1,
        entered_at: now,
        locked_out_at: null,
      },
    });
    if (moved.count === 0) return false;
    if (before.locked_out_at) {
      await db.clientPurchase.update({
        where: { id: purchase.id },
        data: { entitlement_active: true },
      });
    }
    // The client is told nothing (R1): no card blocker stays up.
    await this.prisma.notification.updateMany({
      where: {
        user_id: purchase.client_user_id,
        kind: NotificationKind.DUNNING_BLOCKER,
        read_at: null,
      },
      data: { read_at: now },
    });
    void this.notifyCoach(purchase.coach_user_id, now).catch((err) =>
      this.logger.warn(`coach hold notice failed: ${dunningErrorCode(err)}`),
    );
    return true;
  }

  /** How many renewals wait on this coach's Stripe account now. */
  countWaiting(coachUserId: string): Promise<number> {
    return this.prisma.dunningState.count({
      where: { ...HELD_WHERE, purchase: { coach_user_id: coachUserId } },
    });
  }

  /**
   * R4: PF-W8 by push and email, with the count, at most once per coach per
   * calendar day in the coach's zone. One CronLease row per coach holds the
   * notice: its cursor is the day told and the channels still owed
   * (parseHoldNoticeCursor). Taking a new day is a compare-and-set on the
   * row as read, so two failures at once tell the coach once. Names no client.
   */
  async notifyCoach(coachUserId: string, now: Date = new Date()): Promise<boolean> {
    const prefs = await this.prisma.notificationPreferences.findUnique({
      where: { user_id: coachUserId },
      select: { timezone: true },
    });
    const day = coachLocalDay(now, prefs?.timezone ?? null);
    const name = noticeName(coachUserId);
    try {
      await this.prisma.cronLease.upsert({
        where: { name },
        create: { name, holder: NOTICE_IDLE, lease_until: now, acquired_at: now, cursor: '' },
        update: {},
      });
    } catch {
      // A concurrent first create; the compare-and-set below decides.
    }
    const row = await this.prisma.cronLease.findUnique({
      where: { name },
      select: { holder: true, cursor: true },
    });
    if (!row || parseHoldNoticeCursor(row.cursor)?.day === day) return false;
    const notice: HoldNoticeCursor = { day, owed: [...HOLD_NOTICE_CHANNELS], sends: 0 };
    const token = randomUUID();
    const won = await this.prisma.cronLease.updateMany({
      where: { name, holder: row.holder, cursor: row.cursor },
      data: {
        cursor: holdNoticeCursor(notice),
        holder: token,
        lease_until: new Date(now.getTime() + DUNNING_NOTICE_CLAIM_MS),
      },
    });
    if (won.count !== 1) return false;
    return this.sendNotice(coachUserId, token, notice, now);
  }

  /**
   * FR-1195 (LS-1195 B1): the hourly sweep sends again only the channels of
   * the coach's last notice that failed; a delivered channel is never sent
   * twice. A send in flight holds the row for DUNNING_NOTICE_CLAIM_MS (a
   * crashed one is taken over after it, with the same email key); a notice
   * stops after DUNNING_NOTICE_MAX_ATTEMPTS sends, as the dunning outbox.
   */
  async retryNotice(coachUserId: string, now: Date = new Date()): Promise<boolean> {
    const name = noticeName(coachUserId);
    const row = await this.prisma.cronLease.findUnique({
      where: { name },
      select: { holder: true, cursor: true, lease_until: true },
    });
    const notice = parseHoldNoticeCursor(row?.cursor);
    if (!row || !notice || notice.owed.length === 0) return false;
    if (row.lease_until.getTime() > now.getTime()) return false;
    if (notice.sends >= DUNNING_NOTICE_MAX_ATTEMPTS) return false;
    const token = randomUUID();
    const won = await this.prisma.cronLease.updateMany({
      where: { name, holder: row.holder, cursor: row.cursor, lease_until: { lte: now } },
      data: { holder: token, lease_until: new Date(now.getTime() + DUNNING_NOTICE_CLAIM_MS) },
    });
    if (won.count !== 1) return false;
    return this.sendNotice(coachUserId, token, notice, now);
  }

  /**
   * Send a claimed notice's owed channels with today's count, then record
   * what is still owed, only while this claim holds the row (a newer day's
   * notice replaces it). No renewal waiting any more: nothing is owed. A
   * throw leaves the claim to expire, so the next sweep tries again.
   */
  private async sendNotice(
    coachUserId: string,
    token: string,
    notice: HoldNoticeCursor,
    now: Date,
  ): Promise<boolean> {
    const count = await this.countWaiting(coachUserId);
    const owed =
      count < 1 ? [] : await this.deliverNotice(coachUserId, notice, coachAccountHoldNotice(count));
    await this.prisma.cronLease.updateMany({
      where: { name: noticeName(coachUserId), holder: token },
      data: {
        cursor: holdNoticeCursor({ day: notice.day, owed, sends: notice.sends + 1 }),
        holder: NOTICE_IDLE,
        lease_until: now,
      },
    });
    return count >= 1;
  }

  /** One try of each owed channel; returns the ones that failed (still owed). Never throws. */
  private async deliverNotice(
    coachUserId: string,
    notice: HoldNoticeCursor,
    message: string,
  ): Promise<HoldNoticeChannel[]> {
    const alertId = `coach_account_hold:${coachUserId}:${notice.day}`;
    const owed = new Set(notice.owed);
    const left: HoldNoticeChannel[] = [];
    const inapp = owed.has('inapp');
    const push = owed.has('push');
    if ((inapp || push) && this.coachAlert) {
      // One emitter call for whichever of the feed row and the push is owed.
      const delivery = await this.coachAlert
        .emit(
          {
            coachId: coachUserId,
            alertId,
            alertType: 'coach_account_hold',
            message,
            severity: 'warning',
            money: true,
          },
          { inapp, push },
        )
        .catch((err: unknown) => {
          this.logger.warn(`coach hold notice alert failed: ${dunningErrorCode(err)}`);
          return null;
        });
      // An emitter that returns no verdict counts as sent, as in dunning v2.
      if (inapp && (delivery === null || delivery?.inapp === 'failed')) left.push('inapp');
      if (push && (delivery === null || delivery?.push === 'failed')) left.push('push');
    }
    if (owed.has('email') && this.email) {
      try {
        const coach = await this.prisma.user.findUnique({
          where: { id: coachUserId },
          select: { email: true },
        });
        if (coach?.email) {
          // EmailService keeps a failed key, so a resend has its own.
          const res = await this.email.send({
            to: coach.email,
            template: EmailTemplateKey.DUNNING_V2_COACH,
            idempotencyKey: `${alertId}:email${notice.sends > 0 ? `:r${notice.sends}` : ''}`,
            data: { roman_body: message, coach_account_hold: true },
          });
          if (res?.status === 'failed') left.push('email');
        }
      } catch (err) {
        this.logger.warn(`coach hold notice email failed: ${dunningErrorCode(err)}`);
        left.push('email');
      }
    }
    return left;
  }

  /**
   * R5/R6, hourly. Switch off: every waiting renewal starts the normal ten
   * days now. Switch on: re-read each held coach's account; when it can take
   * payments, pay each waiting renewal invoice once (one Stripe key per
   * invoice and hold, retryHeld); while it can't, send again what the
   * coach's notice still owes (retryNotice). A row is looked at no more than
   * once an hour, and the look is claimed first, so overlapping sweeps never
   * pay or notify twice.
   */
  async runSweep(now: Date = new Date()): Promise<{ released: number; retried: number }> {
    const out = { released: 0, retried: 0 };
    if (!isDunningV2Enabled()) return out;
    const rows = await this.prisma.dunningState.findMany({
      where: HELD_WHERE,
      select: {
        id: true,
        purchase_id: true,
        entered_at: true,
        purchase: { select: { coach_user_id: true, stripe_subscription_id: true } },
      },
      orderBy: { sweep_checked_at: { sort: 'asc', nulls: 'first' } },
      take: 200,
    });
    const readiness = new Map<string, Promise<boolean | null>>();
    const noticed = new Set<string>();
    // Whole minutes, so the hourly cron's start-time jitter never pushes a
    // row to every other hour.
    const tick = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    for (const row of rows) {
      const claimed = await this.prisma.dunningState.updateMany({
        where: {
          id: row.id,
          last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
          OR: [
            { sweep_checked_at: null },
            { sweep_checked_at: { lte: new Date(tick.getTime() - COACH_ACCOUNT_HOLD_RETRY_MS) } },
          ],
        },
        data: { sweep_checked_at: tick },
      });
      if (claimed.count !== 1) continue;
      try {
        if (!this.enabled()) {
          if (await this.startNormalCycle(row.id, row.purchase_id, now)) out.released += 1;
          continue;
        }
        const coachId = row.purchase?.coach_user_id;
        const subId = row.purchase?.stripe_subscription_id;
        if (!coachId || !subId) continue;
        if (!readiness.has(coachId)) readiness.set(coachId, this.freshCoachAccountReady(coachId));
        if ((await readiness.get(coachId)) !== true) {
          // FR-1195 (LS-1195 B1): still not fixed (or unsure): a notice
          // channel that failed is sent again, once per coach per sweep.
          if (!noticed.has(coachId)) {
            noticed.add(coachId);
            await this.retryNotice(coachId, now);
          }
          continue;
        }
        if (await this.retryHeld(row, subId, now)) out.retried += 1;
      } catch (err) {
        this.logger.warn(`coach hold sweep row failed: ${dunningErrorCode(err)}`);
      }
    }
    return out;
  }

  /** Leave the hold and claim Day 0 now (switch off, or a card decline on our retry). */
  private async startNormalCycle(stateId: string, purchaseId: string, now: Date): Promise<boolean> {
    const left = await this.prisma.dunningState.updateMany({
      where: { id: stateId, last_failure_reason: COACH_ACCOUNT_HOLD_REASON },
      data: { last_failure_reason: null },
    });
    if (left.count !== 1) return false;
    const claim = await this.v2.recordPaymentFailed(purchaseId, now);
    if (claim) void this.v2.dispatchClaim(claim);
    return claim !== null;
  }

  /**
   * FR-1195 (LS-1195 B2): pay every renewal invoice of the purchase still
   * open, oldest first (Stripe lists newest first), each with its own key.
   * One the hold already saw paid (its own pay call or the paid webhook) is
   * never sent again. The hold ends on the paid webhook once none is left
   * unpaid (onRenewalPaid).
   */
  private async retryHeld(
    row: { id: string; purchase_id: string; entered_at: Date | null },
    subscriptionId: string,
    now: Date,
  ): Promise<boolean> {
    const open = await this.stripe.listOpenInvoices(subscriptionId);
    let tried = false;
    for (const invoice of [...open].reverse()) {
      if (!invoice?.id || (await this.paidByHold(invoice.id))) continue;
      tried = true;
      try {
        const res = await this.stripe.retryInvoiceOffSession({
          invoiceId: invoice.id,
          idempotencyKey: coachAccountHoldRetryKey(invoice.id, row.id, row.entered_at),
        });
        if (res?.status === 'paid') await this.markPaidByHold(invoice.id, now);
      } catch (err) {
        if (err instanceof StripeConnectApiError && err.stripeType === 'card_error') {
          // R5: the card failed on a ready account: the ten days start now.
          // Stripe's invoice.payment_failed for this try lands on the same
          // Day 0 claim, which is taken once. The rest wait with it.
          await this.startNormalCycle(row.id, row.purchase_id, now);
          return true;
        }
        // Anything else (the account again, or Stripe down) stays waiting and
        // is tried again no sooner than an hour from now, with the invoices
        // not yet paid. A definite refusal starts a new hold (so the next try
        // is a new call, not Stripe's saved answer); an unknown outcome keeps
        // the key, so a resend is the same call.
        if (err instanceof StripeConnectApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
          await this.prisma.dunningState.updateMany({
            where: { id: row.id, last_failure_reason: COACH_ACCOUNT_HOLD_REASON },
            data: { entered_at: now },
          });
        }
        this.logger.warn(`coach hold retry not paid: ${dunningErrorCode(err)}`);
        return true;
      }
    }
    return tried;
  }

  /**
   * FR-1195 (LS-1195 B2), out of any transaction: the purchase's renewal
   * invoices still open other than `paidInvoiceId` and not already seen paid.
   * Undefined: the renewal is not held. Null: no fresh answer. Never throws.
   */
  async unpaidHeldInvoices(
    purchaseId: string,
    subscriptionId: string | null | undefined,
    paidInvoiceId: string | null | undefined,
  ): Promise<string[] | null | undefined> {
    try {
      const state = await this.prisma.dunningState.findUnique({
        where: { purchase_id: purchaseId },
        select: { status: true, last_failure_reason: true },
      });
      if (!isHeldRenewal(state)) return undefined;
      if (!subscriptionId) return [];
      const open = await this.stripe.listOpenInvoices(subscriptionId);
      const left: string[] = [];
      for (const invoice of open) {
        if (!invoice?.id || invoice.id === paidInvoiceId) continue;
        if (await this.paidByHold(invoice.id)) continue;
        left.push(invoice.id);
      }
      return left;
    } catch (err) {
      this.logger.warn(`coach hold open-invoice read failed: ${dunningErrorCode(err)}`);
      return null;
    }
  }

  /**
   * FR-1195 (LS-1195 B2): invoice.paid on a held renewal. The hold ends only
   * when no other renewal of the purchase is left unpaid. 'keep': it stays
   * waiting and the sweep pays the rest. 'end': main's resolution runs (as
   * for a row that is not held). 'unknown': no fresh answer; the caller
   * fails the delivery and Stripe sends it again. `unpaid` is the read made
   * before the webhook's transaction; with no transaction it is made here.
   */
  async onRenewalPaid(
    purchase: { id: string; stripe_subscription_id: string | null },
    invoiceId: string | null | undefined,
    unpaid: string[] | null | undefined,
    tx?: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<HeldRenewalPaid> {
    const db: Db = tx ?? this.prisma;
    const state = await db.dunningState.findUnique({
      where: { purchase_id: purchase.id },
      select: { status: true, last_failure_reason: true },
    });
    if (!isHeldRenewal(state)) return 'end';
    if (invoiceId) await this.markPaidByHold(invoiceId, now, db);
    let left = unpaid;
    if (left === undefined && !tx) {
      left = await this.unpaidHeldInvoices(purchase.id, purchase.stripe_subscription_id, invoiceId);
    }
    if (!Array.isArray(left)) return 'unknown';
    return left.length > 0 ? 'keep' : 'end';
  }

  private async paidByHold(invoiceId: string, db: Db = this.prisma): Promise<boolean> {
    const row = await db.cronLease.findUnique({
      where: { name: paidName(invoiceId) },
      select: { name: true },
    });
    return row !== null;
  }

  private async markPaidByHold(invoiceId: string, now: Date, db: Db = this.prisma): Promise<void> {
    const name = paidName(invoiceId);
    await db.cronLease.upsert({
      where: { name },
      create: { name, holder: NOTICE_IDLE, lease_until: now, acquired_at: now, cursor: 'paid' },
      update: { cursor: 'paid' },
    });
  }
}
