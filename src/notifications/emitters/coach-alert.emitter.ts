import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

export interface CoachAlertNotificationPayload {
  /** The coach user ID to notify. */
  coachId: string;
  /** Alert ID from the CoachAlert table for reference. */
  alertId: string;
  /** The alert type string, e.g. 'risk_red_transition' | 'consecutive_misses' */
  alertType: string;
  /** Pre-formatted message string from CoachAlert.message. */
  message: string;
  /** Severity: 'info' | 'warning' | 'critical' */
  severity: string;
  /** Client user ID for deep-link routing. */
  clientUserId?: string;
}

/**
 * CoachAlertEmitter — mirrors a CoachAlert row into the notification inbox.
 *
 * The CoachAlert table (Phase 6B) is the source of truth; this emitter
 * creates a Notification row so the coach inbox (GET /notifications) shows
 * the alert alongside message and milestone notifications in a unified feed.
 *
 * Also calls NotificationsService.pushToCoach for the push delivery path
 * that was established in Phase 6B.
 *
 * Called fire-and-forget from CoachAlertsService.createAlert.
 */
@Injectable()
export class CoachAlertEmitter {
  private readonly logger = new Logger(CoachAlertEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(payload: CoachAlertNotificationPayload): Promise<void> {
    try {
      const { coachId, alertId, alertType, message, severity, clientUserId } = payload;
      const deepLink = clientUserId
        ? `tgp://coach/clients/${clientUserId}`
        : 'tgp://coach/alerts';

      await this.notifications.createNotification({
        user_id: coachId,
        kind: NotificationKind.COACH_ALERT,
        body: message.slice(0, 160),
        payload: { alertId, alertType, severity, clientUserId },
        deep_link: deepLink,
        channel: 'inapp',
      });

      // Push via Phase 6B path.
      await this.notifications.pushToCoach(coachId, {
        alertId,
        alertType,
        severity,
        message: message.slice(0, 160),
      });

      // Also create a push Notification row so the read state is tracked.
      await this.notifications.createNotification({
        user_id: coachId,
        kind: NotificationKind.COACH_ALERT,
        body: message.slice(0, 160),
        payload: { alertId, alertType, severity, clientUserId },
        deep_link: deepLink,
        channel: 'push',
      });
    } catch (err) {
      this.logger.warn(
        `CoachAlertEmitter failed for coach=${payload.coachId}: ${(err as Error).message}`,
      );
    }
  }
}
