/**
 * B-714-1 / B-653-1 (B-SCHED2-121): a booking push never puts a display name
 * or coach-written text on the lock screen. Every BookingEmitter method is
 * driven with canary names, a canary session type name and canary notes and
 * reasons; the push title and body must be the fixed per-kind line (a
 * reminder keeps only its time), while the in-app row keeps the full detail.
 */
import {
  BOOKING_LOCK_SCREEN,
  BookingEmitter,
  bookingLockScreenCopy,
} from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';

const NAME = 'Jamie Canary-Person';
const TYPE = 'Canary Type Name';
const NOTE = 'canary private note';
const AT = new Date('2026-10-06T17:00:00Z'); // Tue Oct 6, 10:00 AM PDT
const LATER = new Date('2026-10-07T18:30:00Z');
const CANARIES = [NAME, TYPE, NOTE, 'Jamie', 'Canary'];

function build(timeZone: string | null = 'America/Los_Angeles') {
  const rows: CreateNotificationInput[] = [];
  const pushes: Array<{ kind: unknown; title: string; body: string }> = [];
  const fake = {
    createNotification: jest.fn(async (input: CreateNotificationInput) => {
      rows.push(input);
      return { id: `n-${rows.length}` };
    }),
    getPreferences: jest.fn(async (user_id: string) => ({
      user_id,
      booking_push: true,
      muted: false,
    })),
    pushToUser: jest.fn(
      async (_u: string, title: string, body: string, data?: Record<string, unknown>) => {
        pushes.push({ kind: data?.kind, title, body });
        return { delivered: true, code: 'delivered' as const };
      },
    ),
  };
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    notificationPreferences: {
      findUnique: async () =>
        timeZone
          ? {
              timezone: timeZone,
              timezone_source: 'device',
              timezone_updated_at: new Date('2026-09-01T00:00:00Z'),
            }
          : null,
    },
    coachProfile: { findUnique: async () => null },
    coachingSession: { findUnique: async () => null },
    user: { findUnique: async () => null },
  });
  const emitter = new BookingEmitter(
    Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
    prisma,
  );
  return { emitter, rows, pushes };
}

async function emitAll(emitter: BookingEmitter): Promise<void> {
  const base = { sessionId: 's-1', sessionTypeName: TYPE };
  await emitter.emitRequested({
    ...base,
    coachUserId: 'coach',
    clientDisplayName: NAME,
    requestedAt: AT,
    scheduledAt: AT,
    notes: NOTE,
  });
  await emitter.emitBooked({
    ...base,
    coachUserId: 'coach',
    clientDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitConfirmed({
    ...base,
    clientUserId: 'client',
    coachDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitConfirmed({
    ...base,
    clientUserId: 'client',
    coachDisplayName: NAME,
    scheduledAt: AT,
    instant: true,
  });
  await emitter.emitDeclined({
    ...base,
    clientUserId: 'client',
    coachDisplayName: NAME,
    requestedAt: AT,
    scheduledAt: AT,
    declineReason: NOTE,
  });
  await emitter.emitCancelled({
    ...base,
    recipientUserId: 'client',
    recipientRole: 'client',
    cancellingPartyDisplayName: NAME,
    scheduledAt: AT,
    cancelReason: NOTE,
  });
  await emitter.emitRescheduled({
    ...base,
    recipientUserId: 'coach',
    recipientRole: 'coach',
    reschedulerDisplayName: NAME,
    oldScheduledAt: AT,
    newScheduledAt: LATER,
  });
  await emitter.emitMoveRequested({
    ...base,
    coachUserId: 'coach',
    clientDisplayName: NAME,
    oldScheduledAt: AT,
    newScheduledAt: LATER,
  });
  await emitter.emitReminder24h({
    ...base,
    recipientUserId: 'client',
    recipientRole: 'client',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitReminder1h({
    ...base,
    recipientUserId: 'coach',
    recipientRole: 'coach',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
    hasMeetingLink: false,
  });
  await emitter.emitLinkNeeded({
    ...base,
    coachUserId: 'coach',
    clientDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitLinkReady({
    ...base,
    clientUserId: 'client',
    coachDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitRequestExpired({
    ...base,
    recipientUserId: 'client',
    recipientRole: 'client',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitRequestExpired({
    ...base,
    recipientUserId: 'coach',
    recipientRole: 'coach',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
  });
}

const K = NotificationKind;
const fixed = (kind: string) => BOOKING_LOCK_SCREEN[kind];

describe('B-714-1 / B-653-1 booking pushes keep names and coach text off the lock screen', () => {
  it('every emitter pushes only its fixed per-kind line; reminders keep only the time', async () => {
    const { emitter, rows, pushes } = build();
    await emitAll(emitter);
    expect(pushes).toHaveLength(14);
    for (const p of pushes) {
      for (const c of CANARIES) expect(`${p.title} ${p.body}`).not.toContain(c);
      expect(`${p.title} ${p.body}`).not.toMatch(/!|\b(I|me|my|we|our)\b/);
    }
    expect(pushes).toEqual([
      { kind: K.BOOKING_REQUESTED, ...fixed(K.BOOKING_REQUESTED) },
      { kind: K.BOOKING_CONFIRMED, ...fixed(K.BOOKING_CONFIRMED) },
      { kind: K.BOOKING_CONFIRMED, ...fixed(K.BOOKING_CONFIRMED) },
      { kind: K.BOOKING_CONFIRMED, ...fixed(K.BOOKING_CONFIRMED) },
      { kind: K.BOOKING_DECLINED, ...fixed(K.BOOKING_DECLINED) },
      { kind: K.BOOKING_CANCELLED, ...fixed(K.BOOKING_CANCELLED) },
      { kind: K.BOOKING_RESCHEDULED, ...fixed(K.BOOKING_RESCHEDULED) },
      // B-653-4: the client's move request is not a move yet.
      {
        kind: K.BOOKING_RESCHEDULED,
        title: 'Time change requested',
        body: 'A client asked to move a session. Open the app to review.',
      },
      {
        kind: K.BOOKING_REMINDER_24H,
        title: 'Session reminder',
        body: 'Your session is on Tue, Oct 6, 10:00 AM PDT.',
      },
      {
        kind: K.BOOKING_REMINDER_1H,
        title: 'Session starting soon',
        body: 'Your session starts at 10:00 AM PDT.',
      },
      { kind: K.BOOKING_LINK_NEEDED, ...fixed(K.BOOKING_LINK_NEEDED) },
      { kind: K.BOOKING_LINK_READY, ...fixed(K.BOOKING_LINK_READY) },
      { kind: K.BOOKING_REQUEST_EXPIRED, ...fixed(K.BOOKING_REQUEST_EXPIRED) },
      { kind: K.BOOKING_REQUEST_EXPIRED, ...fixed(K.BOOKING_REQUEST_EXPIRED) },
    ]);
    // The inbox row (inside the app) keeps the full detail, unchanged.
    expect(rows).toHaveLength(14);
    expect(rows[0].body).toBe(
      `${NAME} asked for ${TYPE} on Tue, Oct 6, 10:00 AM PDT. Approve or decline in your booking inbox.`,
    );
    expect(rows[13].body).toContain(NAME);
  });

  it('with no usable zone a reminder push has no clock time and still no name', async () => {
    const { emitter, pushes } = build(null);
    await emitAll(emitter);
    const reminders = pushes.filter(
      (p) => p.kind === K.BOOKING_REMINDER_24H || p.kind === K.BOOKING_REMINDER_1H,
    );
    expect(reminders).toEqual([
      { kind: K.BOOKING_REMINDER_24H, ...fixed(K.BOOKING_REMINDER_24H) },
      { kind: K.BOOKING_REMINDER_1H, ...fixed(K.BOOKING_REMINDER_1H) },
    ]);
    for (const p of pushes) expect(`${p.title} ${p.body}`).not.toMatch(/AM|PM|UTC|\d:\d{2}/);
  });

  it('only the kind and a reminder instant are read: names, notes and bad zones never reach the copy', () => {
    const ctx = {
      scheduledAt: AT.toISOString(),
      timeZone: 'Not/AZone',
      otherPartyDisplayName: NAME,
      sessionTypeName: TYPE,
      notes: NOTE,
    };
    expect(bookingLockScreenCopy(K.BOOKING_REMINDER_24H, ctx)).toEqual(
      fixed(K.BOOKING_REMINDER_24H),
    );
    expect(bookingLockScreenCopy(K.BOOKING_CANCELLED, ctx)).toEqual(fixed(K.BOOKING_CANCELLED));
    expect(bookingLockScreenCopy('unknown_kind', ctx)).toEqual({
      title: 'The Growth Project',
      body: 'You have a new notification. Open the app to see it.',
    });
    for (const kind of Object.keys(BOOKING_LOCK_SCREEN)) {
      const c = bookingLockScreenCopy(kind, { ...ctx, timeZone: 'America/New_York' });
      for (const x of CANARIES) expect(`${c.title} ${c.body}`).not.toContain(x);
    }
  });
});

describe('B-653-4 a client move request is not shown as a moved session', () => {
  it('the coach is told a time change is requested; a real move still says moved', async () => {
    const { emitter, pushes } = build();
    await emitter.emitMoveRequested({
      coachUserId: 'coach-1',
      clientDisplayName: NAME,
      sessionId: 's-1',
      sessionTypeName: TYPE,
      oldScheduledAt: AT,
      newScheduledAt: LATER,
    });
    await emitter.emitRescheduled({
      recipientUserId: 'client-1',
      recipientRole: 'client',
      reschedulerDisplayName: NAME,
      sessionId: 's-1',
      sessionTypeName: TYPE,
      oldScheduledAt: AT,
      newScheduledAt: LATER,
    });
    expect(pushes).toEqual([
      {
        kind: K.BOOKING_RESCHEDULED,
        title: 'Time change requested',
        body: 'A client asked to move a session. Open the app to review.',
      },
      { kind: K.BOOKING_RESCHEDULED, title: 'Session moved', body: expect.any(String) },
    ]);
    for (const p of pushes) {
      for (const c of CANARIES) expect(`${p.title} ${p.body}`).not.toContain(c);
      expect(`${p.title} ${p.body}`).not.toMatch(/!|\b(I|me|my|we|our)\b/);
    }
  });
});
