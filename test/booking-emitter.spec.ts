/**
 * Unit tests for BookingEmitter (native scheduling lifecycle notifications).
 *
 * S-SCHED-2: each event writes exactly ONE in-app row (the notification
 * center entry) and sends a REAL push through
 * NotificationsService.pushToUser, gated on the recipient's booking_push /
 * muted preference. Both carry actionScreen/actionParams so a tap opens the
 * session (client: CalendarSession, coach: CoachBookingInbox). Times are in
 * the recipient's zone with the zone abbreviation; the zone comes from
 * recipient-timezone.ts (B-643-1 / B-647 zone provenance), and with no usable
 * zone the copy has no clock time.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import { PrismaService } from '../src/prisma.service';

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

  // Zone provenance (B-647-1 / B-647-2): the emitter reads the recipient's
  // zone through recipient-timezone.ts. This answers it from `prefs` as a
  // zone the person supplied (timezone_updated_at stamped); default Los
  // Angeles. No coach profile zones, so an unusable zone means no zone.
  zoneReads = jest.fn(async (args: { where: { user_id: string } }) => ({
    timezone: this.prefs[args.where.user_id]?.timezone ?? 'America/Los_Angeles',
    timezone_updated_at: new Date('2026-09-01T00:00:00Z'),
  }));
}

function zonePrisma(fake: FakeNotifications): PrismaService {
  return Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    notificationPreferences: { findUnique: fake.zoneReads },
    coachProfile: { findUnique: async () => null },
    coachingSession: { findUnique: async () => null },
    user: { findUnique: async () => null },
  });
}

function build() {
  const fake = new FakeNotifications();
  const emitter = new BookingEmitter(
    Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
    zonePrisma(fake),
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

  it('an unusable zone writes no clock time (never a silent Pacific default, B-643-1)', async () => {
    const { fake, emitter } = build();
    fake.prefs['client-x'] = { timezone: 'Mars/Olympus' };
    await emitter.emitLinkReady({
      clientUserId: 'client-x',
      coachDisplayName: 'Coach Kim',
      sessionId: 'sess-5',
      sessionTypeName: null,
      scheduledAt: SCHEDULED_AT,
    });
    expect(fake.rows[0].body).toBe('Coach Kim added the call link for your upcoming session.');
    expect(fake.rows[0].payload).toMatchObject({ timeZone: null });
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
      'Your Quick Q/A Call with Jamie is on Tue, Oct 6, 10:00 AM PDT. It has no call link yet. Add one so they can join.',
      'Your Quick Q/A Call with Coach Kim is on Tue, Oct 6, 10:00 AM PDT. Your coach will add the call link before it starts.',
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
    expect(formatWhen(SCHEDULED_AT, 'America/Los_Angeles')).toBe('Tue, Oct 6, 10:00 AM PDT');
    expect(formatTime(SCHEDULED_AT, 'Europe/London')).toBe('6:00 PM GMT+1');
  });
});

// B-634-8 (Sol @ bb6f3ea8): booking bodies and payloads carry display names
// and private request/decline/cancel notes. An ORM error at any of the three
// emitter catch sites can echo those query arguments; none of it may reach a
// logger argument. Delivery stays nonthrowing and channel-aware.
describe('B-634-8: emitter logs never carry raw ORM diagnostics', () => {
  const CANARY = 'PRIVATE-CANARY-note-Jamie-knee-pain-7f3a';
  const LOG_METHODS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
  let spies: jest.SpyInstance[] = [];

  function ormError(): Prisma.PrismaClientKnownRequestError {
    const err = new Prisma.PrismaClientKnownRequestError(
      `Timed out fetching a new connection. Query: INSERT ... body = "${CANARY}"`,
      { code: 'P2024', clientVersion: 'test', meta: { target: CANARY } },
    );
    err.stack = `PrismaClientKnownRequestError: ${CANARY}\n    at query (${CANARY})`;
    return err;
  }

  function loggedText(): string {
    return JSON.stringify(spies.flatMap((s) => s.mock.calls));
  }

  beforeEach(() => {
    spies = LOG_METHODS.map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  const requested = {
    coachUserId: 'coach-1',
    clientDisplayName: 'Jamie',
    sessionId: 'sess-1',
    sessionTypeName: 'Quick Q/A Call',
    requestedAt: REQUESTED_AT,
    scheduledAt: SCHEDULED_AT,
    notes: CANARY,
  };

  it('in-app creation P2024: canary never logged; push still delivered without a notificationId', async () => {
    const { fake, emitter } = build();
    fake.createNotification.mockImplementationOnce(async () => {
      throw ormError();
    });
    const outcome = await emitter.emitRequested(requested);
    expect(outcome).toEqual({ inapp: 'failed', push: 'delivered', notificationId: null });
    expect(fake.pushes[0].data).not.toHaveProperty('notificationId');
    const text = loggedText();
    expect(text).toContain('booking_requested in-app write failed for user=coach-1');
    expect(text).toContain('Database request failed (P2024)');
    expect(text).not.toContain(CANARY);
  });

  it('push-preference lookup P2024: canary never logged; in-app row kept, push reported failed', async () => {
    const { fake, emitter } = build();
    // The zone comes from recipient-timezone.ts; the only preference read is
    // the push gate.
    fake.getPreferences.mockImplementationOnce(async () => {
      throw ormError();
    });
    const outcome = await emitter.emitRequested(requested);
    expect(outcome).toEqual({ inapp: 'written', push: 'failed', notificationId: 'notif-1' });
    expect(fake.pushToUser).not.toHaveBeenCalled();
    const text = loggedText();
    expect(text).toContain('booking_requested push failed for user=coach-1');
    expect(text).toContain('Database request failed (P2024)');
    expect(text).not.toContain(CANARY);
  });

  it('zone lookup P2024: canary never logged; copy without a clock time, both channels delivered', async () => {
    const { fake, emitter } = build();
    fake.zoneReads.mockImplementationOnce(async () => {
      throw ormError();
    });
    const outcome = await emitter.emitRequested(requested);
    expect(outcome).toEqual({ inapp: 'written', push: 'delivered', notificationId: 'notif-1' });
    expect(fake.rows[0].body).not.toMatch(/AM|PM|\d:\d{2}/);
    const text = loggedText();
    // recipient-timezone.ts logs the error class only.
    expect(text).toContain('time zone lookup failed for user=coach-1');
    expect(text).toContain('PrismaClientKnownRequestError');
    expect(text).not.toContain(CANARY);
  });

  it('an ORM error wrapped as a cause, and a non-ORM error, never log their message', async () => {
    const { fake, emitter } = build();
    const wrapped = Object.assign(new Error(`notification write failed: ${CANARY}`), {
      cause: ormError(),
    });
    fake.createNotification.mockImplementationOnce(async () => {
      throw wrapped;
    });
    const plain = Object.assign(new TypeError(`bad payload ${CANARY}`), { code: 'ERR_X' });
    fake.pushToUser.mockImplementationOnce(async () => {
      throw plain;
    });
    const outcome = await emitter.emitRequested(requested);
    expect(outcome).toEqual({ inapp: 'failed', push: 'failed', notificationId: null });
    const text = loggedText();
    expect(text).toContain('Database request failed (P2024)');
    // B-634-10: ERR_X is not in the reviewed code catalog, so it is dropped.
    expect(text).toContain('push failed for user=coach-1: TypeError');
    expect(text).not.toContain('ERR_X');
    expect(text).not.toContain(CANARY);
  });
});

// B-634-10 (Sol @ 9e6c62c9): identifier-shaped names and codes are still
// arbitrary data. At the real emitter logger boundary only closed-enum class
// names and catalogued codes may appear; unknown names log as OtherError.
describe('B-634-10: emitter logs carry only closed-enum error classes and codes', () => {
  const NAME_CANARY = 'SYNTHETIC_PRIVATE_CANARY_123';
  const CODE_CANARY = 'SYNTHETIC_PRIVATE_CODE_456';
  const LOG_METHODS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
  let spies: jest.SpyInstance[] = [];
  beforeEach(() => {
    spies = LOG_METHODS.map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });
  function loggedText(): string {
    return JSON.stringify(spies.flatMap((s) => s.mock.calls));
  }
  function canaryError(): Error {
    const err = Object.assign(new Error('provider text'), { code: CODE_CANARY });
    err.name = NAME_CANARY;
    return err;
  }
  const requested = {
    coachUserId: 'coach-1',
    clientDisplayName: 'Jamie',
    sessionId: 'sess-1',
    sessionTypeName: 'Quick Q/A Call',
    requestedAt: REQUESTED_AT,
    scheduledAt: SCHEDULED_AT,
    notes: null,
  };

  it('in-app write: unknown name and code log as OtherError; push still delivered', async () => {
    const { fake, emitter } = build();
    fake.createNotification.mockImplementationOnce(async () => {
      throw canaryError();
    });
    const outcome = await emitter.emitRequested(requested);
    expect(outcome).toEqual({ inapp: 'failed', push: 'delivered', notificationId: null });
    const text = loggedText();
    expect(text).toContain('booking_requested in-app write failed for user=coach-1: OtherError');
    expect(text).not.toContain(NAME_CANARY);
    expect(text).not.toContain(CODE_CANARY);
  });

  it('push: a known class with an unknown code logs the class only', async () => {
    const { fake, emitter } = build();
    fake.pushToUser.mockImplementationOnce(async () => {
      throw Object.assign(new TypeError('x'), { code: CODE_CANARY });
    });
    const outcome = await emitter.emitRequested(requested);
    expect(outcome).toEqual({ inapp: 'written', push: 'failed', notificationId: 'notif-1' });
    const text = loggedText();
    expect(text).toMatch(/push failed for user=coach-1: TypeError"/);
    expect(text).not.toContain(CODE_CANARY);
  });

  it('zone lookup: a wrapped canary cause and a non-Error throw never surface', async () => {
    const { fake, emitter } = build();
    fake.zoneReads.mockImplementationOnce(async () => {
      throw Object.assign(new Error('outer'), { cause: canaryError() });
    });
    fake.pushToUser.mockImplementationOnce(async () => {
      throw { name: NAME_CANARY, code: CODE_CANARY };
    });
    const outcome = await emitter.emitRequested(requested);
    expect(outcome).toEqual({ inapp: 'written', push: 'failed', notificationId: 'notif-1' });
    const text = loggedText();
    expect(text).toContain(
      'time zone lookup failed for user=coach-1; writing copy without a clock time: Error',
    );
    expect(text).toContain('push failed for user=coach-1: OtherError');
    expect(text).not.toContain(NAME_CANARY);
    expect(text).not.toContain(CODE_CANARY);
  });

  it('a catalogued transport code on a cause is kept for operators', async () => {
    const { fake, emitter } = build();
    fake.pushToUser.mockImplementationOnce(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
      });
    });
    await emitter.emitRequested(requested);
    expect(loggedText()).toContain('push failed for user=coach-1: TypeError (ECONNRESET)');
  });
});

// Main merge (B-643-1, B-647-1 / B-647-2 zone provenance, C-647-3): the zone
// comes from recipient-timezone.ts. With no usable zone no booking copy shows
// a clock time; an unstamped preference row (the schema default zone) is not
// the person's zone; every payload names the zone its copy was written in.
describe('BookingEmitter zone provenance (main merge)', () => {
  function emitterWith(zones: {
    prefs?: { timezone: string; timezone_updated_at: Date | null } | null;
    coachProfiles?: Record<string, string>;
    sessionCoach?: string | null;
  }) {
    const fake = new FakeNotifications();
    const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
      notificationPreferences: { findUnique: async () => zones.prefs ?? null },
      coachProfile: {
        findUnique: async (args: { where: { user_id: string } }) => {
          const tz = zones.coachProfiles?.[args.where.user_id];
          return tz ? { timezone: tz } : null;
        },
      },
      coachingSession: {
        findUnique: async () => (zones.sessionCoach ? { coach_id: zones.sessionCoach } : null),
      },
      user: { findUnique: async () => null },
    });
    const emitter = new BookingEmitter(
      Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
      prisma,
    );
    return { fake, emitter };
  }

  it('no usable zone: every body drops the clock time and never shows UTC', async () => {
    const { fake, emitter } = emitterWith({});
    await emitter.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach Kim',
      sessionId: 'sess-tz',
      scheduledAt: SCHEDULED_AT,
    });
    await emitter.emitCancelled({
      recipientUserId: 'client-1',
      cancellingPartyDisplayName: 'Coach Kim',
      sessionId: 'sess-tz',
      scheduledAt: SCHEDULED_AT,
      cancelReason: null,
    });
    await emitter.emitRescheduled({
      recipientUserId: 'client-1',
      reschedulerDisplayName: 'Coach Kim',
      sessionId: 'sess-tz',
      oldScheduledAt: SCHEDULED_AT,
      newScheduledAt: NEW_SCHEDULED_AT,
    });
    await emitter.emitReminder24h({
      recipientUserId: 'client-1',
      otherPartyDisplayName: 'Coach Kim',
      sessionId: 'sess-tz',
      scheduledAt: SCHEDULED_AT,
    });
    await emitter.emitReminder1h({
      recipientUserId: 'client-1',
      otherPartyDisplayName: 'Coach Kim',
      sessionId: 'sess-tz',
      scheduledAt: SCHEDULED_AT,
    });
    const bodies = fake.rows.map((r) => r.body);
    expect(bodies).toEqual([
      'Coach Kim confirmed your session. Open the session to see the time.',
      'Coach Kim cancelled your upcoming session. You can book a new time in Calendar.',
      'Coach Kim moved your session to a new time. Open the session to see it.',
      'Your session with Coach Kim is in about 24 hours.',
      'Your session with Coach Kim starts in about an hour.',
    ]);
    for (const b of bodies) expect(b).not.toMatch(/UTC|AM|PM|\d:\d{2}/);
    expect(fake.pushes.map((p) => p.body)).toEqual(bodies);
    for (const r of fake.rows) expect(r.payload).toMatchObject({ timeZone: null });
  });

  it('an unstamped preference row is not the person zone: the booking coach zone is used', async () => {
    const { fake, emitter } = emitterWith({
      prefs: { timezone: 'America/Los_Angeles', timezone_updated_at: null },
      coachProfiles: { 'coach-9': 'America/New_York' },
      sessionCoach: 'coach-9',
    });
    await emitter.emitReminder24h({
      recipientUserId: 'client-1',
      otherPartyDisplayName: 'Coach Kim',
      sessionId: 'sess-tz',
      scheduledAt: SCHEDULED_AT,
    });
    // C-647-3: the stored 24h body names the date, not "tomorrow".
    expect(fake.rows[0].body).toBe('Your session with Coach Kim is on Tue, Oct 6, 1:00 PM EDT.');
    expect(fake.rows[0].payload).toMatchObject({ timeZone: 'America/New_York' });
  });
});
