import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

export interface WeightTrendPayload {
  /** Direction of the trend over the observed window. */
  direction: 'toward_goal' | 'away_from_goal' | 'stalled';
  /** Number of consecutive days in the trend. */
  windowDays: number;
  /** Average daily change in lbs (positive = gaining, negative = losing). */
  avgDeltaLbs: number;
}

/**
 * WeightTrendAlertEmitter — fires when the weight service detects a
 * multi-day trend worth surfacing.
 *
 * Privacy: the `avgDeltaLbs` value is the client's own data. The notification
 * body uses relative language ("trending toward your goal") so the raw number
 * is not in the push notification text visible on the lock screen — only in
 * the in-app deep-link payload.
 *
 * Called fire-and-forget from WeightService after each log when 3+
 * consecutive entries exist in a 14-day window.
 */
@Injectable()
export class WeightTrendAlertEmitter {
  private readonly logger = new Logger(WeightTrendAlertEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(userId: string, payload: WeightTrendPayload): Promise<void> {
    try {
      const { direction, windowDays, avgDeltaLbs } = payload;

      let body: string;
      if (direction === 'toward_goal') {
        body = `Weight trending toward your goal over ${windowDays} days. Keep the consistency going.`;
      } else if (direction === 'away_from_goal') {
        body = `Weight has trended away from your goal over ${windowDays} days. Log today to reset.`;
      } else {
        body = `Weight has been stable over ${windowDays} days. Check your nutrition targets.`;
      }

      const notifPayload = { direction, windowDays, avgDeltaLbs };

      await this.notifications.createNotification({
        user_id: userId,
        kind: NotificationKind.WEIGHT_TREND_ALERT,
        body: body.slice(0, 160),
        payload: notifPayload,
        deep_link: 'tgp://weight',
        channel: 'inapp',
      });

      // Push body omits the numeric delta for lock-screen privacy.
      await this.notifications.createNotification({
        user_id: userId,
        kind: NotificationKind.WEIGHT_TREND_ALERT,
        body: body.slice(0, 160),
        payload: notifPayload,
        deep_link: 'tgp://weight',
        channel: 'push',
      });
    } catch (err) {
      this.logger.warn(
        `WeightTrendAlertEmitter failed for user=${userId}: ${(err as Error).message}`,
      );
    }
  }
}
