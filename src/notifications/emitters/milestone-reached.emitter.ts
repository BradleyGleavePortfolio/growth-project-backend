import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

export interface MilestoneReachedPayload {
  /** Internal milestone label, e.g. 'weight_goal' | 'checkin_streak_30' | 'build_week_complete' */
  milestoneType: string;
  /** Human-readable value, e.g. "185 lbs" or "30 days". Never another user's PII. */
  value?: string;
}

/**
 * MilestoneReachedEmitter — fires when a client hits a personal milestone.
 *
 * Called fire-and-forget from weight, check-ins, and build-week services.
 * The emitter must NEVER throw — callers catch and log in their own service.
 *
 * Body format uses numbers over adjectives ("30-day check-in streak reached")
 * to honour the doctrine rule.
 */
@Injectable()
export class MilestoneReachedEmitter {
  private readonly logger = new Logger(MilestoneReachedEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(userId: string, payload: MilestoneReachedPayload): Promise<void> {
    try {
      const label = payload.value
        ? `${payload.milestoneType.replace(/_/g, ' ')} — ${payload.value}`
        : payload.milestoneType.replace(/_/g, ' ');

      await this.notifications.createNotification({
        user_id: userId,
        kind: NotificationKind.MILESTONE_REACHED,
        body: `Milestone reached: ${label}`.slice(0, 160),
        payload: { milestoneType: payload.milestoneType, value: payload.value },
        deep_link: 'tgp://timeline',
        channel: 'inapp',
      });

      // Also queue a push notification.
      await this.notifications.createNotification({
        user_id: userId,
        kind: NotificationKind.MILESTONE_REACHED,
        body: `Milestone reached: ${label}`.slice(0, 160),
        payload: { milestoneType: payload.milestoneType, value: payload.value },
        deep_link: 'tgp://timeline',
        channel: 'push',
      });
    } catch (err) {
      // Swallow — milestone notification failure must not surface to the client.
      this.logger.warn(
        `MilestoneReachedEmitter failed for user=${userId}: ${(err as Error).message}`,
      );
    }
  }
}
