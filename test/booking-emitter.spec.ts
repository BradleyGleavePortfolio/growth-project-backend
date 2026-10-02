/**
 * Unit tests for the BookingEmitter (Concierge booking lifecycle).
 *
 * Strategy mirrors test/notification-emitters.spec.ts: mock
 * NotificationsService.createNotification and assert the calls. Each
 * trigger writes exactly ONE `inapp` inbox row for the target user with
 * the documented kind, payload, and deep_link (B-643-1: the old second
 * `push` row was listed as a duplicate inbox item and never sent).
 */

import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { CreateNotificationInput } from '../src/notifications/notifications.service';

const createNotificationMock = jest.fn().mockResolvedValue({ id: 'notif-1' });

const mockNotificationsService = {
  createNotification: createNotificationMock,
} as never;

function calls(): CreateNotificationInput[] {
  return createNotificationMock.mock.calls.map(
    (c: [CreateNotificationInput]) => c[0],
  );
}

beforeEach(() => {
  createNotificationMock.mockClear();
});

const FIXED_REQUESTED_AT = new Date('2026-06-01T12:00:00Z');
const FIXED_SCHEDULED_AT = new Date('2026-06-02T15:30:00Z');
const FIXED_NEW_SCHEDULED_AT = new Date('2026-06-03T16:00:00Z');

describe('BookingEmitter', () => {
  const emitter = new BookingEmitter(mockNotificationsService);

  it('emitRequested: targets the coach with ONE booking_requested inbox row', async () => {
    await emitter.emitRequested({
      coachUserId: 'coach-1',
      clientDisplayName: 'Jamie',
      sessionId: 'sess-1',
      requestedAt: FIXED_REQUESTED_AT,
      notes: null,
    });

    const written = calls();
    expect(written.length).toBe(1);
    const [inapp] = written;
    expect(inapp.user_id).toBe('coach-1');
    expect(inapp.kind).toBe(NotificationKind.BOOKING_REQUESTED);
    expect(inapp.channel).toBe('inapp');
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
    // Two emit calls x one inbox row each.
    expect(written.length).toBe(2);
    expect(written[0].kind).toBe(NotificationKind.BOOKING_REMINDER_24H);
    expect(written[1].kind).toBe(NotificationKind.BOOKING_REMINDER_1H);
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

  it('B-643-1: no booking copy ever shows a UTC time; without a known zone it shows no clock time', async () => {
    await emitter.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach K',
      sessionId: 'sess-tz',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    await emitter.emitCancelled({
      recipientUserId: 'client-1',
      cancellingPartyDisplayName: 'Coach K',
      sessionId: 'sess-tz',
      scheduledAt: FIXED_SCHEDULED_AT,
      cancelReason: null,
    });
    await emitter.emitRescheduled({
      recipientUserId: 'client-1',
      reschedulerDisplayName: 'Coach K',
      sessionId: 'sess-tz',
      oldScheduledAt: FIXED_SCHEDULED_AT,
      newScheduledAt: FIXED_NEW_SCHEDULED_AT,
    });
    const bodies = calls().map((c) => c.body);
    expect(bodies).toEqual([
      'Coach K confirmed your session. Open the session to see the time.',
      'Coach K cancelled your upcoming session.',
      'Coach K moved your session to a new time. Open the session to see it.',
    ]);
    for (const b of bodies) expect(b).not.toMatch(/UTC|\d{2}:\d{2}/);
  });

  it('B-643-1: lifecycle copy uses the recipient\'s stored zone, with the zone named', async () => {
    const prisma = {
      notificationPreferences: {
        findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }),
      },
      coachProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      coachingSession: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const zoned = new BookingEmitter(mockNotificationsService, Object.create(prisma));
    await zoned.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach K',
      sessionId: 'sess-tz',
      scheduledAt: FIXED_SCHEDULED_AT,
    });
    await zoned.emitRescheduled({
      recipientUserId: 'client-1',
      reschedulerDisplayName: 'Coach K',
      sessionId: 'sess-tz',
      oldScheduledAt: FIXED_SCHEDULED_AT,
      newScheduledAt: FIXED_NEW_SCHEDULED_AT,
    });
    const [confirmed, moved] = calls();
    expect(confirmed.body).toBe('Coach K confirmed your session on Tue, Jun 2 at 8:30 AM PDT.');
    expect(confirmed.payload).toMatchObject({ timeZone: 'America/Los_Angeles' });
    expect(moved.body).toBe('Coach K moved the session to Wed, Jun 3 at 9:00 AM PDT.');
  });
});
