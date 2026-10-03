import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind, type NotificationKindValue } from '../notification-kind';
import { NotificationCategory } from '../notification-category.enum';
import type { PushDeliveryCode } from '../push-delivery.types';

// Booking lifecycle notifications: one in-app row (the notification center
// entry) plus a real push through the shared Expo transport
// (NotificationsService.pushToUser).
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
//  - Times are written in the recipient's zone (NotificationPreferences.timezone)
//    with the zone abbreviation, e.g. "Mon, Oct 5, 9:00 AM PDT".
//  - Copy is plain and calm (no exclamation marks, no emojis). Each message
//    says what happened and, where there is one, the next step.
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

  constructor(private readonly notifications: NotificationsService) {}

  // (a) booking_requested -> COACH, a client asked for a coach-approval type.
  async emitRequested(p: BookingRequestedPayload): Promise<BookingDeliveryOutcome> {
    const when = p.scheduledAt ? await this.whenFor(p.coachUserId, p.scheduledAt) : null;
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
        sessionTypeName: p.sessionTypeName ?? null,
        notes: p.notes,
      },
    });
  }

  // (a2) booking_confirmed -> COACH, a client booked an instant-confirm type.
  async emitBooked(p: BookingBookedPayload): Promise<BookingDeliveryOutcome> {
    const when = await this.whenFor(p.coachUserId, p.scheduledAt);
    return this.deliver({
      userId: p.coachUserId,
      role: 'coach',
      kind: NotificationKind.BOOKING_CONFIRMED,
      title: 'New session booked',
      body: `${p.clientDisplayName} booked ${typeLabel(p.sessionTypeName, 'a session')} on ${when}.`,
      sessionId: p.sessionId,
      deepLink: `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        clientDisplayName: p.clientDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (b) booking_confirmed -> CLIENT, coach approved or the type confirms instantly.
  async emitConfirmed(p: BookingConfirmedPayload): Promise<BookingDeliveryOutcome> {
    const when = await this.whenFor(p.clientUserId, p.scheduledAt);
    const what = typeLabel(p.sessionTypeName, 'session');
    const body = p.instant
      ? `Your ${what} with ${p.coachDisplayName} is confirmed for ${when}.`
      : `${p.coachDisplayName} confirmed your ${what} on ${when}.`;
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
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (c) booking_declined -> CLIENT.
  async emitDeclined(p: BookingDeclinedPayload): Promise<BookingDeliveryOutcome> {
    const what = typeLabel(p.sessionTypeName, 'session');
    const when = p.scheduledAt ? await this.whenFor(p.clientUserId, p.scheduledAt) : null;
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
        sessionTypeName: p.sessionTypeName ?? null,
        declineReason: p.declineReason,
      },
    });
  }

  // (d) booking_cancelled -> the OTHER party.
  async emitCancelled(p: BookingCancelledPayload): Promise<BookingDeliveryOutcome> {
    const role = p.recipientRole ?? 'client';
    const when = await this.whenFor(p.recipientUserId, p.scheduledAt);
    const what = typeLabel(p.sessionTypeName, 'session');
    const next = role === 'client' ? ' You can book a new time in Calendar.' : '';
    return this.deliver({
      userId: p.recipientUserId,
      role,
      kind: NotificationKind.BOOKING_CANCELLED,
      title: 'Session cancelled',
      body: `${p.cancellingPartyDisplayName} cancelled the ${what} on ${when}.${next}`,
      sessionId: p.sessionId,
      deepLink: `tgp://sessions/${p.sessionId}`,
      payload: {
        cancellingPartyDisplayName: p.cancellingPartyDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        sessionTypeName: p.sessionTypeName ?? null,
        cancelReason: p.cancelReason,
      },
    });
  }

  // (e) booking_rescheduled -> the OTHER party, the move took effect.
  async emitRescheduled(p: BookingRescheduledPayload): Promise<BookingDeliveryOutcome> {
    const role = p.recipientRole ?? 'client';
    const when = await this.whenFor(p.recipientUserId, p.newScheduledAt);
    const what = typeLabel(p.sessionTypeName, 'session');
    return this.deliver({
      userId: p.recipientUserId,
      role,
      kind: NotificationKind.BOOKING_RESCHEDULED,
      title: 'Session moved',
      body: `${p.reschedulerDisplayName} moved your ${what} to ${when}.`,
      sessionId: p.sessionId,
      deepLink: `tgp://sessions/${p.sessionId}`,
      payload: {
        reschedulerDisplayName: p.reschedulerDisplayName,
        oldScheduledAt: p.oldScheduledAt.toISOString(),
        newScheduledAt: p.newScheduledAt.toISOString(),
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (e2) booking_rescheduled -> COACH, a client moved a coach-approval session;
  // it is back to awaiting approval at the new time.
  async emitMoveRequested(p: BookingMoveRequestedPayload): Promise<BookingDeliveryOutcome> {
    const when = await this.whenFor(p.coachUserId, p.newScheduledAt);
    return this.deliver({
      userId: p.coachUserId,
      role: 'coach',
      kind: NotificationKind.BOOKING_RESCHEDULED,
      title: 'Session move requested',
      body: `${p.clientDisplayName} asked to move ${typeLabel(p.sessionTypeName, 'a session')} to ${when}. Approve or decline in your booking inbox.`,
      sessionId: p.sessionId,
      deepLink: `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        clientDisplayName: p.clientDisplayName,
        oldScheduledAt: p.oldScheduledAt.toISOString(),
        newScheduledAt: p.newScheduledAt.toISOString(),
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
    const when = await this.whenFor(p.coachUserId, p.scheduledAt);
    return this.deliver({
      userId: p.coachUserId,
      role: 'coach',
      kind: NotificationKind.BOOKING_LINK_NEEDED,
      title: 'Add a call link',
      body: `Your ${typeLabel(p.sessionTypeName, 'session')} with ${p.clientDisplayName} on ${when} has no call link yet. Add one so they can join.`,
      sessionId: p.sessionId,
      deepLink: `tgp://coach/sessions/${p.sessionId}`,
      payload: {
        clientDisplayName: p.clientDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (i) booking_link_ready -> CLIENT, the coach added the call link.
  async emitLinkReady(p: BookingLinkReadyPayload): Promise<BookingDeliveryOutcome> {
    const when = await this.whenFor(p.clientUserId, p.scheduledAt);
    return this.deliver({
      userId: p.clientUserId,
      role: 'client',
      kind: NotificationKind.BOOKING_LINK_READY,
      title: 'Call link ready',
      body: `${p.coachDisplayName} added the call link for your ${typeLabel(p.sessionTypeName, 'session')} on ${when}.`,
      sessionId: p.sessionId,
      deepLink: `tgp://client/sessions/${p.sessionId}`,
      payload: {
        coachDisplayName: p.coachDisplayName,
        scheduledAt: p.scheduledAt.toISOString(),
        sessionTypeName: p.sessionTypeName ?? null,
      },
    });
  }

  // (k) booking_request_expired -> BOTH sides, once each (S-SCHED-5). Calm,
  // no blame: what happened, that the time is open again, and the next step.
  async emitRequestExpired(p: BookingRequestExpiredPayload): Promise<BookingDeliveryOutcome> {
    const when = await this.whenFor(p.recipientUserId, p.scheduledAt);
    const what = typeLabel(p.sessionTypeName, 'session');
    const body =
      p.recipientRole === 'client'
        ? `Your ${what} request for ${when} was not confirmed in time, so it has closed. Pick another time in Calendar.`
        : `${p.otherPartyDisplayName}'s ${what} request for ${when} closed without an answer, and the time is open again.`;
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
    const at = await this.timeFor(p.recipientUserId, p.scheduledAt);
    const what = typeLabel(p.sessionTypeName, 'session');
    const lead =
      kind === NotificationKind.BOOKING_REMINDER_24H
        ? `Your ${what} with ${p.otherPartyDisplayName} is tomorrow at ${at}.`
        : `Your ${what} with ${p.otherPartyDisplayName} starts at ${at}.`;
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
          `BookingEmitter ${args.kind} in-app write failed for user=${args.userId}: ${(err as Error).message}`,
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
      const result = await this.notifications.pushToUser(args.userId, args.title, body, {
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
        `BookingEmitter ${args.kind} push failed for user=${args.userId}: ${(err as Error).message}`,
      );
    }
    return outcome;
  }

  private async pushAllowed(userId: string): Promise<boolean> {
    const prefs: Record<string, unknown> = await this.notifications.getPreferences(userId);
    if (prefs.muted === true) return false;
    return prefs.booking_push !== false;
  }

  // Recipient-local wording. NotificationPreferences.timezone (default
  // America/Los_Angeles) is the per-user zone; the zone abbreviation is
  // always printed so the time is unambiguous on a lock screen.
  private async zoneFor(userId: string): Promise<string> {
    try {
      const prefs: Record<string, unknown> = await this.notifications.getPreferences(userId);
      const tz = prefs.timezone;
      if (typeof tz === 'string' && isValidZone(tz)) return tz;
    } catch (err) {
      this.logger.debug(
        `BookingEmitter zone lookup failed for user=${userId}: ${(err as Error).message}`,
      );
    }
    return 'America/Los_Angeles';
  }

  private async whenFor(userId: string, d: Date): Promise<string> {
    return formatWhen(d, await this.zoneFor(userId));
  }

  private async timeFor(userId: string, d: Date): Promise<string> {
    return formatTime(d, await this.zoneFor(userId));
  }
}

function typeLabel(name: string | null | undefined, fallback: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  return n ? n.slice(0, 60) : fallback;
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// e.g. "Mon, Oct 5, 9:00 AM PDT". The app renders the payload's ISO
// timestamp in the device zone; this is the lock-screen wording.
export function formatWhen(d: Date, tz = 'America/Los_Angeles'): string {
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
export function formatTime(d: Date, tz = 'America/Los_Angeles'): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}
