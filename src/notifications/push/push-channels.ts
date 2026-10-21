import { NotificationKind } from '../notification-kind';
import { notificationPrefsPrefix } from './push-preferences';

// Android notification channel for each push (Opus B-693-1).
//
// Android shows a push only on a channel the app created; Expo documents that
// a push naming a channel the device does not have is not displayed. The
// mobile app creates exactly these four at start-up
// (growth-project-mobile src/notifications/push-channels.ts PUSH_CHANNEL):
// keep this list identical to it. test/push-channels.spec.ts pins it.
export const ANDROID_PUSH_CHANNELS = {
  COACH_MESSAGES: 'coach-messages',
  CLIENT_BOT: 'client-bot',
  MILESTONES: 'milestones',
  SYSTEM: 'system',
} as const;

export type AndroidPushChannel = (typeof ANDROID_PUSH_CHANNELS)[keyof typeof ANDROID_PUSH_CHANNELS];

/**
 * The channel a kind is shown on. Messages use the high-importance
 * coach-messages channel; booking events (time-critical), coach alerts and
 * anything not listed use system; milestones and progress use milestones;
 * reminders, nudges, check-ins, Build Week and new content use client-bot.
 */
export function androidChannelFor(kind: string): AndroidPushChannel {
  const prefix = notificationPrefsPrefix(kind);
  if (prefix === 'message') return ANDROID_PUSH_CHANNELS.COACH_MESSAGES;
  if (prefix === 'booking') return ANDROID_PUSH_CHANNELS.SYSTEM;
  if (prefix === 'milestone' || prefix === 'weight_trend') return ANDROID_PUSH_CHANNELS.MILESTONES;
  if (
    kind === NotificationKind.MISSED_CHECKIN ||
    kind === NotificationKind.BUILD_WEEK_DAY_UNLOCKED ||
    kind === NotificationKind.WORKOUT_ASSIGNED ||
    kind === NotificationKind.MEAL_PLAN_ASSIGNED ||
    kind === NotificationKind.WORKOUT_REMINDER ||
    kind === NotificationKind.DRIP_RELEASED ||
    kind.startsWith('nudge_')
  ) {
    return ANDROID_PUSH_CHANNELS.CLIENT_BOT;
  }
  return ANDROID_PUSH_CHANNELS.SYSTEM;
}

/** RENEWAL-BE: the button category a push names; only the Day 7 renewal push has one (the phone registers it). */
export function pushCategoryFor(kind: string, data: Record<string, unknown>): { categoryId?: string } {
  return kind === NotificationKind.PLAN_RENEWAL && typeof data.categoryId === 'string' ? { categoryId: data.categoryId } : {};
}
