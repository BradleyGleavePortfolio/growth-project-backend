import { NotificationKind } from '../notification-kind';
import { dayLabel, formatClock, usableTimeZone } from '../local-time';

// What a push shows on the lock screen (C-643-2 / push delivery).
//
// A lock screen is readable by anyone holding the phone, so push copy is
// quieter than the inbox row:
//   - never a health detail (weight, check-in contents, streaks, milestone
//     values, meal or workout contents, coach-written text);
//   - never message text;
//   - booking copy keeps the other party's name and the local time, because
//     the reminder is useless without them and neither is a health detail.
// The full detail stays in the inbox row the push opens. Copy rules: no
// emojis, no exclamation marks, plain warm words.

export interface LockScreenCopy {
  title: string;
  body: string;
}

const OPEN = 'Open the app to see it.';

// Kinds whose inbox body is already lock-screen safe (names and times only).
const SAFE_BODY_KINDS: ReadonlySet<string> = new Set([
  NotificationKind.BOOKING_REQUESTED,
  NotificationKind.BOOKING_CONFIRMED,
  NotificationKind.BOOKING_DECLINED,
  NotificationKind.BOOKING_CANCELLED,
  NotificationKind.BOOKING_RESCHEDULED,
  NotificationKind.BOOKING_REMINDER_24H,
  NotificationKind.BOOKING_REMINDER_1H,
  NotificationKind.MESSAGE_RECEIVED, // "New message from <name>", never the text
]);

const TITLES: Record<string, string> = {
  [NotificationKind.BOOKING_REQUESTED]: 'Session request',
  [NotificationKind.BOOKING_CONFIRMED]: 'Session confirmed',
  [NotificationKind.BOOKING_DECLINED]: 'Session request',
  [NotificationKind.BOOKING_CANCELLED]: 'Session cancelled',
  [NotificationKind.BOOKING_RESCHEDULED]: 'Session moved',
  [NotificationKind.BOOKING_REMINDER_24H]: 'Session reminder',
  [NotificationKind.BOOKING_REMINDER_1H]: 'Session starting soon',
  [NotificationKind.MESSAGE_RECEIVED]: 'New message',
};

// Fixed quiet copy for kinds whose inbox body carries personal or health
// detail.
const QUIET: Record<string, LockScreenCopy> = {
  [NotificationKind.MILESTONE_REACHED]: {
    title: 'New milestone',
    body: `You reached a milestone. ${OPEN}`,
  },
  [NotificationKind.WEIGHT_TREND_ALERT]: {
    title: 'Your progress',
    body: `There is a new update on your progress. ${OPEN}`,
  },
  [NotificationKind.MISSED_CHECKIN]: {
    title: 'Check-in',
    body: `There is an update about check-ins. ${OPEN}`,
  },
  [NotificationKind.CHECKIN_SUBMITTED]: {
    title: 'New check-in',
    body: `A client sent a check-in. ${OPEN}`,
  },
  [NotificationKind.COACH_ALERT]: {
    title: 'Client update',
    body: `There is a new update about a client. ${OPEN}`,
  },
  [NotificationKind.BUILD_WEEK_DAY_UNLOCKED]: {
    title: 'Build Week',
    body: `A new day is ready for you. ${OPEN}`,
  },
  [NotificationKind.WORKOUT_ASSIGNED]: {
    title: 'New workout',
    body: `Your coach added a workout for you. ${OPEN}`,
  },
  [NotificationKind.MEAL_PLAN_ASSIGNED]: {
    title: 'New meal plan',
    body: `Your coach added a meal plan for you. ${OPEN}`,
  },
};

const DEFAULT_COPY: LockScreenCopy = {
  title: 'The Growth Project',
  body: `You have a new notification. ${OPEN}`,
};

/**
 * Booking context stored with a push (B-NOTIF-5), so the lock-screen line is
 * rendered at the moment it is sent: a 24 h reminder deferred by quiet hours
 * still says "today" or "tomorrow" correctly, and the stored inbox row keeps
 * the absolute date (C-647-3).
 */
export interface PushContext {
  sessionId?: string;
  scheduledAt?: string;
  newScheduledAt?: string;
  oldScheduledAt?: string;
  timeZone?: string | null;
  otherPartyDisplayName?: string;
}

function contextTime(context: PushContext | null | undefined): {
  at: Date;
  tz: string;
  name: string;
} | null {
  if (!context?.scheduledAt || !context.otherPartyDisplayName) return null;
  const tz = usableTimeZone(context.timeZone);
  const at = new Date(context.scheduledAt);
  if (!tz || Number.isNaN(at.getTime())) return null;
  return { at, tz, name: context.otherPartyDisplayName };
}

export function lockScreenCopy(
  kind: string,
  inboxBody: string,
  context?: PushContext | null,
  now: Date = new Date(),
): LockScreenCopy {
  const timed = contextTime(context);
  if (timed && kind === NotificationKind.BOOKING_REMINDER_24H) {
    return {
      title: TITLES[kind],
      body: `Your session with ${timed.name} is ${dayLabel(timed.at, timed.tz, now)} at ${formatClock(timed.at, timed.tz)}.`.slice(
        0,
        160,
      ),
    };
  }
  if (timed && kind === NotificationKind.BOOKING_REMINDER_1H) {
    return {
      title: TITLES[kind],
      body: `Your session with ${timed.name} starts at ${formatClock(timed.at, timed.tz)}.`.slice(
        0,
        160,
      ),
    };
  }
  if (SAFE_BODY_KINDS.has(kind)) {
    const body = inboxBody.trim().slice(0, 160);
    return {
      title: TITLES[kind] ?? DEFAULT_COPY.title,
      body: body.length > 0 ? body : DEFAULT_COPY.body,
    };
  }
  return QUIET[kind] ?? DEFAULT_COPY;
}
