import { NotificationKind } from '../notification-kind';
import { dayLabel, formatClock, usableTimeZone } from '../local-time';

// What a push shows on the lock screen (C-643-2 / push delivery).
//
// A lock screen is readable by anyone holding the phone, so push copy comes
// ONLY from the fixed templates below, one per notification kind (Sol
// B-692-1). No caller-supplied text reaches it: not the inbox body, not a
// display name (a profile name is free-form and can hold an email address or
// a health detail), not message text, not coach-written text, not a health
// value. The only variable part is a session time, rendered here from the
// stored instant and a validated zone. Unknown kinds get the generic line.
// The full detail stays in the inbox row the push opens, inside the app.
// Copy rules: no emojis, no exclamation marks, no first person.

export interface LockScreenCopy {
  title: string;
  body: string;
}

const OPEN = 'Open the app to see it.';
const DETAILS = 'Open the app to see the details.';

// Fixed copy per kind. Every kind a push can carry has a template here.
const TEMPLATES: Record<string, LockScreenCopy> = {
  [NotificationKind.MESSAGE_RECEIVED]: {
    title: 'New message',
    body: 'You have a new message. Open the app to read it.',
  },
  [NotificationKind.BOOKING_REQUESTED]: {
    title: 'Session request',
    body: `There is a new session request. ${OPEN}`,
  },
  [NotificationKind.BOOKING_CONFIRMED]: {
    title: 'Session confirmed',
    body: `Your session is confirmed. ${DETAILS}`,
  },
  [NotificationKind.BOOKING_DECLINED]: {
    title: 'Session request',
    body: `Your session request was declined. ${DETAILS}`,
  },
  [NotificationKind.BOOKING_CANCELLED]: {
    title: 'Session cancelled',
    body: `A session was cancelled. ${DETAILS}`,
  },
  [NotificationKind.BOOKING_RESCHEDULED]: {
    title: 'Session moved',
    body: `A session has a new time. ${OPEN}`,
  },
  [NotificationKind.BOOKING_REMINDER_24H]: {
    title: 'Session reminder',
    body: `You have a session in about 24 hours. ${DETAILS}`,
  },
  [NotificationKind.BOOKING_REMINDER_1H]: {
    title: 'Session starting soon',
    body: `Your session starts in about an hour. ${DETAILS}`,
  },
  // B-714-1 / B-653-1 (B-SCHED2-121): the scheduling train's booking kinds.
  [NotificationKind.BOOKING_LINK_NEEDED]: {
    title: 'Add a call link',
    body: 'A session has no call link yet. Open the app to add one.',
  },
  [NotificationKind.BOOKING_LINK_READY]: {
    title: 'Call link ready',
    body: `The call link for your session is ready. ${OPEN}`,
  },
  [NotificationKind.BOOKING_REQUEST_EXPIRED]: {
    title: 'Session request closed',
    body: `A session request has closed. ${DETAILS}`,
  },
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
 * Booking context stored with a push (B-NOTIF-5), so a reminder's time is
 * rendered at the moment it is sent: a 24 h reminder deferred by quiet hours
 * still says "today" or "tomorrow" correctly, and the stored inbox row keeps
 * the absolute date (C-647-3). `otherPartyDisplayName` is accepted for older
 * rows but never rendered (B-692-1).
 */
export interface PushContext {
  sessionId?: string;
  scheduledAt?: string;
  newScheduledAt?: string;
  oldScheduledAt?: string;
  timeZone?: string | null;
  otherPartyDisplayName?: string;
}

function contextTime(context: PushContext | null | undefined): { at: Date; tz: string } | null {
  if (!context?.scheduledAt) return null;
  const tz = usableTimeZone(context.timeZone);
  const at = new Date(context.scheduledAt);
  if (!tz || Number.isNaN(at.getTime())) return null;
  return { at, tz };
}

/**
 * The lock-screen title and body for a push. `_inboxBody` is deliberately
 * ignored (B-692-1): inbox text can carry names, message text or health
 * details, so it never reaches a lock screen.
 */
export function lockScreenCopy(
  kind: string,
  _inboxBody: string,
  context?: PushContext | null,
  now: Date = new Date(),
): LockScreenCopy {
  const timed = contextTime(context);
  if (timed && kind === NotificationKind.BOOKING_REMINDER_24H) {
    return {
      title: TEMPLATES[kind].title,
      body: `Your session is ${dayLabel(timed.at, timed.tz, now)} at ${formatClock(timed.at, timed.tz)}.`,
    };
  }
  if (timed && kind === NotificationKind.BOOKING_REMINDER_1H) {
    return {
      title: TEMPLATES[kind].title,
      body: `Your session starts at ${formatClock(timed.at, timed.tz)}.`,
    };
  }
  return TEMPLATES[kind] ?? DEFAULT_COPY;
}
