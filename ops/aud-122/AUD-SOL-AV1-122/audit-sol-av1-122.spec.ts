/**
 * S-AVAIL-122: coach booking options (minimum notice, booking window,
 * buffers, optional daily maximum).
 *
 * Drives the real SchedulingService / lifecycle / open-slots services over the
 * in-memory Prisma double (test/utils/scheduling-fake-db.ts, per-coach lock +
 * no-overlap constraint). For each option: the booking path enforces it and
 * open slots reflect it. The defaults reproduce the fixed rules that applied
 * before (5 minutes, 120 days, no buffers, no cap).
 */
import { HttpException } from '@nestjs/common';
import { AuditService } from '../src/audit/audit.service';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { ActorContext } from '../src/scheduling/scheduling.types';
import { SchedulingFakeDb, asPrisma } from './utils/scheduling-fake-db';
import { QUEUED } from './utils/booking-push-fake';

// Monday 2026-10-05 08:00 PDT (coach zone America/Los_Angeles, UTC-7).
const NOW = new Date('2026-10-05T15:00:00.000Z');
const COACH: ActorContext = { id: 'coach-1', role: 'coach', email: null, coach_id: null };
const CLIENT: ActorContext = { id: 'client-1', role: 'student', email: null, coach_id: 'coach-1' };
const CLIENT_2: ActorContext = {
  id: 'client-2',
  role: 'student',
  email: null,
  coach_id: 'coach-1',
};

/** Coach-local wall time on 2026-10-DD (PDT) as an ISO instant. */
function local(day: number, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h + 7, m)).toISOString();
}
function plus(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function harness() {
  const db = new SchedulingFakeDb();
  db.addUser({ id: 'coach-1', name: 'Coach Kim', role: 'coach' });
  db.addUser({ id: 'client-1', name: 'Client One', role: 'student', coach_id: 'coach-1' });
  db.addUser({ id: 'client-2', name: 'Client Two', role: 'student', coach_id: 'coach-1' });
  db.addSessionType({
    id: 'st-open',
    coach_id: 'coach-1',
    name: 'Open call',
    duration_minutes: 30,
    auto_approve: true,
  });
  for (let day = 0; day <= 6; day++) db.addWindow('coach-1', day, 9 * 60, 17 * 60);
  const notifications = {
    createNotification: jest.fn(async () => ({ id: 'n' })),
    getPreferences: jest.fn(async (userId: string) => ({
      user_id: userId,
      timezone: 'America/Los_Angeles',
      booking_push: true,
      booking_inapp: true,
      muted: false,
    })),
    sendPush: jest.fn(async () => QUEUED),
  };
  const emitter = new BookingEmitter(
    Object.assign(
      Object.create(NotificationsService.prototype) as NotificationsService,
      notifications,
    ),
    asPrisma(db),
  );
  const audit = Object.assign(Object.create(AuditService.prototype) as AuditService, {
    write: jest.fn(async () => undefined),
  });
  const providers = new SchedulingProviderRegistry(
    new StubCalendarAdapter(),
    new GoogleCalendarAdapter(),
    new StubVideoAdapter(),
    new GoogleMeetAdapter(),
    new ZoomVideoAdapter(),
  );
  const svc = new SchedulingService(asPrisma(db), audit, providers, emitter);
  return { db, svc };
}

function book(svc: SchedulingService, actor: ActorContext, start: string) {
  return svc.requestSession(actor, {
    coach_id: 'coach-1',
    session_type_id: 'st-open',
    title: 'Session',
    start_at: start,
    end_at: plus(start, 30),
  });
}

async function slotStarts(svc: SchedulingService, from: string, to: string): Promise<string[]> {
  const payload = await svc.getOpenSlots(CLIENT, 'coach-1', {
    from,
    to,
    session_type_id: 'st-open',
  });
  return payload.slots.map((s) => s.start_at);
}

async function failure(
  p: Promise<unknown>,
): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) {
      const res = err.getResponse();
      const body: Record<string, unknown> =
        typeof res === 'object' && res !== null ? { ...res } : {};
      return { status: err.getStatus(), code: String(body.code), message: String(body.message) };
    }
    throw err;
  }
  throw new TypeError('expected the call to fail');
}

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(NOW);
});
afterAll(() => {
  jest.useRealTimers();
});

describe('coach booking options endpoints (GET/PATCH /scheduling/coach/booking-options)', () => {
  it('a coach who never edited them reads the defaults (today rules)', async () => {
    const { svc } = harness();
    const view = await svc.getMyBookingOptions(COACH);
    expect(view).toMatchObject({
      coach_id: 'coach-1',
      min_notice_minutes: 5,
      booking_window_days: 120,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      daily_max_sessions: null,
    });
    expect(view.defaults).toEqual({
      min_notice_minutes: 5,
      booking_window_days: 120,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      daily_max_sessions: null,
    });
  });

  it('saves a partial edit, keeps the other values, and null removes the daily cap', async () => {
    const { svc } = harness();
    await svc.updateMyBookingOptions(COACH, { min_notice_minutes: 120, daily_max_sessions: 4 });
    let view = await svc.getMyBookingOptions(COACH);
    expect(view).toMatchObject({
      min_notice_minutes: 120,
      booking_window_days: 120,
      daily_max_sessions: 4,
    });
    view = await svc.updateMyBookingOptions(COACH, { daily_max_sessions: null });
    expect(view).toMatchObject({ min_notice_minutes: 120, daily_max_sessions: null });
  });

  it.each([
    [{ min_notice_minutes: 2 }, /Minimum notice/],
    [{ booking_window_days: 400 }, /How far ahead/],
    [{ buffer_after_minutes: -5 }, /Buffer after/],
    [{ daily_max_sessions: 0 }, /Daily maximum/],
    [{ min_notice_minutes: 2880, booking_window_days: 2 }, /must be shorter than/],
  ])('refuses %j with INVALID_BOOKING_OPTIONS naming the field', async (patch, message) => {
    const { svc } = harness();
    const f = await failure(svc.updateMyBookingOptions(COACH, patch));
    expect(f).toMatchObject({ status: 400, code: 'INVALID_BOOKING_OPTIONS' });
    expect(f.message).toMatch(message);
  });

  it('is coach-only: a client cannot read or change them', async () => {
    const { svc } = harness();
    expect((await failure(svc.getMyBookingOptions(CLIENT))).status).toBe(403);
    expect(
      (await failure(svc.updateMyBookingOptions(CLIENT, { min_notice_minutes: 60 }))).status,
    ).toBe(403);
  });
});

describe('defaults reproduce the old fixed rules', () => {
  it('open slots start 5 minutes from now and carry the default rules', async () => {
    const { svc } = harness();
    const payload = await svc.getOpenSlots(CLIENT, 'coach-1', {
      from: local(5, '00:00'),
      to: local(6, '00:00'),
      session_type_id: 'st-open',
    });
    expect(payload).toMatchObject({ min_notice_minutes: 5, booking_window_days: 120 });
    // Monday 09:00-17:00 local, 30-minute slots, all after now + 5 minutes.
    expect(payload.slots).toHaveLength(16);
    expect(payload.slots[0].start_at).toBe(local(5, '09:00'));
  });

  it('back-to-back bookings and a third booking on the same day still work', async () => {
    const { svc } = harness();
    await book(svc, CLIENT, local(6, '10:00'));
    await book(svc, CLIENT_2, local(6, '10:30'));
    await book(svc, CLIENT, local(6, '11:00'));
    const f = await failure(book(svc, CLIENT, local(6, '02:00')));
    expect(f.message).toMatch(/outside your coach's open hours/);
  });
});

describe('minimum notice', () => {
  it('hides and refuses times inside the notice; later times stay bookable', async () => {
    const { svc } = harness();
    await svc.updateMyBookingOptions(COACH, { min_notice_minutes: 1440 });
    // Monday is entirely inside the 1 day notice; Tuesday 09:00 is 25 hours out.
    expect(await slotStarts(svc, local(5, '00:00'), local(6, '00:00'))).toEqual([]);
    expect((await slotStarts(svc, local(6, '00:00'), local(7, '00:00')))[0]).toBe(
      local(6, '09:00'),
    );
    const f = await failure(book(svc, CLIENT, local(5, '15:00')));
    expect(f).toMatchObject({ status: 400, code: 'SESSION_IN_PAST' });
    expect(f.message).toBe('That time is too soon. Pick a time at least 1 day from now.');
    await expect(book(svc, CLIENT, local(6, '09:00'))).resolves.toMatchObject({
      status: 'scheduled',
    });
  });
});

describe('booking window', () => {
  it('a shorter window hides and refuses later dates', async () => {
    const { svc } = harness();
    await svc.updateMyBookingOptions(COACH, { booking_window_days: 7 });
    // now + 7 days = Monday 2026-10-12 08:00 local.
    const starts = await slotStarts(svc, local(12, '00:00'), local(13, '00:00'));
    expect(starts).toEqual([]);
    const f = await failure(book(svc, CLIENT, local(13, '10:00')));
    expect(f).toMatchObject({ status: 400, code: 'BEYOND_BOOKING_HORIZON' });
    expect(f.message).toBe('Sessions can be booked up to 7 days ahead. Pick an earlier date.');
    await expect(book(svc, CLIENT, local(11, '10:00'))).resolves.toMatchObject({
      status: 'scheduled',
    });
  });

  it('a longer window opens dates past the old 120-day limit', async () => {
    const { svc } = harness();
    const far = '2027-03-02T18:00:00.000Z'; // 10:00 PST, 148 days out
    const before = await failure(book(svc, CLIENT, far));
    expect(before.code).toBe('BEYOND_BOOKING_HORIZON');
    await svc.updateMyBookingOptions(COACH, { booking_window_days: 200 });
    expect(await slotStarts(svc, '2027-03-02T08:00:00.000Z', '2027-03-03T08:00:00.000Z')).toContain(
      far,
    );
    await expect(book(svc, CLIENT, far)).resolves.toMatchObject({ status: 'scheduled' });
  });
});

describe('buffers', () => {
  it('keeps before + after free around an existing session in slots and on booking', async () => {
    const { svc } = harness();
    await book(svc, CLIENT, local(6, '10:00'));
    await svc.updateMyBookingOptions(COACH, {
      buffer_before_minutes: 10,
      buffer_after_minutes: 15,
    });
    const starts = await slotStarts(svc, local(6, '00:00'), local(7, '00:00'));
    // Held: 09:35-10:55 (10:00-10:30 plus 25 minutes either side).
    expect(starts).toContain(local(6, '09:00'));
    expect(starts).not.toContain(local(6, '09:30'));
    expect(starts).not.toContain(local(6, '10:30'));
    expect(starts).toContain(local(6, '10:55'));
    const f = await failure(book(svc, CLIENT_2, local(6, '10:30')));
    expect(f).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
    expect(f.message).toMatch(/too close to another session/);
    await expect(book(svc, CLIENT_2, local(6, '10:55'))).resolves.toMatchObject({
      status: 'scheduled',
    });
  });
});

describe('daily maximum', () => {
  it('a full day offers no slots and refuses bookings; other days and a move within the day still work', async () => {
    const { svc } = harness();
    const first = await book(svc, CLIENT, local(6, '10:00'));
    await svc.updateMyBookingOptions(COACH, { daily_max_sessions: 1 });
    expect(await slotStarts(svc, local(6, '00:00'), local(7, '00:00'))).toEqual([]);
    expect((await slotStarts(svc, local(8, '00:00'), local(9, '00:00'))).length).toBe(16);
    const f = await failure(book(svc, CLIENT_2, local(6, '14:00')));
    expect(f).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
    expect(f.message).toBe("Your coach's day is fully booked. Pick a time on another day.");
    await expect(book(svc, CLIENT_2, local(8, '14:00'))).resolves.toMatchObject({
      status: 'scheduled',
    });
    // The client's own session does not count against its move within the day.
    await expect(
      svc.rescheduleSession(CLIENT, first.id, {
        start_at: local(6, '14:00'),
        end_at: local(6, '14:30'),
      }),
    ).resolves.toMatchObject({ start_at: new Date(local(6, '14:00')) });
  });
});

// AUD-SOL-AV1-122: independent normal-use probes, at PR #735's exact head.
describe('Sol independent booking-options probes', () => {
  it('a coach only reads and saves their own options, even if a body names another coach', async () => {
    const { db, svc } = harness();
    db.addUser({ id: 'coach-2', name: 'Coach Two', role: 'coach' });
    const coach2: ActorContext = { ...COACH, id: 'coach-2' };
    await svc.updateMyBookingOptions(coach2, { booking_window_days: 30 });
    const patch = { min_notice_minutes: 90, coach_id: 'coach-2' };
    await svc.updateMyBookingOptions(COACH, patch);
    expect(await svc.getMyBookingOptions(COACH)).toMatchObject({
      coach_id: 'coach-1',
      min_notice_minutes: 90,
      booking_window_days: 120,
    });
    expect(await svc.getMyBookingOptions(coach2)).toMatchObject({
      coach_id: 'coach-2',
      min_notice_minutes: 5,
      booking_window_days: 30,
    });
  });

  it('client moves enforce minimum notice and leave the original booking intact on refusal', async () => {
    const { db, svc } = harness();
    const first = await book(svc, CLIENT, local(6, '09:00'));
    await svc.updateMyBookingOptions(COACH, { min_notice_minutes: 1440 });
    expect(await failure(svc.rescheduleSession(CLIENT, first.id, {
      start_at: local(5, '15:00'),
      end_at: local(5, '15:30'),
    }))).toMatchObject({ status: 400, code: 'SESSION_IN_PAST' });
    expect(db.sessions.find((s) => s.id === first.id)?.start_at).toEqual(first.start_at);
  });

  it('client moves enforce the edited booking window', async () => {
    const { db, svc } = harness();
    const first = await book(svc, CLIENT, local(6, '09:00'));
    await svc.updateMyBookingOptions(COACH, { booking_window_days: 7 });
    expect(await failure(svc.rescheduleSession(CLIENT, first.id, {
      start_at: local(13, '10:00'),
      end_at: local(13, '10:30'),
    }))).toMatchObject({ status: 400, code: 'BEYOND_BOOKING_HORIZON' });
    expect(db.sessions.find((s) => s.id === first.id)?.start_at).toEqual(first.start_at);
  });

  it('client moves cannot skip buffers around another client session', async () => {
    const { db, svc } = harness();
    const first = await book(svc, CLIENT, local(6, '09:00'));
    await book(svc, CLIENT_2, local(6, '10:00'));
    await svc.updateMyBookingOptions(COACH, {
      buffer_before_minutes: 10,
      buffer_after_minutes: 15,
    });
    expect(await failure(svc.rescheduleSession(CLIENT, first.id, {
      start_at: local(6, '10:30'),
      end_at: local(6, '11:00'),
    }))).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE', message: expect.stringContaining('too close') });
    expect(db.sessions.find((s) => s.id === first.id)?.start_at).toEqual(first.start_at);
  });

  it('client moves cannot exceed the destination day maximum', async () => {
    const { db, svc } = harness();
    const first = await book(svc, CLIENT, local(6, '09:00'));
    await book(svc, CLIENT_2, local(7, '10:00'));
    await svc.updateMyBookingOptions(COACH, { daily_max_sessions: 1 });
    expect(await failure(svc.rescheduleSession(CLIENT, first.id, {
      start_at: local(7, '14:00'),
      end_at: local(7, '14:30'),
    }))).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE', message: expect.stringContaining('fully booked') });
    expect(db.sessions.find((s) => s.id === first.id)?.start_at).toEqual(first.start_at);
  });

  it('coach self-moves are not bound by client notice, buffers, or daily maximum', async () => {
    const { svc } = harness();
    const first = await book(svc, CLIENT, local(6, '09:00'));
    await book(svc, CLIENT_2, local(5, '10:00'));
    await svc.updateMyBookingOptions(COACH, {
      min_notice_minutes: 120,
      booking_window_days: 1,
      buffer_before_minutes: 30,
      buffer_after_minutes: 30,
      daily_max_sessions: 1,
    });
    await expect(svc.rescheduleSession(COACH, first.id, {
      start_at: local(5, '09:00'),
      end_at: local(5, '09:30'),
    })).resolves.toMatchObject({ start_at: new Date(local(5, '09:00')) });
  });

  it('every advertised slot remains bookable with notice, window, buffers and cap combined', async () => {
    async function fixture() {
      const h = harness();
      await book(h.svc, CLIENT_2, local(6, '10:00'));
      await h.svc.updateMyBookingOptions(COACH, {
        min_notice_minutes: 60,
        booking_window_days: 7,
        buffer_before_minutes: 10,
        buffer_after_minutes: 20,
        daily_max_sessions: 2,
      });
      return h;
    }
    const { svc } = await fixture();
    const starts = await slotStarts(svc, local(6, '00:00'), local(7, '00:00'));
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      const fresh = await fixture();
      await expect(book(fresh.svc, CLIENT, start)).resolves.toMatchObject({ status: 'scheduled' });
    }
  });
});
