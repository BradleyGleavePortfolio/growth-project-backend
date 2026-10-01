/**
 * Unit tests for the BookingEmitter (Concierge booking lifecycle).
 *
 * Strategy mirrors test/notification-emitters.spec.ts: mock
 * NotificationsService.createNotification and assert the calls. Each
 * trigger writes one `inapp` row and one `push` row for the target
 * user with the documented kind, payload, and deep_link.
 */

import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { CreateNotificationInput } from '../src/notifications/notifications.service';

const createNotificationMock = jest.fn().mockResolvedValue({ id: 'notif-1' });

const pushToUserMock = jest.fn().mockResolvedValue({ delivered: true });
const getPreferencesMock = jest.fn().mockResolvedValue({ timezone: 'America/New_York' });

const mockNotificationsService = {
  createNotification: createNotificationMock,
  pushToUser: pushToUserMock,
  getPreferences: getPreferencesMock,
} as never;

function calls(): CreateNotificationInput[] {
  return createNotificationMock.mock.calls.map(
    (c: [CreateNotificationInput]) => c[0],
  );
}

beforeEach(() => {
  createNotificationMock.mockClear();
  createNotificationMock.mockResolvedValue({ id: 'notif-1' });
  pushToUserMock.mockClear();
  getPreferencesMock.mockClear();
  getPreferencesMock.mockResolvedValue({ timezone: 'America/New_York' });
});

const FIXED_REQUESTED_AT = new Date('2026-06-01T12:00:00Z');
const FIXED_SCHEDULED_AT = new Date('2026-06-02T15:30:00Z');
const FIXED_NEW_SCHEDULED_AT = new Date('2026-06-03T16:00:00Z');

describe('BookingEmitter', () => {
  const emitter = new BookingEmitter(mockNotificationsService);

  it('emitRequested: targets the coach with booking_requested on inapp + push', async () => {
    await emitter.emitRequested({
      coachUserId: 'coach-1',
      clientDisplayName: 'Jamie',
      sessionId: 'sess-1',
      requestedAt: FIXED_REQUESTED_AT,
      notes: null,
    });

    const written = calls();
    expect(written.length).toBe(2);
    const [inapp, push] = written;
    expect(inapp.user_id).toBe('coach-1');
    expect(inapp.kind).toBe(NotificationKind.BOOKING_REQUESTED);
    expect(inapp.channel).toBe('inapp');
    expect(push.channel).toBe('push');
    expect(inapp.deep_link).toBe('tgp://coach/sessions/sess-1');
    expect(inapp.body).toContain('Jamie');
    expect(inapp.body.length).toBeLessThanOrEqual(160);
    expect(inapp.payload).toMatchObject({
      sessionId: 'sess-1',
      clientDisplayName: 'Jamie',
      requestedAt: FIXED_REQUESTED_AT.toISOString(),
    });
  });

  it('emitConfirmed: targets the client with booking_confirmed; payload carries scheduledAt', async () => {
    await emitter.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach K',
      sessionId: 'sess-2',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    const [inapp] = calls();
    expect(inapp.user_id).toBe('client-1');
    expect(inapp.kind).toBe(NotificationKind.BOOKING_CONFIRMED);
    expect(inapp.deep_link).toBe('tgp://client/sessions/sess-2');
    expect(inapp.body).toContain('Coach K');
    expect(inapp.payload).toMatchObject({
      sessionId: 'sess-2',
      scheduledAt: FIXED_SCHEDULED_AT.toISOString(),
    });
  });

  it('emitDeclined: targets the client with booking_declined; passes reason through payload', async () => {
    await emitter.emitDeclined({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach K',
      sessionId: 'sess-3',
      requestedAt: FIXED_REQUESTED_AT,
      declineReason: 'out that week',
    });
    const [inapp] = calls();
    expect(inapp.kind).toBe(NotificationKind.BOOKING_DECLINED);
    expect(inapp.payload).toMatchObject({
      declineReason: 'out that week',
    });
  });

  it('emitCancelled: targets the OTHER party; payload identifies cancelling party', async () => {
    await emitter.emitCancelled({
      recipientUserId: 'coach-1',
      cancellingPartyDisplayName: 'Jamie',
      sessionId: 'sess-4',
      scheduledAt: FIXED_SCHEDULED_AT,
      cancelReason: null,
    });
    const [inapp] = calls();
    expect(inapp.user_id).toBe('coach-1');
    expect(inapp.kind).toBe(NotificationKind.BOOKING_CANCELLED);
    expect(inapp.payload).toMatchObject({
      cancellingPartyDisplayName: 'Jamie',
      sessionId: 'sess-4',
    });
  });

  it('emitRescheduled: payload carries both old and new scheduledAt', async () => {
    await emitter.emitRescheduled({
      recipientUserId: 'client-1',
      reschedulerDisplayName: 'Coach K',
      sessionId: 'sess-5',
      oldScheduledAt: FIXED_SCHEDULED_AT,
      newScheduledAt: FIXED_NEW_SCHEDULED_AT,
    });
    const [inapp] = calls();
    expect(inapp.kind).toBe(NotificationKind.BOOKING_RESCHEDULED);
    expect(inapp.payload).toMatchObject({
      oldScheduledAt: FIXED_SCHEDULED_AT.toISOString(),
      newScheduledAt: FIXED_NEW_SCHEDULED_AT.toISOString(),
    });
  });

  it('emitReminder24h + emitReminder1h: use distinct kinds with the same deep-link pattern', async () => {
    await emitter.emitReminder24h({
      recipientUserId: 'client-1',
      otherPartyDisplayName: 'Coach K',
      sessionId: 'sess-6',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    await emitter.emitReminder1h({
      recipientUserId: 'client-1',
      otherPartyDisplayName: 'Coach K',
      sessionId: 'sess-6',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    const written = calls();
    // Two emit calls × (inapp + push) = 4 rows total.
    expect(written.length).toBe(4);
    expect(written[0].kind).toBe(NotificationKind.BOOKING_REMINDER_24H);
    expect(written[2].kind).toBe(NotificationKind.BOOKING_REMINDER_1H);
    for (const w of written) {
      expect(w.deep_link).toBe('tgp://sessions/sess-6');
      expect(w.body.length).toBeLessThanOrEqual(160);
    }
  });

  it('swallows underlying createNotification errors so lifecycle never blocks', async () => {
    createNotificationMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      emitter.emitRequested({
        coachUserId: 'coach-1',
        clientDisplayName: 'Jamie',
        sessionId: 'sess-x',
        requestedAt: FIXED_REQUESTED_AT,
        notes: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('body strings never contain emoji or exclamation marks (house style)', async () => {
    await emitter.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach K',
      sessionId: 'sess-style',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    const [inapp] = calls();
    expect(inapp.body).not.toMatch(/!/);
    // eslint-disable-next-line no-control-regex
    expect(inapp.body).not.toMatch(/[\u{1F300}-\u{1FFFF}]/u);
  });
});

describe('BookingEmitter push delivery (S-SCHED)', () => {
  const emitter = new BookingEmitter(mockNotificationsService);

  it('sends a real push to the client with the Calendar session tap target', async () => {
    await emitter.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach K',
      sessionId: 'sess-2',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    expect(pushToUserMock).toHaveBeenCalledTimes(1);
    const [userId, title, body, data] = pushToUserMock.mock.calls[0];
    expect(userId).toBe('client-1');
    expect(title).toBe('Session confirmed');
    expect(body).toContain('Coach K');
    expect(data).toEqual({
      kind: NotificationKind.BOOKING_CONFIRMED,
      actionScreen: 'CalendarSession',
      actionParams: { sessionId: 'sess-2' },
    });
  });

  it('routes coach recipients to the booking inbox', async () => {
    await emitter.emitRequested({
      coachUserId: 'coach-1',
      clientDisplayName: 'Jamie',
      sessionId: 'sess-1',
      requestedAt: FIXED_REQUESTED_AT,
      notes: null,
    });
    expect(pushToUserMock.mock.calls[0][3]).toMatchObject({ actionScreen: 'CoachBookingInbox' });
    await emitter.emitCancelled({
      recipientUserId: 'coach-1',
      recipientRole: 'coach',
      cancellingPartyDisplayName: 'Jamie',
      sessionId: 'sess-1',
      scheduledAt: FIXED_SCHEDULED_AT,
      cancelReason: null,
    });
    expect(pushToUserMock.mock.calls[1][3]).toMatchObject({ actionScreen: 'CoachBookingInbox' });
  });

  it('does not push when the push row was suppressed by preferences', async () => {
    createNotificationMock.mockResolvedValueOnce({ id: 'inapp' }).mockResolvedValueOnce(null);
    await emitter.emitReminder1h({
      recipientUserId: 'client-1',
      recipientRole: 'client',
      otherPartyDisplayName: 'Coach K',
      sessionId: 'sess-6',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    expect(pushToUserMock).not.toHaveBeenCalled();
  });

  it('writes times in the recipient zone with its abbreviation, not UTC', async () => {
    await emitter.emitReminder24h({
      recipientUserId: 'client-1',
      recipientRole: 'client',
      otherPartyDisplayName: 'Coach K',
      sessionId: 'sess-6',
      scheduledAt: FIXED_SCHEDULED_AT, // 15:30Z = 11:30 AM EDT
    });
    const body = calls()[0].body;
    expect(body).toMatch(/11:30\s?AM EDT/);
    expect(body).not.toContain('UTC');
    expect(body).not.toMatch(/!/);
  });

  it('a push failure never throws into the booking lifecycle', async () => {
    pushToUserMock.mockRejectedValueOnce(new Error('expo down'));
    await expect(
      emitter.emitDeclined({
        clientUserId: 'client-1',
        coachDisplayName: 'Coach K',
        sessionId: 'sess-3',
        requestedAt: FIXED_REQUESTED_AT,
        declineReason: null,
      }),
    ).resolves.toBeUndefined();
  });
});
