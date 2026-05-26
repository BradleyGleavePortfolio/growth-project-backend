import { Injectable, Logger, Optional } from '@nestjs/common';
import type { DunningCase } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';

// r50 — DunningNotifier
//
// One side-effect entry per state transition:
//   onRetryScheduled  — fired before each retry attempt (incl. final
//                       warning copy for retry_3)
//   recovered         — fired after invoice.payment_succeeded
//   churned           — fired after retry_3 fail OR subscription delete
//
// Email is best-effort: a Resend outage must NOT cause a Stripe webhook
// to be re-delivered. We log + swallow inside each `send` call.
//
// In-app notification creation goes through NotificationsService which
// already honors per-coach preference muting and push rate limits.
// Both channels share the same idempotency key derived from the case id
// + retry number, so re-deliveries of the underlying Stripe event do not
// produce duplicate emails or notifications.
@Injectable()
export class DunningNotifier {
  private readonly logger = new Logger(DunningNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Send the upcoming-retry notification + email. Called by the webhook
   * handler (on initial schedule) and by the worker (on each subsequent
   * retry advance). `retryNumber` controls which template variant runs:
   *   1, 2 → generic "we'll retry your card in X days"
   *   3    → final warning "last attempt before your account is paused"
   */
  async retryScheduled(
    c: DunningCase,
    retryNumber: 1 | 2 | 3,
  ): Promise<void> {
    const idemKey = `dunning:retry_${retryNumber}:${c.id}`;
    const message =
      retryNumber === 3
        ? "Last attempt: we'll retry your card in 7 days before your account is paused."
        : retryNumber === 1
          ? "Your card was declined — we'll automatically retry in 1 day."
          : "We'll retry your card again in 3 days. Update it sooner from billing.";

    if (this.notifications) {
      try {
        await this.notifications.createNotification({
          user_id: c.coach_id,
          kind:
            retryNumber === 3
              ? NotificationKind.DUNNING_FINAL_WARNING
              : NotificationKind.DUNNING_RETRY_ATTEMPT,
          body: message,
          payload: {
            dunningCaseId: c.id,
            retryNumber,
            amountCents: c.amount_cents,
            failureReason: c.failure_reason ?? null,
          },
          deep_link: 'tgp://coach/billing',
          channel: 'inapp',
        });
      } catch (err) {
        this.logger.warn(
          `retryScheduled inapp failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }

    if (this.email) {
      const recipient = await this.resolveRecipientEmail(c.coach_id);
      if (recipient) {
        try {
          await this.email.send({
            to: recipient,
            template:
              retryNumber === 3
                ? EmailTemplateKey.DUNNING_FINAL
                : EmailTemplateKey.PAYMENT_FAILED,
            idempotencyKey: idemKey,
            data: {
              coach_name: await this.resolveCoachName(c.coach_id),
              amount_due_cents: c.amount_cents,
              amount_due_display: (c.amount_cents / 100).toFixed(2),
              retry_number: retryNumber,
              reason: c.failure_reason ?? 'Your card was declined.',
            },
          });
        } catch (err) {
          this.logger.error(
            `retryScheduled email failed for case ${c.id}: ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          );
        }
      }
    }
  }

  /**
   * Successful recovery — invoice.payment_succeeded landed before the
   * retries exhausted. One in-app + one email.
   */
  async recovered(c: DunningCase): Promise<void> {
    const idemKey = `dunning:recovered:${c.id}`;
    if (this.notifications) {
      try {
        await this.notifications.createNotification({
          user_id: c.coach_id,
          kind: NotificationKind.DUNNING_RECOVERED,
          body: 'Payment recovered — your account is fully active again.',
          payload: { dunningCaseId: c.id, amountCents: c.amount_cents },
          deep_link: 'tgp://coach/billing',
          channel: 'inapp',
        });
      } catch (err) {
        this.logger.warn(
          `recovered inapp failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    if (this.email) {
      const recipient = await this.resolveRecipientEmail(c.coach_id);
      if (recipient) {
        try {
          await this.email.send({
            to: recipient,
            template: EmailTemplateKey.PAYMENT_RECEIPT,
            idempotencyKey: idemKey,
            data: {
              coach_name: await this.resolveCoachName(c.coach_id),
              amount_paid_cents: c.amount_cents,
              amount_paid_display: (c.amount_cents / 100).toFixed(2),
              dunning_recovery: true,
            },
          });
        } catch (err) {
          this.logger.error(
            `recovered email failed for case ${c.id}: ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          );
        }
      }
    }
  }

  /**
   * Terminal churn — retry_3 failed OR subscription deleted. The
   * follow-on behaviour (tier downgrade, access revocation) is owned by
   * BillingService.applySubscriptionDeleted — the notifier just tells
   * the coach.
   */
  async churned(c: DunningCase): Promise<void> {
    const idemKey = `dunning:churned:${c.id}`;
    if (this.notifications) {
      try {
        await this.notifications.createNotification({
          user_id: c.coach_id,
          kind: NotificationKind.DUNNING_CHURNED,
          body: "Your subscription was paused after multiple failed retries. Update payment to reactivate.",
          payload: { dunningCaseId: c.id, amountCents: c.amount_cents },
          deep_link: 'tgp://coach/billing',
          channel: 'inapp',
        });
      } catch (err) {
        this.logger.warn(
          `churned inapp failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    if (this.email) {
      const recipient = await this.resolveRecipientEmail(c.coach_id);
      if (recipient) {
        try {
          await this.email.send({
            to: recipient,
            template: EmailTemplateKey.DUNNING_FINAL,
            idempotencyKey: idemKey,
            data: {
              coach_name: await this.resolveCoachName(c.coach_id),
              amount_due_cents: c.amount_cents,
              amount_due_display: (c.amount_cents / 100).toFixed(2),
              churned: true,
              reason: c.failure_reason ?? 'Your card was declined.',
            },
          });
        } catch (err) {
          this.logger.error(
            `churned email failed for case ${c.id}: ${
              err instanceof Error ? err.message : 'unknown'
            }`,
          );
        }
      }
    }
  }

  private async resolveRecipientEmail(coachId: string): Promise<string | null> {
    // CoachSubscription.billing_email is the operator-set preferred address
    // (matches the existing dispatchPaymentFailedEmail path); fall back to
    // the User row's primary email so a coach who never set a billing
    // address still gets the warning.
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
      select: { billing_email: true },
    });
    if (sub?.billing_email) return sub.billing_email;
    const user = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { email: true },
    });
    return user?.email ?? null;
  }

  private async resolveCoachName(coachId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { name: true },
    });
    return user?.name?.trim() || 'there';
  }
}
