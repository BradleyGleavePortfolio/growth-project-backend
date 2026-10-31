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
  DUNNING_V2_REVERSAL_REASON,
  DunningV2Service,
  FULL_REFUND_PAUSE_REASON,
  isBillingPauseReason,
} from './dunning-v2.service';
import { dunningErrorCode } from './dunning-v2.safe-error';
import {
  COACH_ACCOUNT_HOLD_REASON,
  COACH_ACCOUNT_HOLD_RETRY_MS,
  coachAccountHoldNotice,
  coachAccountHoldRetryKey,
  coachLocalDay,
  isCoachAccountHoldEnabled,
} from './coach-account-hold';

type Db = Prisma.TransactionClient | PrismaService;

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
   * fresh answer from Stripe (unsure, which waits, R1). Never throws.
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
    if (ready === true) {
      // R2/R5: a failure on a ready account is the card. A renewal that was
      // waiting leaves the hold; the caller's Day 0 claim starts the ten
      // days from now.
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
   * calendar day in the coach's zone. The once-a-day claim is one CronLease
   * row per coach whose cursor holds the day last told (atomic compare-and-set,
   * so two failures at once tell the coach once). Names no client.
   */
  async notifyCoach(coachUserId: string, now: Date = new Date()): Promise<boolean> {
    const prefs = await this.prisma.notificationPreferences.findUnique({
      where: { user_id: coachUserId },
      select: { timezone: true },
    });
    const day = coachLocalDay(now, prefs?.timezone ?? null);
    const name = `coach-account-hold-notice:${coachUserId}`;
    try {
      await this.prisma.cronLease.upsert({
        where: { name },
        create: { name, holder: 'pf7', lease_until: now, acquired_at: now, cursor: '' },
        update: {},
      });
    } catch {
      // A concurrent first create; the compare-and-set below decides.
    }
    const won = await this.prisma.cronLease.updateMany({
      where: { name, OR: [{ cursor: null }, { cursor: { not: day } }] },
      data: { cursor: day, lease_until: now },
    });
    if (won.count !== 1) return false;
    const count = await this.countWaiting(coachUserId);
    if (count < 1) return false;
    const message = coachAccountHoldNotice(count);
    const alertId = `coach_account_hold:${coachUserId}:${day}`;
    if (this.coachAlert) {
      await this.coachAlert.emit({
        coachId: coachUserId,
        alertId,
        alertType: 'coach_account_hold',
        message,
        severity: 'warning',
        money: true,
      });
    }
    const coach = await this.prisma.user.findUnique({
      where: { id: coachUserId },
      select: { email: true },
    });
    if (this.email && coach?.email) {
      await this.email.send({
        to: coach.email,
        template: EmailTemplateKey.DUNNING_V2_COACH,
        idempotencyKey: `${alertId}:email`,
        data: { roman_body: message, coach_account_hold: true },
      });
    }
    return true;
  }

  /**
   * R5/R6, hourly. Switch off: every waiting renewal starts the normal ten
   * days now. Switch on: re-read each held coach's account; when it can take
   * payments, pay each waiting renewal once (one Stripe key per invoice and
   * hold). A row is looked at no more than once an hour, and the look is
   * claimed first, so overlapping sweeps never pay or notify twice.
   */
  async runSweep(now: Date = new Date()): Promise<{ released: number; retried: number }> {
    const out = { released: 0, retried: 0 };
    if (!this.v2.enabled()) return out;
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
        if ((await readiness.get(coachId)) !== true) continue;
        if (await this.retryOnce(row, subId, now)) out.retried += 1;
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

  private async retryOnce(
    row: { id: string; purchase_id: string; entered_at: Date | null },
    subscriptionId: string,
    now: Date,
  ): Promise<boolean> {
    const open = await this.stripe.listOpenInvoices(subscriptionId);
    const invoice = open[0];
    if (!invoice?.id) return false;
    try {
      await this.stripe.retryInvoiceOffSession({
        invoiceId: invoice.id,
        idempotencyKey: coachAccountHoldRetryKey(invoice.id, row.id, row.entered_at),
      });
      // Paid: Stripe's invoice.paid closes the row as on main.
      return true;
    } catch (err) {
      if (err instanceof StripeConnectApiError && err.stripeType === 'card_error') {
        // R5: the card failed on a ready account: the ten days start now.
        // Stripe's invoice.payment_failed for this try lands on the same
        // Day 0 claim, which is taken once.
        await this.startNormalCycle(row.id, row.purchase_id, now);
        return true;
      }
      // Anything else (the account again, or Stripe down) stays waiting and
      // is tried again no sooner than an hour from now. A definite refusal
      // starts a new hold (so the next try is a new call, not Stripe's saved
      // answer); an unknown outcome keeps the key, so a resend is the same call.
      if (err instanceof StripeConnectApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
        await this.prisma.dunningState.updateMany({
          where: { id: row.id, last_failure_reason: COACH_ACCOUNT_HOLD_REASON },
          data: { entered_at: now },
        });
      }
      this.logger.warn(`coach hold retry not paid: ${dunningErrorCode(err)}`);
      return false;
    }
  }
}
