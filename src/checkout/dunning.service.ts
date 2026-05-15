import { Injectable, Logger } from '@nestjs/common';
import type { ClientPurchase, DunningState, PaymentReminder } from '@prisma/client';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';

// DunningService — payment-failure / retry / cancel lifecycle for
// recurring purchases. Driven by:
//
//   invoice.payment_failed -> recordFailure() -> DunningState row +
//      first reminder. Grace period set to now + GRACE_DAYS; cancel
//      scheduled for next billing-period boundary if Stripe runs out
//      of retry attempts before then.
//   invoice.paid           -> recordResolution() -> DunningState =>
//      resolved, reminders stop, future failures start a new window.
//
//   sweeper                -> findExpiredGracePeriods() -> rows whose
//      grace_period_ends_at has elapsed and status=active. The sweeper
//      cancels the subscription on Stripe and writes a final
//      canceled_for_nonpayment reminder.
//
// Reminder rules:
//   - First failure: in-app + email "payment_failed", attempt #N
//   - Subsequent failures in same window: dedup by (purchase_id, kind,
//     channel, window_key=stripe_invoice_id)
//   - Halfway through grace period: "retry_scheduled"
//   - 24h before cancel_scheduled_at: "final_warning"
//   - On cancel: "canceled_for_nonpayment"

export const DUNNING_GRACE_DAYS_DEFAULT = 7;
export const DUNNING_MAX_FAILURES_DEFAULT = 4;

export interface RecordFailureInput {
  purchase: ClientPurchase;
  stripe_invoice_id: string | null;
  amount_due_cents: number | null;
  attempt_number: number | null;
  reason: string | null;
}

@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
  ) {}

  async recordFailure(input: RecordFailureInput): Promise<DunningState> {
    const { purchase } = input;
    const now = new Date();
    const grace = this.computeGracePeriodEnd(now);

    // Find or create the dunning row for this purchase.
    const existing = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchase.id },
    });

    const cancelScheduledAt = this.computeCancelScheduledAt(
      existing,
      input.attempt_number ?? null,
      now,
    );

    const row = existing
      ? await this.prisma.dunningState.update({
          where: { purchase_id: purchase.id },
          data: {
            // If the previous window had resolved, reopen it.
            status: existing.status === 'resolved' ? 'active' : existing.status,
            failure_count: { increment: 1 },
            last_attempt_number:
              input.attempt_number ?? existing.last_attempt_number,
            last_failed_amount_cents:
              input.amount_due_cents ?? existing.last_failed_amount_cents,
            last_failure_at: now,
            last_failure_reason: input.reason ?? existing.last_failure_reason,
            grace_period_ends_at:
              existing.grace_period_ends_at &&
              existing.grace_period_ends_at > now
                ? existing.grace_period_ends_at
                : grace,
            cancel_scheduled_at:
              existing.cancel_scheduled_at ?? cancelScheduledAt,
            resolved_at: null,
          },
        })
      : await this.prisma.dunningState.create({
          data: {
            purchase_id: purchase.id,
            status: 'active',
            failure_count: 1,
            last_attempt_number: input.attempt_number ?? null,
            last_failed_amount_cents: input.amount_due_cents ?? null,
            last_failure_at: now,
            last_failure_reason: input.reason ?? null,
            grace_period_ends_at: grace,
            cancel_scheduled_at: cancelScheduledAt,
          },
        });

    // Queue the customer reminder. Dedup window key = stripe invoice id
    // (one reminder per failed invoice). Falls back to a timestamp slot
    // when invoice id is missing so we still avoid spam.
    const windowKey =
      input.stripe_invoice_id ??
      `inv-na-${Math.floor(now.getTime() / (60 * 60 * 1000))}`;
    await this.enqueueReminder({
      purchase_id: purchase.id,
      recipient_user_id: purchase.client_user_id,
      kind: 'payment_failed',
      channel: 'inapp',
      window_key: windowKey,
    });
    await this.enqueueReminder({
      purchase_id: purchase.id,
      recipient_user_id: purchase.client_user_id,
      kind: 'payment_failed',
      channel: 'email',
      window_key: windowKey,
    });

    return row;
  }

  async recordResolution(purchaseId: string): Promise<DunningState | null> {
    const existing = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (!existing || existing.status !== 'active') return existing;
    return this.prisma.dunningState.update({
      where: { purchase_id: purchaseId },
      data: {
        status: 'resolved',
        resolved_at: new Date(),
        cancel_scheduled_at: null,
      },
    });
  }

  // Find purchases whose grace period has elapsed and which need to be
  // canceled.
  async findExpiredGracePeriods(
    now: Date = new Date(),
    limit = 50,
  ): Promise<DunningState[]> {
    return this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        OR: [
          { grace_period_ends_at: { lte: now } },
          { cancel_scheduled_at: { lte: now } },
        ],
      },
      orderBy: { grace_period_ends_at: 'asc' },
      take: limit,
    });
  }

  // Cancel the underlying subscription and mark the dunning row as
  // abandoned. Safe to retry — Stripe cancelSubscription is idempotent
  // by virtue of the sub already being canceled.
  async abandonAndCancel(
    dunning: DunningState,
  ): Promise<{ purchase: ClientPurchase | null; stripe_canceled: boolean }> {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: dunning.purchase_id },
    });
    let stripeCanceled = false;
    if (purchase?.stripe_subscription_id) {
      try {
        await this.stripe.cancelSubscription(purchase.stripe_subscription_id);
        stripeCanceled = true;
      } catch (err) {
        this.logger.warn(
          `cancelSubscription failed sub=${purchase.stripe_subscription_id}: ${(err as Error).message}`,
        );
      }
    }
    await this.prisma.dunningState.update({
      where: { id: dunning.id },
      data: { status: 'abandoned', abandoned_at: new Date() },
    });
    if (purchase) {
      await this.prisma.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          status: 'canceled',
          entitlement_active: false,
          canceled_at: new Date(),
        },
      });
      await this.enqueueReminder({
        purchase_id: purchase.id,
        recipient_user_id: purchase.client_user_id,
        kind: 'canceled_for_nonpayment',
        channel: 'email',
        window_key: `final-${dunning.id}`,
      });
      await this.enqueueReminder({
        purchase_id: purchase.id,
        recipient_user_id: purchase.client_user_id,
        kind: 'canceled_for_nonpayment',
        channel: 'inapp',
        window_key: `final-${dunning.id}`,
      });
    }
    return { purchase, stripe_canceled: stripeCanceled };
  }

  async runSweeper(
    now: Date = new Date(),
  ): Promise<{ scanned: number; canceled: number; final_warned: number }> {
    const expired = await this.findExpiredGracePeriods(now);
    let canceled = 0;
    for (const row of expired) {
      const out = await this.abandonAndCancel(row);
      if (out.stripe_canceled) canceled += 1;
    }
    // Final-warning sweep: rows whose cancel_scheduled_at is within 24h.
    const warningCutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const upcoming = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        cancel_scheduled_at: {
          not: null,
          gt: now,
          lte: warningCutoff,
        },
      },
      take: 50,
    });
    let finalWarned = 0;
    for (const row of upcoming) {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: row.purchase_id },
      });
      if (!purchase) continue;
      const result = await this.enqueueReminder({
        purchase_id: row.purchase_id,
        recipient_user_id: purchase.client_user_id,
        kind: 'final_warning',
        channel: 'email',
        window_key: `final-warning-${row.id}`,
      });
      if (result) finalWarned += 1;
      await this.enqueueReminder({
        purchase_id: row.purchase_id,
        recipient_user_id: purchase.client_user_id,
        kind: 'final_warning',
        channel: 'inapp',
        window_key: `final-warning-${row.id}`,
      });
    }
    return { scanned: expired.length, canceled, final_warned: finalWarned };
  }

  // Reminder row creation — composite unique (purchase_id, kind, channel,
  // window_key) collapses dupes. Returns the row when newly created,
  // null when already present (already-sent).
  async enqueueReminder(args: {
    purchase_id: string;
    recipient_user_id: string;
    kind: string;
    channel: string;
    window_key: string;
  }): Promise<PaymentReminder | null> {
    try {
      return await this.prisma.paymentReminder.create({
        data: {
          purchase_id: args.purchase_id,
          recipient_user_id: args.recipient_user_id,
          kind: args.kind,
          channel: args.channel,
          window_key: args.window_key,
          status: 'queued',
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) return null;
      throw err;
    }
  }

  // Mark a reminder as delivered (called by whatever notification worker
  // eventually drains the queued reminders).
  async markReminderSent(reminderId: string) {
    return this.prisma.paymentReminder.update({
      where: { id: reminderId },
      data: { status: 'sent', sent_at: new Date() },
    });
  }

  async markReminderFailed(reminderId: string, reason: string) {
    return this.prisma.paymentReminder.update({
      where: { id: reminderId },
      data: { status: 'failed', failure_reason: reason },
    });
  }

  private computeGracePeriodEnd(now: Date): Date {
    return new Date(now.getTime() + DUNNING_GRACE_DAYS_DEFAULT * 24 * 60 * 60 * 1000);
  }

  // After max_attempts failures Stripe gives up — schedule the cancel
  // immediately. Otherwise schedule it at grace_period_ends_at.
  private computeCancelScheduledAt(
    existing: DunningState | null,
    attemptNumber: number | null,
    now: Date,
  ): Date {
    if (
      typeof attemptNumber === 'number' &&
      attemptNumber >= DUNNING_MAX_FAILURES_DEFAULT
    ) {
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
    return existing?.cancel_scheduled_at ?? this.computeGracePeriodEnd(now);
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === 'P2002') return true;
    return /unique constraint/i.test(e.message ?? '');
  }
}
