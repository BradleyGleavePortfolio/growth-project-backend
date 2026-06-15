import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';
import { NotificationCategory } from '../notification-category.enum';

/**
 * FIRST_PAYMENT notification payload (Roman P4, Option C).
 *
 * Carries only the minimum the mobile celebration screen needs:
 *   - amount   — cents (integer), snapshotted from the ClientPurchase row
 *   - currency — ISO currency code, snapshotted from the same row
 *   - clientId — the buying client's user id (deep-link / display lookup)
 *
 * Deliberately NO email, name, card data, or Stripe identifiers — those would
 * leak PII / secrets into the notification payload and lock-screen
 * (50-Failures #12 Secrets-in-messages, #34 no-PII observability). The mobile
 * client resolves the client's display name through its normal authorized
 * profile read; the notification never carries it.
 */
export const firstPaymentPayloadSchema = z
  .object({
    amount: z.number().int().nonnegative(),
    currency: z.string().min(1),
    clientId: z.string().min(1),
  })
  .strict();

export type FirstPaymentNotificationPayload = z.infer<typeof firstPaymentPayloadSchema>;

/**
 * FirstPaymentEmitter — thin wrapper around NotificationsService that knows the
 * FIRST_PAYMENT schema. It validates the payload (Zod) and dispatches the
 * coach-targeted notification on the in-app + push channels, exactly like the
 * other coach emitters (CoachAlertEmitter / CheckinSubmittedEmitter). No new
 * transport: it reuses the existing NotificationsService.createNotification
 * broadcast path.
 *
 * Exactly-once is NOT this emitter's responsibility — that is enforced upstream
 * by the CoachFirstPaymentNotification(coachId @unique) row, which only lets
 * the emit happen on the INSERT that wins the unique constraint. This emitter
 * is therefore called at most once per coach, forever.
 */
@Injectable()
export class FirstPaymentEmitter {
  private readonly logger = new Logger(FirstPaymentEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Dispatch the FIRST_PAYMENT notification to the coach.
   *
   * @param coachId  the recipient coach user id (server-trusted — sourced from
   *                 the persisted ClientPurchase row, never the webhook body).
   * @param payload  validated { amount, currency, clientId }.
   * @param tx       R81 (PR-395 follow-up, F1/F2) — the AMBIENT purchase
   *                 transaction. Threaded into both createNotification calls so
   *                 the inapp + push rows are written via `tx.notification.create`
   *                 and commit-or-roll-back WITH the CoachFirstPaymentNotification
   *                 ledger row and the ClientPurchase. Without this the rows
   *                 escaped to NotificationsService's autocommitting client and
   *                 could survive an outer rollback (re-firing on Stripe retry)
   *                 or be delivered before the purchase committed.
   */
  async emit(
    coachId: string,
    payload: FirstPaymentNotificationPayload,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    // Validate the payload shape at the boundary. A malformed payload is a
    // programming error in the caller, so we throw (loud, not silent) rather
    // than emit a half-formed notification.
    const parsed = firstPaymentPayloadSchema.parse(payload);

    const body = "You just landed your first client. Your first payment is on its way.";
    const deepLink = `tgp://coach/clients/${parsed.clientId}`;

    await this.notifications.createNotification(
      {
        user_id: coachId,
        kind: NotificationKind.FIRST_PAYMENT,
        body,
        payload: {
          amount: parsed.amount,
          currency: parsed.currency,
          clientId: parsed.clientId,
        },
        deep_link: deepLink,
        channel: 'inapp',
      },
      tx,
    );

    await this.notifications.createNotification(
      {
        user_id: coachId,
        kind: NotificationKind.FIRST_PAYMENT,
        body,
        payload: {
          amount: parsed.amount,
          currency: parsed.currency,
          clientId: parsed.clientId,
        },
        deep_link: deepLink,
        channel: 'push',
      },
      tx,
    );

    this.logger.log({
      event: 'first_payment_notification_emitted',
      coachId,
      category: NotificationCategory.COACH_DIRECT,
    });
  }
}
