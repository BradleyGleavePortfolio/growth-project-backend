import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

export interface MissedCheckinPayload {
  /** Number of consecutive days missed. */
  daysMissed: number;
  /** Display name of the client (only used for the coach-facing notification). */
  clientDisplayName?: string;
  /** If set, the notification goes to the coach about this client. */
  coachId?: string;
  /** The client user ID who missed the check-ins. */
  clientUserId: string;
}

/**
 * MissedCheckinEmitter — fires when a client misses 3 or more consecutive
 * check-in windows.
 *
 * Two notifications are generated:
 *   1. To the CLIENT: "You have missed N check-ins. Open the app to catch up."
 *   2. To the COACH (if coachId is provided): "Client X has missed N check-ins."
 *      Body never includes weight, income, or financial data — only the streak
 *      count, which is a behavioral (not medical/financial) metric.
 *
 * Called fire-and-forget from PtmService.recordSignal (checkin_miss type).
 */
@Injectable()
export class MissedCheckinEmitter {
  private readonly logger = new Logger(MissedCheckinEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(payload: MissedCheckinPayload): Promise<void> {
    try {
      const { daysMissed, clientUserId, coachId, clientDisplayName } = payload;

      // Client-facing notification.
      await this.notifications.createNotification({
        user_id: clientUserId,
        kind: NotificationKind.MISSED_CHECKIN,
        body: `You have missed ${daysMissed} check-in${daysMissed !== 1 ? 's' : ''}. Log today's check-in to keep your streak.`,
        payload: { daysMissed },
        deep_link: 'tgp://checkin/today',
        channel: 'inapp',
      });

      await this.notifications.createNotification({
        user_id: clientUserId,
        kind: NotificationKind.MISSED_CHECKIN,
        body: `You have missed ${daysMissed} check-in${daysMissed !== 1 ? 's' : ''}. Log today's check-in to keep your streak.`,
        payload: { daysMissed },
        deep_link: 'tgp://checkin/today',
        channel: 'push',
      });

      // Coach-facing notification.
      if (coachId && clientDisplayName) {
        const coachBody = `${clientDisplayName} has missed ${daysMissed} check-in${daysMissed !== 1 ? 's' : ''}. Last active: ${daysMissed} day${daysMissed !== 1 ? 's' : ''} ago.`.slice(
          0,
          160,
        );

        await this.notifications.createNotification({
          user_id: coachId,
          kind: NotificationKind.MISSED_CHECKIN,
          body: coachBody,
          payload: { daysMissed, clientUserId },
          deep_link: `tgp://coach/clients/${clientUserId}`,
          channel: 'inapp',
        });

        await this.notifications.createNotification({
          user_id: coachId,
          kind: NotificationKind.MISSED_CHECKIN,
          body: coachBody,
          payload: { daysMissed, clientUserId },
          deep_link: `tgp://coach/clients/${clientUserId}`,
          channel: 'push',
        });
      }
    } catch (err) {
      this.logger.warn(
        `MissedCheckinEmitter failed: ${(err as Error).message}`,
      );
    }
  }
}
