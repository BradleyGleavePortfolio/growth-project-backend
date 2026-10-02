import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';
import { PrismaService } from '../../prisma.service';
import { dayLabel, formatClock, formatDateTime } from '../local-time';
import { resolveRecipientTimeZone } from '../recipient-timezone';

// All booking emitters share the same write shape: ONE in-app inbox row for
// the target user, deep-linked to the session, with a payload limited to
// what a deep-linked screen needs (other party display name, the scheduled
// time and the zone the copy was written in). Keeping a single class so the
// invariants live in one place and SchedulingService only injects one
// emitter; preferences are still gated by NotificationsService.
//
// B-643-1:
//   - Times are written in the recipient's own zone with the zone named
//     ("tomorrow at 5:30 PM PDT"), never in UTC. With no usable stored zone
//     the copy drops the clock time (local-time.ts, recipient-timezone.ts).
//   - Each event is exactly one inbox row. The emitter used to also write a
//     `channel: 'push'` row that nothing sent to a device and the inbox
//     listed as a duplicate (two items, two unread per event).

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

  constructor(
    private readonly notifications: NotificationsService,
    // Optional so thin unit tests can build the emitter without DI; without
    // it no zone is known and copy is written without a clock time.
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  private zoneFor(userId: string, sessionId: string): Promise<string | null> {
    return resolveRecipientTimeZone(this.prisma, userId, sessionId);
  }

  // (a) booking_requested → to COACH when client creates a request.
  async emitRequested(payload: BookingRequestedPayload): Promise<void> {
    const body =
      `${payload.clientDisplayName} requested a session.`.slice(0, 160);
    await this.writeInbox({
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
    const tz = await this.zoneFor(payload.clientUserId, payload.sessionId);
    const body = (
      tz
        ? `${payload.coachDisplayName} confirmed your session on ${formatDateTime(payload.scheduledAt, tz)}.`
        : `${payload.coachDisplayName} confirmed your session. Open the session to see the time.`
    ).slice(0, 160);
    await this.writeInbox({
      userId: payload.clientUserId,
      kind: NotificationKind.BOOKING_CONFIRMED,
      body,
      deepLink: `tgp://client/sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        coachDisplayName: payload.coachDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
        timeZone: tz,
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
    await this.writeInbox({
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
    const tz = await this.zoneFor(payload.recipientUserId, payload.sessionId);
    const body = (
      tz
        ? `${payload.cancellingPartyDisplayName} cancelled the session on ${formatDateTime(payload.scheduledAt, tz)}.`
        : `${payload.cancellingPartyDisplayName} cancelled your upcoming session.`
    ).slice(0, 160);
    await this.writeInbox({
      userId: payload.recipientUserId,
      kind: NotificationKind.BOOKING_CANCELLED,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        cancellingPartyDisplayName: payload.cancellingPartyDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
        timeZone: tz,
        cancelReason: payload.cancelReason,
      },
    });
  }

  // (e) booking_rescheduled → to the OTHER PARTY when one side reschedules.
  async emitRescheduled(payload: BookingRescheduledPayload): Promise<void> {
    const tz = await this.zoneFor(payload.recipientUserId, payload.sessionId);
    const body = (
      tz
        ? `${payload.reschedulerDisplayName} moved the session to ${formatDateTime(payload.newScheduledAt, tz)}.`
        : `${payload.reschedulerDisplayName} moved your session to a new time. Open the session to see it.`
    ).slice(0, 160);
    await this.writeInbox({
      userId: payload.recipientUserId,
      kind: NotificationKind.BOOKING_RESCHEDULED,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        reschedulerDisplayName: payload.reschedulerDisplayName,
        oldScheduledAt: payload.oldScheduledAt.toISOString(),
        newScheduledAt: payload.newScheduledAt.toISOString(),
        timeZone: tz,
      },
    });
  }

  // (f) booking_reminder_24h → to a single participant, 24h before start.
  async emitReminder24h(payload: BookingReminderPayload): Promise<void> {
    const tz = await this.zoneFor(payload.recipientUserId, payload.sessionId);
    const body = (
      tz
        ? `Reminder: your session with ${payload.otherPartyDisplayName} is ${dayLabel(payload.scheduledAt, tz)} at ${formatClock(payload.scheduledAt, tz)}.`
        : `Reminder: your session with ${payload.otherPartyDisplayName} is in about 24 hours.`
    ).slice(0, 160);
    await this.writeInbox({
      userId: payload.recipientUserId,
      kind: NotificationKind.BOOKING_REMINDER_24H,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        otherPartyDisplayName: payload.otherPartyDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
        timeZone: tz,
      },
    });
  }

  // (g) booking_reminder_1h → to a single participant, 1h before start.
  async emitReminder1h(payload: BookingReminderPayload): Promise<void> {
    const tz = await this.zoneFor(payload.recipientUserId, payload.sessionId);
    const body = (
      tz
        ? `Starting soon: your session with ${payload.otherPartyDisplayName} is at ${formatClock(payload.scheduledAt, tz)}.`
        : `Starting soon: your session with ${payload.otherPartyDisplayName} starts in about an hour.`
    ).slice(0, 160);
    await this.writeInbox({
      userId: payload.recipientUserId,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      body,
      deepLink: `tgp://sessions/${payload.sessionId}`,
      payload: {
        sessionId: payload.sessionId,
        otherPartyDisplayName: payload.otherPartyDisplayName,
        scheduledAt: payload.scheduledAt.toISOString(),
        timeZone: tz,
      },
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async writeInbox(args: {
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
    } catch (err) {
      // Emitters never propagate errors — booking lifecycle must not
      // fail because the notification path hiccupped.
      this.logger.warn(
        `BookingEmitter ${args.kind} failed for user=${args.userId}: ${(err as Error).message}`,
      );
    }
  }
}
