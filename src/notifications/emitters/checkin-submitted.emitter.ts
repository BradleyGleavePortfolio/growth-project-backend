import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

export interface CheckinSubmittedPayload {
  /** The coach user ID to notify. */
  coachId: string;
  /** Display name of the client (first name or display name — no full name without consent). */
  clientDisplayName: string;
  /** The client user ID for deep-link routing. */
  clientUserId: string;
  /** Current check-in streak length for numeric framing. */
  streakDays: number;
}

/**
 * CheckinSubmittedEmitter — fires when a client submits their daily check-in.
 *
 * Only the COACH receives this notification — the client does not need a
 * confirmation notification (the check-in form itself confirms the submit).
 *
 * Privacy: body contains only the client's display name and streak count.
 * No weight, no mood score, no PII beyond what the coach already sees.
 *
 * Called fire-and-forget from CheckInsService.create when the client has a
 * coach assigned.
 */
@Injectable()
export class CheckinSubmittedEmitter {
  private readonly logger = new Logger(CheckinSubmittedEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(payload: CheckinSubmittedPayload): Promise<void> {
    try {
      const { coachId, clientDisplayName, clientUserId, streakDays } = payload;
      const body =
        `${clientDisplayName} submitted today's check-in. Streak: ${streakDays} day${streakDays !== 1 ? 's' : ''}.`.slice(
          0,
          160,
        );

      await this.notifications.createNotification({
        user_id: coachId,
        kind: NotificationKind.CHECKIN_SUBMITTED,
        body,
        payload: { clientUserId, streakDays },
        deep_link: `tgp://coach/clients/${clientUserId}/checkins`,
        channel: 'inapp',
      });

      // Push is opt-in for coaches (default off per prefs matrix — coaches
      // handle high volumes and push for every check-in is too noisy).
      await this.notifications.createNotification({
        user_id: coachId,
        kind: NotificationKind.CHECKIN_SUBMITTED,
        body,
        payload: { clientUserId, streakDays },
        deep_link: `tgp://coach/clients/${clientUserId}/checkins`,
        channel: 'push',
      });
    } catch (err) {
      this.logger.warn(
        `CheckinSubmittedEmitter failed for coach=${payload.coachId}: ${(err as Error).message}`,
      );
    }
  }
}
