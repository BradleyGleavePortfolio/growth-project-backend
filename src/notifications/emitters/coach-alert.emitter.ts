import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';
import { DEFAULT_NOTIFICATION_CATEGORY } from '../notification-category.enum';
import { dunningErrorCode } from '../../checkout/dunning-v2/dunning-v2.safe-error';

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

export type CoachAlertTransport = 'sent' | 'skipped' | 'failed';

export interface CoachAlertDelivery {
  /** The durable in-app feed row ('skipped' when muted or not asked for). */
  inapp: CoachAlertTransport;
  /** The push and its read-state row ('skipped' when not asked for). */
  push: CoachAlertTransport;
  /** Why a verified push was not delivered (B-687-3), e.g. 'ticket-error'. */
  pushCode?: string;
}

/** A push whose Expo ticket is checked (B-687-3), with display copy (C-687-7). */
export type VerifiedCoachPush = { title: string; body: string };

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
 * Called fire-and-forget from CoachAlertsService.createAlert: `emit` never
 * throws. B-688-3 (Sol): it reports each transport's real result, so a
 * caller that keeps a delivery receipt (dunning v2) records a failed write
 * or push as failed and retries only that transport (`only`).
 */
@Injectable()
export class CoachAlertEmitter {
  private readonly logger = new Logger(CoachAlertEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(
    payload: CoachAlertNotificationPayload,
    only: { inapp?: boolean; push?: boolean } = {},
    verifiedPush?: VerifiedCoachPush,
  ): Promise<CoachAlertDelivery> {
    const { coachId, alertId, alertType, message, severity, clientUserId } = payload;
    const deepLink = clientUserId ? `tgp://coach/clients/${clientUserId}` : 'tgp://coach/alerts';
    const row = (channel: 'inapp' | 'push') => ({
      user_id: coachId,
      kind: NotificationKind.COACH_ALERT,
      body: message.slice(0, 160),
      payload: { alertId, alertType, severity, clientUserId },
      deep_link: deepLink,
      channel,
    });
    const out: CoachAlertDelivery = { inapp: 'skipped', push: 'skipped' };
    if (only.inapp !== false) {
      try {
        // null: the coach muted this kind (a preference, not a failure).
        const created = await this.notifications.createNotification(row('inapp'));
        out.inapp = created ? 'sent' : 'skipped';
      } catch (err) {
        out.inapp = 'failed';
        this.warn('inapp', coachId, err);
      }
    }
    if (only.push !== false) {
      try {
        if (verifiedPush) {
          // B-687-3: pushToUser reads Expo's ticket: rejected = failed, no
          // usable token = skipped. Display copy, not the alert type (C-687-7).
          const { title, body } = verifiedPush;
          const data = { alertId, alertType, category: DEFAULT_NOTIFICATION_CATEGORY };
          const res = await this.notifications.pushToUser(coachId, title, body, data);
          if (res?.delivered === false) out.pushCode = res.code;
          const noDevice = out.pushCode === 'no-token' || out.pushCode === 'invalid-token';
          out.push = !out.pushCode ? 'sent' : noDevice ? 'skipped' : 'failed';
        } else {
          // Push via Phase 6B path; false is a transport failure.
          const pushed = await this.notifications.pushToCoach(coachId, {
            alertId,
            alertType,
            severity,
            message: message.slice(0, 160),
          });
          out.push = pushed ? 'sent' : 'failed';
        }
      } catch (err) {
        out.push = 'failed';
        this.warn('push', coachId, err);
      }
      if (out.push === 'sent') {
        // Also create a push Notification row so the read state is tracked.
        // The push itself went out: a failed bookkeeping row must not make
        // a retry send it twice.
        try {
          await this.notifications.createNotification(row('push'));
        } catch (err) {
          this.warn('push_row', coachId, err);
        }
      }
    }
    return out;
  }

  /** Ids and a closed error code only: a message or class name can carry user text. */
  private warn(step: string, coachId: string, err: unknown): void {
    this.logger.warn(
      `CoachAlertEmitter ${step} failed for coach=${coachId} error=${dunningErrorCode(err)}`,
    );
  }
}
