import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';
import { dunningErrorCode } from '../../checkout/dunning-v2/dunning-v2.safe-error';
import {
  COACH_CLIENT_LINK,
  COACH_SPACE_ALERT_LINK,
  SAFETY_ALERT_INBOX_BODY,
  SAFETY_ALERT_PUSH_BODY,
  SPACE_SAFETY_ALERT_INBOX_BODY,
  safetyAlertTap,
} from '../push/lock-screen-copy';
import { MUTE_ALL_PASS } from '../push/push-preferences';

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
  /** FR-1154 (owner #171-3): a money alert (the Day 7 payment alert); its push passes Mute all. */
  money?: true;
  /** FR-1152R3 B1: a public space's copy of a photo safety alert, for this space. */
  spaceId?: string;
}

export type CoachAlertTransport = 'sent' | 'skipped' | 'failed';

export interface CoachAlertDelivery {
  /** The durable in-app feed row ('skipped' when its switch is off or not asked for). */
  inapp: CoachAlertTransport;
  /** The device push, queued in the push outbox (skipped when not asked for). */
  push: CoachAlertTransport;
  /** Why a push was not delivered (B-687-3); sendPush's outbox owns retries. */
  pushCode?: string;
}

/** Caller display copy (C-687-7); the lock screen keeps sendPush's quiet copy. */
export type VerifiedCoachPush = { title: string; body: string };

/**
 * CoachAlertEmitter — mirrors a CoachAlert row into the notification inbox.
 *
 * The CoachAlert table (Phase 6B) is the source of truth; this emitter
 * creates a Notification row so the coach inbox (GET /notifications) shows
 * the alert alongside message and milestone notifications in a unified feed.
 *
 * The device push goes through NotificationsService.sendPush (C-643-2).
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
    _verifiedPush?: VerifiedCoachPush,
  ): Promise<CoachAlertDelivery> {
    const { coachId, alertId, alertType, message, severity, clientUserId } = payload;
    // A Roman safety alert (owner 22a, 57, 57d): the inbox row and the push
    // open that alert; each has its own fixed line. Neither carries a name or
    // the client's message. FR-1152R3 B1: a space copy links its space and
    // has the space lines, as its reader may not coach the client.
    const safety = Object.prototype.hasOwnProperty.call(SAFETY_ALERT_PUSH_BODY, alertType);
    const spaceId = safety ? payload.spaceId : undefined;
    const deepLink = spaceId
      ? `${COACH_SPACE_ALERT_LINK}${spaceId}`
      : clientUserId
        ? `${COACH_CLIENT_LINK}${clientUserId}`
        : 'tgp://coach/alerts';
    // Owner 57q: the urgent and crisis alerts' pushes go out at once, even in
    // quiet hours; the eating-disorder one waits until 08:00. FR-1154: read
    // from the alert's severity ('critical'; eating-disorder is 'warning'), so
    // a new safety type cannot lose its sound. Each safety push has its own
    // dedupe key: one push per alert, never folded into another push for the
    // same client and never taken over by one while it waits. A safety push
    // passes Mute all by its context (owner #168-18; muteAllStops).
    const urgent = safety && severity === 'critical';
    const out: CoachAlertDelivery = { inapp: 'skipped', push: 'skipped' };
    if (only.inapp !== false) {
      try {
        // null: the coach turned this kind's in-app switch off (not a failure).
        const created = await this.notifications.createNotification({
          user_id: coachId,
          kind: NotificationKind.COACH_ALERT,
          body: spaceId ? SPACE_SAFETY_ALERT_INBOX_BODY : safety ? SAFETY_ALERT_INBOX_BODY[alertType] : message.slice(0, 160),
          payload: {
            alertId,
            alertType,
            severity,
            clientUserId,
            ...(safety ? safetyAlertTap(alertId) : {}),
          },
          deep_link: deepLink,
          channel: 'inapp',
        });
        out.inapp = created ? 'sent' : 'skipped';
      } catch (err) {
        out.inapp = 'failed';
        this.warn('inapp', coachId, err);
      }
    }
    if (only.push !== false) {
      // C-643-2: one device push with quiet lock-screen copy (the alert
      // text can carry client detail, so it stays in the inbox row), gated
      // by the coach_alert_push preference, through the push stack's one
      // sender. It writes no second `push` inbox row. The outbox it queues
      // into retries delivery itself; null = suppressed by a preference or
      // not wired. The caller's display copy is not put on the lock screen.
      try {
        const queued = await this.notifications.sendPush({
          user_id: coachId,
          kind: NotificationKind.COACH_ALERT,
          body: message.slice(0, 160),
          deep_link: deepLink,
          ...(safety
            ? {
                context: { safetyAlert: alertType, alertId, ...(spaceId ? { spaceAlert: true as const } : {}) },
                dedupe_key: `coach_alert:${alertId}`,
              }
            : payload.money
              ? { context: MUTE_ALL_PASS }
              : {}),
          ...(urgent ? { urgent: true } : {}),
        });
        out.push = queued ? 'sent' : 'skipped';
      } catch (err) {
        out.push = 'failed';
        this.warn('push', coachId, err);
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
