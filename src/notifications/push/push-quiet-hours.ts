import { NotificationKind } from '../notification-kind';
import { QuietHoursPolicy } from '../nudges/quiet-hours.policy';
import { usableTimeZone } from '../local-time';
import type { PushContext } from './lock-screen-copy';

// OR-113-5: device pushes respect quiet hours, 21:00-08:00 in the
// recipient's own zone. A non-urgent push inside the window waits until
// 08:00 local (it is deferred, never dropped). An urgent push goes now.
//
// One definition of the window: the nudge engine's QuietHoursPolicy (the
// broadcast scheduler reuses it too).
//
// Urgent (bypasses quiet hours):
//   - the 1 h session reminder, always;
//   - any booking event whose session (or, for a move, the old or the new
//     time) starts before 08:00 local + URGENT_LEAD_MS: waiting for the
//     morning would deliver it too late to act on (a 07:30 session cancelled
//     at 23:00).
// Everything else (messages, milestones, check-ins, coach alerts, progress
// updates, the 24 h reminder of a later session) waits for the morning.
//
// No usable zone for the recipient (none supplied and no coach zone): the
// window cannot be placed, so the push is sent now rather than guessed in a
// zone that may be wrong. recipient-timezone.ts falls back to the coach's
// zone first, so this is rare.

export const URGENT_LEAD_MS = 2 * 60 * 60_000;

const BOOKING_KINDS: ReadonlySet<string> = new Set([
  NotificationKind.BOOKING_REQUESTED,
  NotificationKind.BOOKING_CONFIRMED,
  NotificationKind.BOOKING_DECLINED,
  NotificationKind.BOOKING_CANCELLED,
  NotificationKind.BOOKING_RESCHEDULED,
  NotificationKind.BOOKING_REMINDER_24H,
  NotificationKind.BOOKING_REMINDER_1H,
]);

export type QuietHoursOutcome =
  | { deliverAt: Date; deferred: false; reason: 'open' | 'urgent' | 'no-zone' }
  | { deliverAt: Date; deferred: true; reason: 'quiet_hours' };

function sessionTimes(context: PushContext | null | undefined): number[] {
  if (!context) return [];
  return [context.scheduledAt, context.newScheduledAt, context.oldScheduledAt]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => new Date(v).getTime())
    .filter((t) => Number.isFinite(t));
}

export function quietHoursFor(args: {
  kind: string;
  timeZone: string | null | undefined;
  context?: PushContext | null;
  urgent?: boolean;
  now: Date;
}): QuietHoursOutcome {
  const tz = usableTimeZone(args.timeZone);
  if (!tz) return { deliverAt: args.now, deferred: false, reason: 'no-zone' };
  const decision = QuietHoursPolicy.evaluate(args.now, tz);
  if (decision.allowed || !decision.deferred_until) {
    return { deliverAt: args.now, deferred: false, reason: 'open' };
  }
  const morning = decision.deferred_until;
  if (args.urgent || args.kind === NotificationKind.BOOKING_REMINDER_1H) {
    return { deliverAt: args.now, deferred: false, reason: 'urgent' };
  }
  if (BOOKING_KINDS.has(args.kind)) {
    const tooLate = sessionTimes(args.context).some((t) => t < morning.getTime() + URGENT_LEAD_MS);
    if (tooLate) return { deliverAt: args.now, deferred: false, reason: 'urgent' };
  }
  return { deliverAt: morning, deferred: true, reason: 'quiet_hours' };
}
