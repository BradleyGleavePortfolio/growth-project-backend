import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind, type NotificationKindValue } from '../notification-kind';
import { NotificationCategory } from '../notification-category.enum';
import type { PushDeliveryCode } from '../push-delivery.types';
import { safeLogDiagnostic } from '../../observability/orm-diagnostics';
import { PrismaService } from '../../prisma.service';
import { resolveRecipientTimeZone } from '../recipient-timezone';

// Booking lifecycle notifications: one in-app row (the notification center
// entry) plus a real push through the shared Expo transport
// (NotificationsService.pushToUser) with fixed lock-screen copy.
//
// S-SCHED-2:
//  - Before this, the emitter wrote an in-app row and a channel='push' row but
//    never sent anything to a device. It now delivers the push and returns the
//    typed outcome, so the reminder sweep and tests can see what happened.
//  - Exactly one inbox row per event (the in-app row). The push is gated on
//    the recipient's booking_push / muted preference directly, so a booking
//    event no longer shows twice in the notification center and two different
//    clients booking within a minute do not rate-limit each other's push.
//  - Tap target: the push data and the in-app payload both carry
//    actionScreen/actionParams, the format the mobile push router and
//    notification center consume. Clients land on CalendarSession, coaches on
//    CoachBookingInbox, both with { sessionId }.
//  - Times are written in the recipient's own zone with the zone named, e.g.
//    "Mon, Oct 5, 9:00 AM PDT", never in UTC (B-643-1). The zone comes from
//    recipient-timezone.ts (zone provenance, B-647-1 / B-647-2): a zone the
//    person actually supplied, else the coach's published zone. With no
//    usable zone the copy has no clock time at all (never a silent Pacific
//    default), and every payload carries the zone it was written in.
//  - C-647-3: the stored 24h reminder names the date, not "tomorrow", so it
//    is still true when read the next day.
//  - Copy is plain and calm (no exclamation marks, no emojis). Each message
//    says what happened and, where there is one, the next step.
//  - B-714-1 / B-653-1: the push (lock screen) never carries the inbox text.
//    Its title and body are the fixed per-kind lines in BOOKING_LOCK_SCREEN:
//    no display name, no coach-written text (type names, notes, reasons).
//    Only a reminder keeps its time. The full detail stays in the inbox row.
//  - Emitters never throw: booking state must not fail because delivery did.

export type BookingRecipientRole = 'client' | 'coach';

interface BaseBookingPayload {
  sessionId: string;
  /** Appointment type name, e.g. "Quick Q/A Call". Null for untyped legacy sessions. */
  sessionTypeName?: string | null;
}

export interface BookingRequestedPayload extends BaseBookingPayload {
  coachUserId: string;
  clientDisplayName: string;
  requestedAt: Date;
  scheduledAt?: Date;
  notes: string | null;
}

export interface BookingBookedPayload extends BaseBookingPayload {
  coachUserId: string;
  clientDisplayName: string;
  scheduledAt: Date;
}

export interface BookingConfirmedPayload extends BaseBookingPayload {
  clientUserId: string;
  coachDisplayName: string;
  scheduledAt: Date;
  /** true when the type confirms instantly (no coach approval step). */
  instant?: boolean;
}

export interface BookingDeclinedPayload extends BaseBookingPayload {
  clientUserId: string;
  coachDisplayName: string;
  requestedAt: Date;
  scheduledAt?: Date;
  declineReason: string | null;
}

export interface BookingCancelledPayload extends BaseBookingPayload {
  recipientUserId: string;
  recipientRole?: BookingRecipientRole;
  cancellingPartyDisplayName: string;
  scheduledAt: Date;
  cancelReason: string | null;
}

export interface BookingRescheduledPayload extends BaseBookingPayload {
  recipientUserId: string;
  recipientRole?: BookingRecipientRole;
  reschedulerDisplayName: string;
  oldScheduledAt: Date;
  newScheduledAt: Date;
}

export interface BookingMoveRequestedPayload extends BaseBookingPayload {
  coachUserId: string;
  clientDisplayName: string;
  oldScheduledAt: Date;
  newScheduledAt: Date;
}

export interface BookingReminderPayload extends BaseBookingPayload {
  recipientUserId: string;
  recipientRole?: BookingRecipientRole;
  otherPartyDisplayName: string;
  scheduledAt: Date;
  /** false when the confirmed session still has no call link. */
  hasMeetingLink?: boolean;
  /**
   * S-SCHED-3 (B-634-2) retry of a partly delivered reminder: the channel
   * that already landed is skipped so the recipient never gets it twice.
   */
  skipInApp?: boolean;
  skipPush?: boolean;
  /** In-app row written by an earlier attempt; the retried push links to it. */
  notificationId?: string | null;
}

export interface BookingLinkNeededPayload extends BaseBookingPayload {
  coachUserId: string;
  clientDisplayName: string;
  scheduledAt: Date;
}

export interface BookingLinkReadyPayload extends BaseBookingPayload {
  clientUserId: string;
  coachDisplayName: string;
  scheduledAt: Date;
}

export interface BookingRequestExpiredPayload extends BaseBookingPayload {
  recipientUserId: string;
  recipientRole: BookingRecipientRole;
  /** The client's name for the coach's notice, the coach's for the client's. */
  otherPartyDisplayName: string;
  scheduledAt: Date;
  /** S-SCHED-5 retry of a partly delivered notice (same rule as reminders). */
  skipInApp?: boolean;
  skipPush?: boolean;
  notificationId?: string | null;
}

export interface BookingDeliveryOutcome {
  inapp: 'written' | 'suppressed' | 'failed' | 'skipped';
  push: PushDeliveryCode | 'disabled' | 'failed' | 'skipped';
  /** Id of the in-app row this call wrote (or was handed), when there is one. */
  notificationId?: string | null;
}

// S-SCHED-3 (B-634-2): which outcomes are final for a channel. A retry can
// only help transient failures; no device token or a muted preference is a
// settled answer, not a failure to retry.
export function inAppSettled(o: BookingDeliveryOutcome['inapp']): boolean {
  return o === 'written' || o === 'suppressed' || o === 'skipped';
}
export function pushSettled(o: BookingDeliveryOutcome['push']): boolean {
  return (
    o === 'delivered' ||
    o === 'no-token' ||
    o === 'invalid-token' ||
    o === 'disabled' ||
    o === 'skipped'
  );
}

export const BOOKING_PUSH_SCREEN: Record<BookingRecipientRole, string> = {
  client: 'CalendarSession',
  coach: 'CoachBookingInbox',
};

@Injectable()
export class BookingEmitter {
  private readonly logger = new Logger(BookingEmitter.name);

  constructor(
    private readonly notifications: NotificationsService,
    // C-647-2: required. PrismaModule is @Global; a lost provider must fail
    // at boot, not silently drop every clock time from booking copy.
    private readonly prisma: PrismaService,
  ) {}

  // (a) booking_requested -> COACH, a client asked for a coach-approval type.
  async emitRequested(p: BookingRequestedPayload): Promise<BookingDeliveryOutcome> {
    const tz = p.scheduledAt ? await this.zoneFor(p.coachUserId, p.sessionId) : null;
    const when = p.scheduledAt && tz ? formatWhen(p.scheduledAt, tz) : null;
    const what = typeLabel(p.sessionTypeName, 'a session');
    const body = when
      ? `${p.clientDisplayName} asked for ${what} on ${when}. Approve or decline in your booking inbox.`
      : `${p.clientDisplayName} requested ${what}. Approve or decline in your booking inbox.`;
    return this.deliver({
      userId: p.coachUserId,
      role: 'coach',
      kind: NotificationKind.BOOKING_REQUESTED,
      title: 'New session request',
      body,
      sessionId: p.sessionId,
      deepLink: `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        clientDisplayName: p.clientDisplayName,
        requestedAt: p.requestedAt.toISOString(),
        scheduledAt: p.scheduledAt ? p.scheduledAt.toISOString() : null,
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
        notes: p.notes,
      },
    });
  }

  // (a2) booking_confirmed -> COACH, a client booked an instant-confirm type.
  async emitBooked(p: BookingBookedPayload): Promise<BookingDeliveryOutcome> {
    const tz = await this.zoneFor(p.coachUserId, p.sessionId);
    const what = typeLabel(p.sessionTypeName, 'a session');
    return this.deliver({
      userId: p.coachUserId,
      role: 'coach',
      kind: NotificationKind.BOOKING_CONFIRMED,
      title: 'New session booked',
      body: tz
        ? `${p.clientDisplayName} booked ${what} on ${formatWhen(p.scheduledAt, tz)}.`
        : `${p.clientDisplayName} booked ${what}. Open the session to see the time.`,
      sessionId: p.sessionId,
      deepLink: `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        clientDisplayName: p.clientDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (b) booking_confirmed -> CLIENT, coach approved or the type confirms instantly.
  async emitConfirmed(p: BookingConfirmedPayload): Promise<BookingDeliveryOutcome> {
    const tz = await this.zoneFor(p.clientUserId, p.sessionId);
    const when = tz ? formatWhen(p.scheduledAt, tz) : null;
    const what = typeLabel(p.sessionTypeName, 'session');
    const body = p.instant
      ? when
        ? `Your ${what} with ${p.coachDisplayName} is confirmed for ${when}.`
        : `Your ${what} with ${p.coachDisplayName} is confirmed. Open the session to see the time.`
      : when
        ? `${p.coachDisplayName} confirmed your ${what} on ${when}.`
        : `${p.coachDisplayName} confirmed your ${what}. Open the session to see the time.`;
    return this.deliver({
      userId: p.clientUserId,
      role: 'client',
      kind: NotificationKind.BOOKING_CONFIRMED,
      title: 'Session confirmed',
      body,
      sessionId: p.sessionId,
      deepLink: `tgp://client/sessions/${p.sessionId}`,
      payload: {
        coachDisplayName: p.coachDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (c) booking_declined -> CLIENT.
  async emitDeclined(p: BookingDeclinedPayload): Promise<BookingDeliveryOutcome> {
    const what = typeLabel(p.sessionTypeName, 'session');
    const tz = p.scheduledAt ? await this.zoneFor(p.clientUserId, p.sessionId) : null;
    const when = p.scheduledAt && tz ? formatWhen(p.scheduledAt, tz) : null;
    const body = when
      ? `${p.coachDisplayName} could not take your ${what} request for ${when}. Pick another time in Calendar.`
      : `${p.coachDisplayName} could not take your ${what} request. Pick another time in Calendar.`;
    return this.deliver({
      userId: p.clientUserId,
      role: 'client',
      kind: NotificationKind.BOOKING_DECLINED,
      title: 'Session request declined',
      body,
      sessionId: p.sessionId,
      deepLink: `tgp://client/sessions/${p.sessionId}`,
      payload: {
        coachDisplayName: p.coachDisplayName,
        requestedAt: p.requestedAt.toISOString(),
        scheduledAt: p.scheduledAt ? p.scheduledAt.toISOString() : null,
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
        declineReason: p.declineReason,
      },
    });
  }

  // (d) booking_cancelled -> the OTHER party.
  async emitCancelled(p: BookingCancelledPayload): Promise<BookingDeliveryOutcome> {
    const role = p.recipientRole ?? 'client';
    const tz = await this.zoneFor(p.recipientUserId, p.sessionId);
    const what = typeLabel(p.sessionTypeName, 'session');
    const next = role === 'client' ? ' You can book a new time in Calendar.' : '';
    return this.deliver({
      userId: p.recipientUserId,
      role,
      kind: NotificationKind.BOOKING_CANCELLED,
      title: 'Session cancelled',
      body: tz
        ? `${p.cancellingPartyDisplayName} cancelled the ${what} on ${formatWhen(p.scheduledAt, tz)}.${next}`
        : `${p.cancellingPartyDisplayName} cancelled your upcoming ${what}.${next}`,
      sessionId: p.sessionId,
      deepLink: `tgp://sessions/${p.sessionId}`,
      payload: {
        cancellingPartyDisplayName: p.cancellingPartyDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
        cancelReason: p.cancelReason,
      },
    });
  }

  // (e) booking_rescheduled -> the OTHER party, the move took effect.
  async emitRescheduled(p: BookingRescheduledPayload): Promise<BookingDeliveryOutcome> {
    const role = p.recipientRole ?? 'client';
    const tz = await this.zoneFor(p.recipientUserId, p.sessionId);
    const what = typeLabel(p.sessionTypeName, 'session');
    return this.deliver({
      userId: p.recipientUserId,
      role,
      kind: NotificationKind.BOOKING_RESCHEDULED,
      title: 'Session moved',
      body: tz
        ? `${p.reschedulerDisplayName} moved your ${what} to ${formatWhen(p.newScheduledAt, tz)}.`
        : `${p.reschedulerDisplayName} moved your ${what} to a new time. Open the session to see it.`,
      sessionId: p.sessionId,
      deepLink: `tgp://sessions/${p.sessionId}`,
      payload: {
        reschedulerDisplayName: p.reschedulerDisplayName,
        oldScheduledAt: p.oldScheduledAt.toISOString(),
        newScheduledAt: p.newScheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (e2) booking_rescheduled -> COACH, a client moved a coach-approval session;
  // it is back to awaiting approval at the new time.
  async emitMoveRequested(p: BookingMoveRequestedPayload): Promise<BookingDeliveryOutcome> {
    const tz = await this.zoneFor(p.coachUserId, p.sessionId);
    const to = tz ? formatWhen(p.newScheduledAt, tz) : 'a new time';
    return this.deliver({
      userId: p.coachUserId,
      role: 'coach',
      kind: NotificationKind.BOOKING_RESCHEDULED,
      title: 'Session move requested',
      body: `${p.clientDisplayName} asked to move ${typeLabel(p.sessionTypeName, 'a session')} to ${to}. Approve or decline in your booking inbox.`,
      sessionId: p.sessionId,
      deepLink: `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        clientDisplayName: p.clientDisplayName,
        oldScheduledAt: p.oldScheduledAt.toISOString(),
        newScheduledAt: p.newScheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (f) booking_reminder_24h -> one participant.
  async emitReminder24h(p: BookingReminderPayload): Promise<BookingDeliveryOutcome> {
    return this.reminder(p, NotificationKind.BOOKING_REMINDER_24H);
  }

  // (g) booking_reminder_1h -> one participant.
  async emitReminder1h(p: BookingReminderPayload): Promise<BookingDeliveryOutcome> {
    return this.reminder(p, NotificationKind.BOOKING_REMINDER_1H);
  }

  // (h) booking_link_needed -> COACH, a confirmed session has no call link.
  async emitLinkNeeded(p: BookingLinkNeededPayload): Promise<BookingDeliveryOutcome> {
    const tz = await this.zoneFor(p.coachUserId, p.sessionId);
    const what = typeLabel(p.sessionTypeName, 'session');
    return this.deliver({
      userId: p.coachUserId,
      role: 'coach',
      kind: NotificationKind.BOOKING_LINK_NEEDED,
      title: 'Add a call link',
      body: tz
        ? `Your ${what} with ${p.clientDisplayName} on ${formatWhen(p.scheduledAt, tz)} has no call link yet. Add one so they can join.`
        : `Your upcoming ${what} with ${p.clientDisplayName} has no call link yet. Add one so they can join.`,
      sessionId: p.sessionId,
      deepLink: `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        clientDisplayName: p.clientDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (i) booking_link_ready -> CLIENT, the coach added the call link.
  async emitLinkReady(p: BookingLinkReadyPayload): Promise<BookingDeliveryOutcome> {
    const tz = await this.zoneFor(p.clientUserId, p.sessionId);
    const what = typeLabel(p.sessionTypeName, 'session');
    return this.deliver({
      userId: p.clientUserId,
      role: 'client',
      kind: NotificationKind.BOOKING_LINK_READY,
      title: 'Call link ready',
      body: tz
        ? `${p.coachDisplayName} added the call link for your ${what} on ${formatWhen(p.scheduledAt, tz)}.`
        : `${p.coachDisplayName} added the call link for your upcoming ${what}.`,
      sessionId: p.sessionId,
      deepLink: `tgp://client/sessions/${p.sessionId}`,
      payload: {
        coachDisplayName: p.coachDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (k) booking_request_expired -> BOTH sides, once each (S-SCHED-5). Calm,
  // no blame: what happened, that the time is open again, and the next step.
  async emitRequestExpired(p: BookingRequestExpiredPayload): Promise<BookingDeliveryOutcome> {
    const tz = await this.zoneFor(p.recipientUserId, p.sessionId);
    const what = typeLabel(p.sessionTypeName, 'session');
    const forWhen = tz ? ` for ${formatWhen(p.scheduledAt, tz)}` : '';
    const body =
      p.recipientRole === 'client'
        ? `Your ${what} request${forWhen} was not confirmed in time, so it has closed. Pick another time in Calendar.`
        : `${p.otherPartyDisplayName}'s ${what} request${forWhen} closed without an answer, and the time is open again.`;
    return this.deliver({
      userId: p.recipientUserId,
      role: p.recipientRole,
      kind: NotificationKind.BOOKING_REQUEST_EXPIRED,
      title: 'Session request closed',
      body,
      sessionId: p.sessionId,
      deepLink:
        p.recipientRole === 'client'
          ? `tgp://client/sessions/${p.sessionId}`
          : `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        otherPartyDisplayName: p.otherPartyDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
      },
      skipInApp: p.skipInApp === true,
      skipPush: p.skipPush === true,
      notificationId: p.notificationId ?? null,
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async reminder(
    p: BookingReminderPayload,
    kind: NotificationKindValue,
  ): Promise<BookingDeliveryOutcome> {
    const role = p.recipientRole ?? 'client';
    const tz = await this.zoneFor(p.recipientUserId, p.sessionId);
    const what = typeLabel(p.sessionTypeName, 'session');
    const withWhom = `Your ${what} with ${p.otherPartyDisplayName}`;
    const lead =
      kind === NotificationKind.BOOKING_REMINDER_24H
        ? tz
          ? // C-647-3: the stored body names the date, so it stays true
            // when read the next day.
            `${withWhom} is on ${formatWhen(p.scheduledAt, tz)}.`
          : `${withWhom} is in about 24 hours.`
        : tz
          ? `${withWhom} starts at ${formatTime(p.scheduledAt, tz)}.`
          : `${withWhom} starts in about an hour.`;
    let tail = '';
    if (p.hasMeetingLink === false) {
      tail =
        role === 'coach'
          ? ' It has no call link yet. Add one so they can join.'
          : ' Your coach will add the call link before it starts.';
    }
    return this.deliver({
      userId: p.recipientUserId,
      role,
      kind,
      title:
        kind === NotificationKind.BOOKING_REMINDER_24H
          ? 'Session tomorrow'
          : 'Session starting soon',
      body: `${lead}${tail}`,
      sessionId: p.sessionId,
      deepLink: `tgp://sessions/${p.sessionId}`,
      payload: {
        otherPartyDisplayName: p.otherPartyDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        timeZone: tz,
        sessionTypeName: p.sessionTypeName ?? null,
        hasMeetingLink: p.hasMeetingLink ?? null,
      },
      skipInApp: p.skipInApp === true,
      skipPush: p.skipPush === true,
      notificationId: p.notificationId ?? null,
    });
  }

  private async deliver(args: {
    userId: string;
    role: BookingRecipientRole;
    kind: NotificationKindValue;
    title: string;
    body: string;
    sessionId: string;
    deepLink: string;
    payload: Record<string, unknown>;
    skipInApp?: boolean;
    skipPush?: boolean;
    notificationId?: string | null;
  }): Promise<BookingDeliveryOutcome> {
    const body = args.body.slice(0, 160);
    const actionScreen = BOOKING_PUSH_SCREEN[args.role];
    const actionParams = { sessionId: args.sessionId };
    const outcome: BookingDeliveryOutcome = {
      inapp: 'failed',
      push: 'failed',
      notificationId: args.notificationId ?? null,
    };
    let notificationId: string | null = args.notificationId ?? null;

    if (args.skipInApp) {
      outcome.inapp = 'skipped';
    } else {
      try {
        const row = await this.notifications.createNotification({
          user_id: args.userId,
          kind: args.kind,
          body,
          payload: {
            ...args.payload,
            sessionId: args.sessionId,
            title: args.title,
            recipientRole: args.role,
            actionScreen,
            actionParams,
            category: NotificationCategory.COACH_DIRECT,
          },
          deep_link: args.deepLink,
          channel: 'inapp',
        });
        outcome.inapp = row ? 'written' : 'suppressed';
        notificationId = row && typeof row.id === 'string' ? row.id : null;
        outcome.notificationId = notificationId;
      } catch (err) {
        this.logger.warn(
          `BookingEmitter ${args.kind} in-app write failed for user=${args.userId}: ${emitterDiagnostic(err)}`,
        );
      }
    }

    if (args.skipPush) {
      outcome.push = 'skipped';
      return outcome;
    }
    try {
      if (!(await this.pushAllowed(args.userId))) {
        outcome.push = 'disabled';
        return outcome;
      }
      // B-714-1 / B-653-1: fixed per-kind lock-screen copy, never the inbox text.
      const lock = bookingLockScreenCopy(args.kind, args.payload);
      const result = await this.notifications.pushToUser(args.userId, lock.title, lock.body, {
        kind: args.kind,
        category: NotificationCategory.COACH_DIRECT,
        actionScreen,
        actionParams,
        ...(notificationId ? { notificationId } : {}),
      });
      outcome.push = result.code;
      if (!result.delivered && result.code !== 'no-token') {
        this.logger.warn(
          `BookingEmitter ${args.kind} push not delivered for user=${args.userId}: ${result.code}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `BookingEmitter ${args.kind} push failed for user=${args.userId}: ${emitterDiagnostic(err)}`,
      );
    }
    return outcome;
  }

  private async pushAllowed(userId: string): Promise<boolean> {
    const prefs: Record<string, unknown> = await this.notifications.getPreferences(userId);
    if (prefs.muted === true) return false;
    return prefs.booking_push !== false;
  }

  // Recipient-local wording (B-643-1, zone provenance B-647-1 / B-647-2):
  // the zone the person supplied, else the coach's published zone, else null
  // (the caller then writes copy without a clock time). Never throws.
  private zoneFor(userId: string, sessionId: string): Promise<string | null> {
    return resolveRecipientTimeZone(this.prisma, userId, sessionId);
  }
}

/**
 * B-634-8: the only text a BookingEmitter log line carries for an error.
 * Booking notification bodies and payloads hold display names and private
 * request/decline/cancel notes, and an ORM error (or any error wrapping one
 * as a cause) can echo those query arguments in its message, stack or meta.
 * ORM errors collapse to `DatabaseRequestError: Database request failed
 * (P####)` through the shared safeDiagnostic; any other error keeps only its
 * class name and a machine-shaped `code`, never its message.
 */
export function emitterDiagnostic(err: unknown): string {
  return safeLogDiagnostic(err);
}

// B-714-1 / B-653-1 (lock-screen privacy): a lock screen is readable by anyone
// holding the phone, so a booking push shows ONLY these fixed lines, one per
// kind. Wording matches the push stack's lock-screen-copy.ts (B-692-1), so
// routing through its sender keeps the same copy. Unknown kinds get a
// generic line. No first person, no exclamation marks.
const LOCK_OPEN = 'Open the app to see it.';
const LOCK_DETAILS = 'Open the app to see the details.';
export const BOOKING_LOCK_SCREEN: Readonly<Record<string, { title: string; body: string }>> = {
  [NotificationKind.BOOKING_REQUESTED]: {
    title: 'Session request',
    body: `There is a new session request. ${LOCK_OPEN}`,
  },
  [NotificationKind.BOOKING_CONFIRMED]: {
    title: 'Session confirmed',
    body: `Your session is confirmed. ${LOCK_DETAILS}`,
  },
  [NotificationKind.BOOKING_DECLINED]: {
    title: 'Session request',
    body: `Your session request was declined. ${LOCK_DETAILS}`,
  },
  [NotificationKind.BOOKING_CANCELLED]: {
    title: 'Session cancelled',
    body: `A session was cancelled. ${LOCK_DETAILS}`,
  },
  [NotificationKind.BOOKING_RESCHEDULED]: {
    title: 'Session moved',
    body: `A session has a new time. ${LOCK_OPEN}`,
  },
  [NotificationKind.BOOKING_REMINDER_24H]: {
    title: 'Session reminder',
    body: `You have a session in about 24 hours. ${LOCK_DETAILS}`,
  },
  [NotificationKind.BOOKING_REMINDER_1H]: {
    title: 'Session starting soon',
    body: `Your session starts in about an hour. ${LOCK_DETAILS}`,
  },
  [NotificationKind.BOOKING_LINK_NEEDED]: {
    title: 'Add a call link',
    body: 'A session has no call link yet. Open the app to add one.',
  },
  [NotificationKind.BOOKING_LINK_READY]: {
    title: 'Call link ready',
    body: `The call link for your session is ready. ${LOCK_OPEN}`,
  },
  [NotificationKind.BOOKING_REQUEST_EXPIRED]: {
    title: 'Session request closed',
    body: `A session request has closed. ${LOCK_DETAILS}`,
  },
};
const LOCK_DEFAULT = {
  title: 'The Growth Project',
  body: `You have a new notification. ${LOCK_OPEN}`,
};

/**
 * The lock-screen title and body for a booking push. Reads only the kind and,
 * for reminders, the stored instant and zone (the payload's scheduledAt and
 * timeZone); every other payload field is ignored, so no name or free text
 * can reach the lock screen. A reminder with no usable zone or instant gets
 * its fixed line with no clock time.
 */
export function bookingLockScreenCopy(
  kind: string,
  context?: { scheduledAt?: unknown; timeZone?: unknown } | null,
): { title: string; body: string } {
  const fixed = BOOKING_LOCK_SCREEN[kind] ?? LOCK_DEFAULT;
  const tz = typeof context?.timeZone === 'string' ? context.timeZone : null;
  const at = typeof context?.scheduledAt === 'string' ? new Date(context.scheduledAt) : null;
  if (!tz || !at || Number.isNaN(at.getTime())) return { ...fixed };
  try {
    if (kind === NotificationKind.BOOKING_REMINDER_24H) {
      return { title: fixed.title, body: `Your session is on ${formatWhen(at, tz)}.` };
    }
    if (kind === NotificationKind.BOOKING_REMINDER_1H) {
      return { title: fixed.title, body: `Your session starts at ${formatTime(at, tz)}.` };
    }
  } catch {
    // An unusable zone keeps the fixed line (no clock time, never UTC).
  }
  return { ...fixed };
}

function typeLabel(name: string | null | undefined, fallback: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  return n ? n.slice(0, 60) : fallback;
}

// e.g. "Mon, Oct 5, 9:00 AM PDT". The app renders the payload's ISO
// timestamp in the device zone; this is the lock-screen wording.
export function formatWhen(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

// e.g. "9:00 AM PDT".
export function formatTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}
