/**
 * Unit tests for BookingEmitter (native scheduling lifecycle notifications).
 *
 * S-SCHED-2: each event writes exactly ONE in-app row (the notification
 * center entry) and sends a REAL push through
 * NotificationsService.pushToUser, gated on the recipient's booking_push /
 * muted preference. Both carry actionScreen/actionParams so a tap opens the
 * session (client: CalendarSession, coach: CoachBookingInbox). Times are in
 * the recipient's zone with the zone abbreviation.
 */
import {
  BOOKING_PUSH_SCREEN,
  BookingEmitter,
  formatTime,
  formatWhen,
} from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import type { PushDeliveryResult } from '../src/notifications/push-delivery.types';

const SCHEDULED_AT = new Date('2026-10-06T17:00:00Z'); // Tue Oct 6, 10:00 AM PDT
const NEW_SCHEDULED_AT = new Date('2026-10-07T18:30:00Z');
const REQUESTED_AT = new Date('2026-10-05T15:00:00Z');

class FakeNotifications {
  rows: CreateNotificationInput[] = [];
  pushes: Array<{ userId: string; title: string; body: string; data: Record<string, unknown> }> =
    [];
  prefs: Record<string, Record<string, unknown>> = {};
  pushResult: PushDeliveryResult = { delivered: true, code: 'delivered' };
  failInapp = false;
  failPush = false;

  createNotification = jest.fn(async (input: CreateNotificationInput) => {
    if (this.failInapp) throw new TypeError('db down');
    if (this.prefs[input.user_id]?.muted === true) return null;
    this.rows.push(input);
    return { id: `notif-${this.rows.length}` };
  });

  getPreferences = jest.fn(async (userId: string) => ({
    user_id: userId,
    timezone: 'America/Los_Angeles',
    booking_push: true,
    muted: false,
    ...(this.prefs[userId] ?? {}),
  }));

  pushToUser = jest.fn(
    async (userId: string, title: string, body: string, data?: Record<string, unknown>) => {
      if (this.failPush) throw new TypeError('expo unreachable');
      this.pushes.push({ userId, title, body, data: data ?? {} });
      return this.pushResult;
    },
  );
}

function build() {
  const fake = new FakeNotifications();
  const emitter = new BookingEmitter(
    Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
  );
  return { fake, emitter };
}

describe('BookingEmitter delivery', () => {
  it('requested -> coach: one in-app row plus a real push routed to the booking inbox', async () => {
    const { fake, emitter } = build();
    const outcome = await emitter.emitRequested({
      coachUserId: 'coach-1',
      clientDisplayName: 'Jamie',
      sessionId: 'sess-1',
      sessionTypeName: 'Quick Q/A Call',
      requestedAt: REQUESTED_AT,
      scheduledAt: SCHEDULED_AT,
      notes: null,
    });
    expect(outcome).toEqual({ inapp: 'written', push: 'delivered', notificationId: 'notif-1' });
    expect(fake.rows).toHaveLength(1);
    const [row] = fake.rows;
    expect(row).toMatchObject({
      user_id: 'coach-1',
      kind: NotificationKind.BOOKING_REQUESTED,
      channel: 'inapp',
      deep_link: 'tgp://coach/sessions/sess-1',
    });
    expect(row.body).toBe(
      'Jamie asked for Quick Q/A Call on Tue, Oct 6, 10:00 AM PDT. Approve or decline in your booking inbox.',
    );
    expect(row.payload).toMatchObject({
      sessionId: 'sess-1',
      title: 'New session request',
      recipientRole: 'coach',
      actionScreen: 'CoachBookingInbox',
      actionParams: { sessionId: 'sess-1' },
      scheduledAt: SCHEDULED_AT.toISOString(),
      sessionTypeName: 'Quick Q/A Call',
    });
    expect(fake.pushToUser).toHaveBeenCalledTimes(1);
    expect(fake.pushes[0]).toEqual({
      userId: 'coach-1',
      title: 'New session request',
      body: row.body,
      data: {
        kind: 'booking_requested',
        category: 'COACH_DIRECT',
        actionScreen: 'CoachBookingInbox',
        actionParams: { sessionId: 'sess-1' },
        notificationId: 'notif-1',
      },
    });
  });

  it('confirmed -> client routes to CalendarSession; instant wording differs from approval', async () => {
    const { fake, emitter } = build();
    await emitter.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach Kim',
      sessionId: 'sess-2',
      sessionTypeName: 'Quick initialization',
      scheduledAt: SCHEDULED_AT,
      instant: true,
    });
    await emitter.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach Kim',
      sessionId: 'sess-3',
      sessionTypeName: 'Quick Q/A Call',
      scheduledAt: SCHEDULED_AT,
    });
    expect(fake.rows.map((r) => r.body)).toEqual([
      'Your Quick initialization with Coach Kim is confirmed for Tue, Oct 6, 10:00 AM PDT.',
      'Coach Kim confirmed your Quick Q/A Call on Tue, Oct 6, 10:00 AM PDT.',
    ]);
    expect(fake.pushes.map((p) => p.data.actionScreen)).toEqual([
      'CalendarSession',
      'CalendarSession',
    ]);
  });

  it('writes the time in the recipient zone', async () => {
    const { fake, emitter } = build();
    fake.prefs['client-ny'] = { timezone: 'America/New_York' };
    await emitter.emitDeclined({
      clientUserId: 'client-ny',
      coachDisplayName: 'Coach Kim',
      sessionId: 'sess-4',
      sessionTypeName: 'Quick Q/A Call',
      requestedAt: REQUESTED_AT,
      scheduledAt: SCHEDULED_AT,
      declineReason: null,
    });
    expect(fake.rows[0].body).toBe(
      'Coach Kim could not take your Quick Q/A Call request for Tue, Oct 6, 1:00 PM EDT. Pick another time in Calendar.',
    );
  });

  it('falls back to Pacific time for an unknown zone', async () => {
    const { fake, emitter } = build();
    fake.prefs['client-x'] = { timezone: 'Mars/Olympus' };
    await emitter.emitLinkReady({
      clientUserId: 'client-x',
      coachDisplayName: 'Coach Kim',
      sessionId: 'sess-5',
      sessionTypeName: null,
      scheduledAt: SCHEDULED_AT,
    });
    expect(fake.rows[0].body).toContain('10:00 AM PDT');
    expect(fake.rows[0].body).toContain('your session');
  });

  it('respects booking_push=false: in-app row still written, no push sent', async () => {
    const { fake, emitter } = build();
    fake.prefs['coach-1'] = { booking_push: false };
    const outcome = await emitter.emitBooked({
      coachUserId: 'coach-1',
      clientDisplayName: 'Jamie',
      sessionId: 'sess-6',
      sessionTypeName: 'Quick initialization',
      scheduledAt: SCHEDULED_AT,
    });
    expect(outcome).toEqual({ inapp: 'written', push: 'disabled', notificationId: 'notif-1' });
    expect(fake.pushToUser).not.toHaveBeenCalled();
  });

  it('muted recipient: nothing written, nothing pushed', async () => {
    const { fake, emitter } = build();
    fake.prefs['client-1'] = { muted: true };
    const outcome = await emitter.emitCancelled({
      recipientUserId: 'client-1',
      recipientRole: 'client',
      cancellingPartyDisplayName: 'Coach Kim',
      sessionId: 'sess-7',
      scheduledAt: SCHEDULED_AT,
      cancelReason: null,
    });
    expect(outcome).toEqual({ inapp: 'suppressed', push: 'disabled', notificationId: null });
    expect(fake.rows).toHaveLength(0);
    expect(fake.pushToUser).not.toHaveBeenCalled();
  });

  it('reports a missing device token without throwing', async () => {
    const { fake, emitter } = build();
    fake.pushResult = { delivered: false, code: 'no-token' };
    const outcome = await emitter.emitReminder1h({
      recipientUserId: 'client-1',
      recipientRole: 'client',
      otherPartyDisplayName: 'Coach Kim',
      sessionId: 'sess-8',
      scheduledAt: SCHEDULED_AT,
      sessionTypeName: 'Quick Q/A Call',
      hasMeetingLink: true,
    });
    expect(outcome).toEqual({ inapp: 'written', push: 'no-token', notificationId: 'notif-1' });
  });

  it('never throws when storage or transport fail', async () => {
    const { fake, emitter } = build();
    fake.failInapp = true;
    fake.failPush = true;
    await expect(
      emitter.emitRescheduled({
        recipientUserId: 'coach-1',
        recipientRole: 'coach',
        reschedulerDisplayName: 'Jamie',
        sessionId: 'sess-9',
        oldScheduledAt: SCHEDULED_AT,
        newScheduledAt: NEW_SCHEDULED_AT,
      }),
    ).resolves.toEqual({ inapp: 'failed', push: 'failed', notificationId: null });
  });

  it('reminders name the other party and handle a missing call link per side', async () => {
    const { fake, emitter } = build();
    await emitter.emitReminder24h({
      recipientUserId: 'coach-1',
      recipientRole: 'coach',
      otherPartyDisplayName: 'Jamie',
      sessionId: 'sess-10',
      scheduledAt: SCHEDULED_AT,
      sessionTypeName: 'Quick Q/A Call',
      hasMeetingLink: false,
    });
    await emitter.emitReminder24h({
      recipientUserId: 'client-1',
      recipientRole: 'client',
      otherPartyDisplayName: 'Coach Kim',
      sessionId: 'sess-10',
      scheduledAt: SCHEDULED_AT,
      sessionTypeName: 'Quick Q/A Call',
      hasMeetingLink: false,
    });
    expect(fake.rows.map((r) => r.body)).toEqual([
      'Your Quick Q/A Call with Jamie is tomorrow at 10:00 AM PDT. It has no call link yet. Add one so they can join.',
      'Your Quick Q/A Call with Coach Kim is tomorrow at 10:00 AM PDT. Your coach will add the call link before it starts.',
    ]);
    expect(fake.pushes.map((p) => [p.title, p.data.actionScreen])).toEqual([
      ['Session tomorrow', 'CoachBookingInbox'],
      ['Session tomorrow', 'CalendarSession'],
    ]);
  });

  it('every message is plain (no exclamation marks) and fits 160 characters', async () => {
    const { fake, emitter } = build();
    const long = 'A'.repeat(40);
    await emitter.emitRequested({
      coachUserId: 'c',
      clientDisplayName: long,
      sessionId: 's',
      sessionTypeName: 'B'.repeat(80),
      requestedAt: REQUESTED_AT,
      scheduledAt: SCHEDULED_AT,
      notes: null,
    });
    await emitter.emitMoveRequested({
      coachUserId: 'c',
      clientDisplayName: long,
      sessionId: 's',
      oldScheduledAt: SCHEDULED_AT,
      newScheduledAt: NEW_SCHEDULED_AT,
    });
    await emitter.emitLinkNeeded({
      coachUserId: 'c',
      clientDisplayName: long,
      sessionId: 's',
      scheduledAt: SCHEDULED_AT,
    });
    for (const r of fake.rows) {
      expect(r.body.length).toBeLessThanOrEqual(160);
      expect(r.body).not.toContain('!');
    }
    expect(fake.pushes.every((p) => !p.title.includes('!'))).toBe(true);
  });

  it('exports the tap targets the mobile push router knows', () => {
    expect(BOOKING_PUSH_SCREEN).toEqual({
      client: 'CalendarSession',
      coach: 'CoachBookingInbox',
    });
    expect(formatWhen(SCHEDULED_AT)).toBe('Tue, Oct 6, 10:00 AM PDT');
    expect(formatTime(SCHEDULED_AT, 'Europe/London')).toBe('6:00 PM GMT+1');
  });
});
