import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

// All booking emitters share the same write shape — to (in-app + push)
// for the target user, deep-link to the session, payload limited to the
// minimum a deep-linked screen needs (other party display name and the
// scheduled time the row resolved to). Keeping a single class so the
// invariants live in one place and SchedulingService only injects one
// emitter; preferences are still gated by NotificationsService.

export interface BookingRequestedPayload {
  coachUserId: string;
  clientDisplayName: string;
  sessionId: string;
  requestedAt: Date;
  notes: string | null;
}

export interface BookingConfirmedPayload {
  clientUserId: string;
  coachDisplayName: string;
  sessionId: string;
  scheduledAt: Date;
}

export interface BookingDeclinedPayload {
  clientUserId: string;
  coachDisplayName: string;
  sessionId: string;
  requestedAt: Date;
  declineReason: string | null;
}

// S-SCHED: which side of the session the recipient is on. Decides the push
// tap destination (client Calendar session vs coach booking inbox).
export type BookingRecipientRole = 'client' | 'coach';

export interface BookingCancelledPayload {
  recipientUserId: string;
  recipientRole?: BookingRecipientRole;
  cancellingPartyDisplayName: string;
  sessionId: string;
  scheduledAt: Date;
  cancelReason: string | null;
}

export interface BookingRescheduledPayload {
  recipientUserId: string;
  recipientRole?: BookingRecipientRole;
  reschedulerDisplayName: string;
  sessionId: string;
  oldScheduledAt: Date;
  newScheduledAt: Date;
}

export interface BookingReminderPayload {
  recipientUserId: string;
  recipientRole?: BookingRecipientRole;
  otherPartyDisplayName: string;
  sessionId: string;
  scheduledAt: Date;
}

@Injectable()
export class BookingEmitter {
  private readonly logger = new Logger(BookingEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  // (a) booking_requested → to COACH when client creates a request.
  async emitRequested(payload: BookingRequestedPayload): Promise<void> {
    const body =
      `${payload.clientDisplayName} requested a session.`.slice(0, 160);
    await this.writeBoth({
      userId: payload.coachUserId,
      recipientRole: 'coach',
      sessionId: payload.sessionId,
      kind: NotificationKind.BOOKING_REQUESTED,
      body,
      deepLink: `tgp://coach/sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        clientDisplayName: payload.clientDisplayName,
        requestedAt: payload.requestedAt.toISOString(),
        notes: payload.notes,
      },
    });
  }

  // (b) booking_confirmed → to CLIENT when coach approves.
  async emitConfirmed(payload: BookingConfirmedPayload): Promise<void> {
    const when = await this.whenFor(payload.clientUserId, payload.scheduledAt);
    const body =
      `${payload.coachDisplayName} confirmed your session on ${when}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.clientUserId,
      recipientRole: 'client',
      sessionId: payload.sessionId,
      kind: NotificationKind.BOOKING_CONFIRMED,
      body,
      deepLink: `tgp://client/sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        coachDisplayName: payload.coachDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
      },
    });
  }

  // (c) booking_declined → to CLIENT when coach declines.
  async emitDeclined(payload: BookingDeclinedPayload): Promise<void> {
    const body =
      `${payload.coachDisplayName} declined your session request.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.clientUserId,
      recipientRole: 'client',
      sessionId: payload.sessionId,
      kind: NotificationKind.BOOKING_DECLINED,
      body,
      deepLink: `tgp://client/sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        coachDisplayName: payload.coachDisplayName,
        requestedAt: payload.requestedAt.toISOString(),
        declineReason: payload.declineReason,
      },
    });
  }

  // (d) booking_cancelled → to the OTHER PARTY when one side cancels.
  async emitCancelled(payload: BookingCancelledPayload): Promise<void> {
    const when = await this.whenFor(payload.recipientUserId, payload.scheduledAt);
    const body =
      `${payload.cancellingPartyDisplayName} cancelled the session on ${when}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
      recipientRole: payload.recipientRole ?? 'client',
      sessionId: payload.sessionId,
      kind: NotificationKind.BOOKING_CANCELLED,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        cancellingPartyDisplayName: payload.cancellingPartyDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
        cancelReason: payload.cancelReason,
      },
    });
  }

  // (e) booking_rescheduled → to the OTHER PARTY when one side reschedules.
  async emitRescheduled(payload: BookingRescheduledPayload): Promise<void> {
    const when = await this.whenFor(payload.recipientUserId, payload.newScheduledAt);
    const body =
      `${payload.reschedulerDisplayName} moved the session to ${when}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
      recipientRole: payload.recipientRole ?? 'client',
      sessionId: payload.sessionId,
      kind: NotificationKind.BOOKING_RESCHEDULED,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        reschedulerDisplayName: payload.reschedulerDisplayName,
        oldScheduledAt: payload.oldScheduledAt.toISOString(),
        newScheduledAt: payload.newScheduledAt.toISOString(),
      },
    });
  }

  // (f) booking_reminder_24h → to a single participant, 24h before start.
  async emitReminder24h(payload: BookingReminderPayload): Promise<void> {
    const at = await this.timeFor(payload.recipientUserId, payload.scheduledAt);
    const body =
      `Reminder: session with ${payload.otherPartyDisplayName} tomorrow at ${at}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
      recipientRole: payload.recipientRole ?? 'client',
      sessionId: payload.sessionId,
      kind: NotificationKind.BOOKING_REMINDER_24H,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        otherPartyDisplayName: payload.otherPartyDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
      },
    });
  }

  // (g) booking_reminder_1h → to a single participant, 1h before start.
  async emitReminder1h(payload: BookingReminderPayload): Promise<void> {
    const at = await this.timeFor(payload.recipientUserId, payload.scheduledAt);
    const body =
      `Starting soon: session with ${payload.otherPartyDisplayName} at ${at}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
      recipientRole: payload.recipientRole ?? 'client',
      sessionId: payload.sessionId,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        otherPartyDisplayName: payload.otherPartyDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
      },
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async writeBoth(args: {
    userId: string;
    recipientRole: BookingRecipientRole;
    sessionId: string;
    kind: (typeof NotificationKind)[keyof typeof NotificationKind];
    body: string;
    deepLink: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.notifications.createNotification({
        user_id: args.userId,
        kind: args.kind,
        body: args.body,
        payload: args.payload,
        deep_link: args.deepLink,
        channel: 'inapp',
      });
      // The push-channel row is the preference + rate-limit gate: null means
      // the recipient turned booking push off, muted, or was rate-limited.
      const pushRow = await this.notifications.createNotification({
        user_id: args.userId,
        kind: args.kind,
        body: args.body,
        payload: args.payload,
        deep_link: args.deepLink,
        channel: 'push',
      });
      // S-SCHED: before this, the push row was written but nothing was ever
      // sent to the device. Deliver it through the shared Expo sender with a
      // tap target the mobile push router allow-lists.
      if (pushRow) {
        const actionScreen =
          args.recipientRole === 'coach' ? 'CoachBookingInbox' : 'CalendarSession';
        await this.notifications.pushToUser(args.userId, PUSH_TITLE[args.kind] ?? 'Session', args.body, {
          kind: args.kind,
          actionScreen,
          actionParams: { sessionId: args.sessionId },
        });
      }
    } catch (err) {
      // Emitters never propagate errors — booking lifecycle must not
      // fail because the notification path hiccupped.
      this.logger.warn(
        `BookingEmitter ${args.kind} failed for user=${args.userId}: ${(err as Error).message}`,
      );
    }
  }

  // Recipient-local wording. NotificationPreferences.timezone (default
  // America/Los_Angeles) is the per-user zone; the zone abbreviation is
  // always printed so the time is unambiguous on a lock screen.
  private async zoneFor(userId: string): Promise<string> {
    try {
      const prefs = await this.notifications.getPreferences(userId);
      const tz = (prefs as { timezone?: unknown } | null)?.timezone;
      if (typeof tz === 'string' && isValidZone(tz)) return tz;
    } catch {
      // fall through
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

const PUSH_TITLE: Record<string, string> = {
  [NotificationKind.BOOKING_REQUESTED]: 'New session request',
  [NotificationKind.BOOKING_CONFIRMED]: 'Session confirmed',
  [NotificationKind.BOOKING_DECLINED]: 'Session request declined',
  [NotificationKind.BOOKING_CANCELLED]: 'Session cancelled',
  [NotificationKind.BOOKING_RESCHEDULED]: 'Session moved',
  [NotificationKind.BOOKING_REMINDER_24H]: 'Session tomorrow',
  [NotificationKind.BOOKING_REMINDER_1H]: 'Session starting soon',
};

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// e.g. "Mon, Oct 5, 9:00 AM PDT". The mobile renders the payload's ISO
// timestamp in the device zone; this body is the lock-screen wording.
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
