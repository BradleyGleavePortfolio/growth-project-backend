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

export interface BookingCancelledPayload {
  recipientUserId: string;
  cancellingPartyDisplayName: string;
  sessionId: string;
  scheduledAt: Date;
  cancelReason: string | null;
}

export interface BookingRescheduledPayload {
  recipientUserId: string;
  reschedulerDisplayName: string;
  sessionId: string;
  oldScheduledAt: Date;
  newScheduledAt: Date;
}

export interface BookingReminderPayload {
  recipientUserId: string;
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
    const body =
      `${payload.coachDisplayName} confirmed your session on ${formatWhen(payload.scheduledAt)}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.clientUserId,
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
    const body =
      `${payload.cancellingPartyDisplayName} cancelled the session on ${formatWhen(payload.scheduledAt)}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
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
    const body =
      `${payload.reschedulerDisplayName} moved the session to ${formatWhen(payload.newScheduledAt)}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
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
    const body =
      `Reminder: session with ${payload.otherPartyDisplayName} tomorrow at ${formatTime(payload.scheduledAt)}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
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
    const body =
      `Starting soon: session with ${payload.otherPartyDisplayName} at ${formatTime(payload.scheduledAt)}.`.slice(
        0,
        160,
      );
    await this.writeBoth({
      userId: payload.recipientUserId,
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
      await this.notifications.createNotification({
        user_id: args.userId,
        kind: args.kind,
        body: args.body,
        payload: args.payload,
        deep_link: args.deepLink,
        channel: 'push',
      });
    } catch (err) {
      // Emitters never propagate errors — booking lifecycle must not
      // fail because the notification path hiccupped.
      this.logger.warn(
        `BookingEmitter ${args.kind} failed for user=${args.userId}: ${(err as Error).message}`,
      );
    }
  }
}

// Locale-neutral, no Intl deps in the hot path. The mobile renders the
// payload's ISO timestamp in the user's tz; the body string is a coarse
// fallback for push lock-screens.
function formatWhen(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
