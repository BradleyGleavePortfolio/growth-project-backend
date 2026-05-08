import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

export interface BuildWeekDayUnlockedPayload {
  /** Day number 1–7 that was just unlocked. */
  dayNumber: number;
  /** Day title, e.g. "STRATEGY". Used in the body for context. */
  dayTitle: string;
}

/**
 * BuildWeekDayUnlockedEmitter — fires when a coach approves a gated day and
 * the next Build Week day becomes available to the client.
 *
 * Also fires on Day 1 when the enrollment is first created (day 1 is
 * unlocked immediately without a gate).
 *
 * Called fire-and-forget from BuildWeekService.approveGate.
 */
@Injectable()
export class BuildWeekDayUnlockedEmitter {
  private readonly logger = new Logger(BuildWeekDayUnlockedEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(clientUserId: string, payload: BuildWeekDayUnlockedPayload): Promise<void> {
    try {
      const { dayNumber, dayTitle } = payload;
      const body =
        `Day ${dayNumber} — ${dayTitle} is now unlocked. Complete today's tasks to keep your Build Week on track.`.slice(
          0,
          160,
        );

      await this.notifications.createNotification({
        user_id: clientUserId,
        kind: NotificationKind.BUILD_WEEK_DAY_UNLOCKED,
        body,
        payload: { dayNumber, dayTitle },
        deep_link: `tgp://build-week/day/${dayNumber}`,
        channel: 'inapp',
      });

      await this.notifications.createNotification({
        user_id: clientUserId,
        kind: NotificationKind.BUILD_WEEK_DAY_UNLOCKED,
        body,
        payload: { dayNumber, dayTitle },
        deep_link: `tgp://build-week/day/${dayNumber}`,
        channel: 'push',
      });
    } catch (err) {
      this.logger.warn(
        `BuildWeekDayUnlockedEmitter failed for user=${clientUserId}: ${(err as Error).message}`,
      );
    }
  }
}
