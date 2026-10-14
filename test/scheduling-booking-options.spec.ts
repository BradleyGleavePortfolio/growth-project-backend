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
      cancel_notice_hours: 24,
    });
    expect(view.defaults).toEqual({
      min_notice_minutes: 5,
      booking_window_days: 120,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      daily_max_sessions: null,
      cancel_notice_hours: 24,
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

// ---------------------------------------------------------------------------
// C4-NOTICE (owner Option 1): each coach sets how many hours before the start a
// client's own move or cancel locks (default 24). Coaches, the server's own
// flows and new bookings are never bound by it.
// ---------------------------------------------------------------------------
describe('notice to move or cancel (cancel_notice_hours)', () => {
  const HOUR = 3_600_000;
  // Thursday 2026-10-08 10:00 PDT, 74 hours after NOW.
  const START = local(8, '10:00');
  afterEach(() => jest.setSystemTime(NOW));

  function confirmed(db: SchedulingFakeDb, id: string, start = START, coachId = 'coach-1') {
    db.addSession({
      id,
      coach_id: coachId,
      client_id: coachId === 'coach-1' ? 'client-1' : 'client-3',
      session_type_id: coachId === 'coach-1' ? 'st-open' : null,
      status: 'scheduled',
      start_at: new Date(start),
      end_at: new Date(plus(start, 30)),
    });
  }
  function at(iso: string, offsetMs = 0): void {
    jest.setSystemTime(new Date(new Date(iso).getTime() + offsetMs));
  }

  it('defaults to 24 hours: open slots and the client session carry it; not the coach', async () => {
    const { svc, db } = harness();
    confirmed(db, 's1');
    const payload = await svc.getOpenSlots(CLIENT, 'coach-1', {
      from: local(8, '00:00'),
      to: local(9, '00:00'),
      session_type_id: 'st-open',
    });
    expect(payload.cancel_notice_hours).toBe(24);
    const view = await svc.getSession(CLIENT, 's1');
    expect(view.change_locked_at?.toISOString()).toBe(plus(START, -24 * 60));
    expect(view).toMatchObject({ cancellable: true, reschedulable: true });
    // The coach's profile row itself never rides along.
    expect(JSON.stringify(view)).not.toContain('booking_cancel_notice_hours');
    const coachView = await svc.getSession(COACH, 's1');
    expect(coachView.change_locked_at).toBeNull();
  });

  it.each([24, 12, 48])(
    'with %i hours: a client may cancel or move one minute before the lock, not at it',
    async (hours) => {
      const { svc, db } = harness();
      if (hours !== 24) await svc.updateMyBookingOptions(COACH, { cancel_notice_hours: hours });
      for (const id of ['early-cancel', 'early-move', 'late']) confirmed(db, id);
      const lockAt = plus(START, -hours * 60);

      at(lockAt, -60_000);
      const open = await svc.getSession(CLIENT, 'early-cancel');
      expect(open).toMatchObject({ cancellable: true, reschedulable: true });
      expect(open.change_locked_at?.toISOString()).toBe(lockAt);
      await expect(svc.cancelSession(CLIENT, 'early-cancel', {})).resolves.toMatchObject({
        status: 'canceled',
      });
      await expect(
        svc.rescheduleSession(CLIENT, 'early-move', {
          start_at: local(8, '14:00'),
          end_at: local(8, '14:30'),
        }),
      ).resolves.toMatchObject({ start_at: new Date(local(8, '14:00')) });

      at(lockAt);
      const locked = await svc.getSession(CLIENT, 'late');
      expect(locked).toMatchObject({ cancellable: false, reschedulable: false });
      const cancel = await failure(svc.cancelSession(CLIENT, 'late', {}));
      expect(cancel).toMatchObject({ status: 409, code: 'CHANGES_LOCKED' });
      const move = await failure(
        svc.rescheduleSession(CLIENT, 'late', {
          start_at: local(8, '15:00'),
          end_at: local(8, '15:30'),
        }),
      );
      expect(move).toMatchObject({ status: 409, code: 'CHANGES_LOCKED' });
      expect(db.sessions.find((s) => s.id === 'late')).toMatchObject({
        status: 'scheduled',
        start_at: new Date(START),
      });
    },
  );

  it('with 0 hours: changes stay open until the start, as before', async () => {
    const { svc, db } = harness();
    await svc.updateMyBookingOptions(COACH, { cancel_notice_hours: 0 });
    confirmed(db, 's1');
    confirmed(db, 's2', local(8, '11:00'));
    at(START, -60_000);
    const view = await svc.getSession(CLIENT, 's1');
    expect(view).toMatchObject({ cancellable: true, reschedulable: true });
    expect(view.change_locked_at?.toISOString()).toBe(START);
    await expect(svc.cancelSession(CLIENT, 's1', {})).resolves.toMatchObject({
      status: 'canceled',
    });
    at(local(8, '11:00'));
    expect((await failure(svc.cancelSession(CLIENT, 's2', {}))).code).toBe('SESSION_STARTED');
  });

  it('a coach can still cancel or move inside the notice', async () => {
    const { svc, db } = harness();
    confirmed(db, 'moved');
    confirmed(db, 'cancelled', local(8, '12:00'));
    at(START, -HOUR);
    await expect(
      svc.rescheduleSession(COACH, 'moved', {
        start_at: local(8, '15:00'),
        end_at: local(8, '15:30'),
      }),
    ).resolves.toMatchObject({ start_at: new Date(local(8, '15:00')) });
    await expect(svc.cancelSession(COACH, 'cancelled', {})).resolves.toMatchObject({
      status: 'canceled',
    });
  });

  it('booking a time inside the notice stays allowed; the client then cannot change it', async () => {
    const { svc } = harness();
    const s = await book(svc, CLIENT, local(5, '15:00')); // 7 hours from now
    expect(s).toMatchObject({ status: 'scheduled', cancellable: false, reschedulable: false });
    expect((await failure(svc.cancelSession(CLIENT, s.id, {}))).code).toBe('CHANGES_LOCKED');
  });

  it("another coach's notice never applies, and one coach's edit never changes another's", async () => {
    const { svc, db } = harness();
    db.addUser({ id: 'coach-2', name: 'Coach Lee', role: 'coach' });
    db.addUser({ id: 'client-3', name: 'Client Three', role: 'student', coach_id: 'coach-2' });
    const COACH_2: ActorContext = { id: 'coach-2', role: 'coach', email: null, coach_id: null };
    const CLIENT_3: ActorContext = {
      id: 'client-3',
      role: 'student',
      email: null,
      coach_id: 'coach-2',
    };
    await svc.updateMyBookingOptions(COACH_2, { cancel_notice_hours: 0 });
    expect((await svc.getMyBookingOptions(COACH)).cancel_notice_hours).toBe(24);
    confirmed(db, 'mine');
    confirmed(db, 'theirs', START, 'coach-2');
    at(START, -12 * HOUR);
    expect(await svc.getSession(CLIENT, 'mine')).toMatchObject({ cancellable: false });
    expect((await failure(svc.cancelSession(CLIENT, 'mine', {}))).code).toBe('CHANGES_LOCKED');
    expect(await svc.getSession(CLIENT_3, 'theirs')).toMatchObject({ cancellable: true });
    await expect(svc.cancelSession(CLIENT_3, 'theirs', {})).resolves.toMatchObject({
      status: 'canceled',
    });
    // Neither client reads the other's session.
    expect((await failure(svc.getSession(CLIENT_3, 'mine'))).status).toBe(404);
  });

  it('counts elapsed hours across the DST change in the coach zone', async () => {
    const { svc, db } = harness();
    // Sunday 2026-11-01 10:00 PST (clocks went back at 02:00). 24 hours
    // earlier is Saturday 11:00 PDT.
    const sunday = '2026-11-01T18:00:00.000Z';
    confirmed(db, 'ok', sunday);
    confirmed(db, 'late', sunday);
    const view = await svc.getSession(CLIENT, 'ok');
    expect(view.change_locked_at?.toISOString()).toBe('2026-10-31T18:00:00.000Z');
    at('2026-10-31T17:59:00.000Z');
    await expect(svc.cancelSession(CLIENT, 'ok', {})).resolves.toMatchObject({
      status: 'canceled',
    });
    at('2026-10-31T18:00:00.000Z');
    expect((await failure(svc.cancelSession(CLIENT, 'late', {}))).code).toBe('CHANGES_LOCKED');
  });

  it.each([
    [{ cancel_notice_hours: -1 }],
    [{ cancel_notice_hours: 169 }],
    [{ cancel_notice_hours: 1.5 }],
    [JSON.parse('{"cancel_notice_hours":"24"}')],
  ])('refuses %j with INVALID_BOOKING_OPTIONS', async (patch) => {
    const { svc } = harness();
    const f = await failure(svc.updateMyBookingOptions(COACH, patch));
    expect(f).toMatchObject({ status: 400, code: 'INVALID_BOOKING_OPTIONS' });
    expect(f.message).toBe(
      'Notice to move or cancel (hours) must be a whole number from 0 to 168.',
    );
  });

  it('accepts the range ends, and a client cannot set it', async () => {
    const { svc } = harness();
    for (const hours of [168, 0]) {
      await expect(
        svc.updateMyBookingOptions(COACH, { cancel_notice_hours: hours }),
      ).resolves.toMatchObject({ cancel_notice_hours: hours });
    }
    const f = await failure(svc.updateMyBookingOptions(CLIENT, { cancel_notice_hours: 0 }));
    expect(f.status).toBe(403);
    expect((await svc.getMyBookingOptions(COACH)).cancel_notice_hours).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C4MOVED (MOCKUP-3 C4 slice 6): a session records the start it had before its
// most recent move, who moved it and when (C4-S-100, C4-S-101). Only a move
// that changes the start writes them.
// ---------------------------------------------------------------------------
describe('moved fields (moved_from_start_at, moved_by_role, last_moved_at)', () => {
  const START = local(8, '10:00');
  const UNMOVED = { moved_from_start_at: null, moved_by_role: null, last_moved_at: null };
  afterEach(() => jest.setSystemTime(NOW));

  function confirmed(db: SchedulingFakeDb, id: string, start = START, type = 'st-open') {
    db.addSession({
      id,
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: type,
      status: 'scheduled',
      start_at: new Date(start),
      end_at: new Date(plus(start, 30)),
    });
  }
  function move(svc: SchedulingService, actor: ActorContext, id: string, start: string, min = 30) {
    return svc.rescheduleSession(actor, id, { start_at: start, end_at: plus(start, min) });
  }
  function movedBy(role: 'coach' | 'client', from: string, at: Date = NOW) {
    return { moved_from_start_at: new Date(from), moved_by_role: role, last_moved_at: at };
  }

  it('a coach move records the previous start, coach and when; both views carry them', async () => {
    const { svc, db } = harness();
    confirmed(db, 's1');
    await expect(move(svc, COACH, 's1', local(8, '14:00'))).resolves.toMatchObject({
      start_at: new Date(local(8, '14:00')),
      ...movedBy('coach', START),
    });
    expect(await svc.getSession(CLIENT, 's1')).toMatchObject(movedBy('coach', START));
    expect(await svc.getSession(COACH, 's1')).toMatchObject(movedBy('coach', START));
    expect((await svc.listUpcomingForActor(CLIENT))[0]).toMatchObject(movedBy('coach', START));
  });

  it("a client's move of a confirmed session records client; the coach's approval keeps it", async () => {
    const { svc, db } = harness();
    db.addSessionType({
      id: 'st-ask',
      coach_id: 'coach-1',
      name: 'Check-in call',
      duration_minutes: 30,
      auto_approve: false,
    });
    confirmed(db, 's1', START, 'st-ask');
    await expect(move(svc, CLIENT, 's1', local(8, '14:00'))).resolves.toMatchObject({
      status: 'requested',
      ...movedBy('client', START),
    });
    jest.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    await expect(svc.approveSession(COACH, 's1')).resolves.toMatchObject({
      status: 'scheduled',
      start_at: new Date(local(8, '14:00')),
      ...movedBy('client', START),
    });
  });

  it('a second move keeps only the latest previous start, mover and time', async () => {
    const { svc, db } = harness();
    confirmed(db, 's1');
    await move(svc, COACH, 's1', local(8, '14:00'));
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    jest.setSystemTime(later);
    await expect(move(svc, CLIENT, 's1', local(8, '15:00'))).resolves.toMatchObject({
      start_at: new Date(local(8, '15:00')),
      ...movedBy('client', local(8, '14:00'), later),
    });
  });

  it('a new end at the same start is not a move', async () => {
    const { svc, db } = harness();
    confirmed(db, 's1');
    await expect(move(svc, COACH, 's1', START, 45)).resolves.toMatchObject({
      end_at: new Date(plus(START, 45)),
      ...UNMOVED,
    });
  });

  it('booking, cancel and no-show leave them unchanged', async () => {
    const { svc, db } = harness();
    await expect(book(svc, CLIENT, local(8, '12:00'))).resolves.toMatchObject(UNMOVED);
    confirmed(db, 'never-moved', local(9, '10:00'));
    await expect(svc.cancelSession(CLIENT, 'never-moved', {})).resolves.toMatchObject({
      status: 'canceled',
      ...UNMOVED,
    });
    confirmed(db, 'to-cancel');
    confirmed(db, 'to-miss', local(7, '10:00'));
    await move(svc, COACH, 'to-cancel', local(8, '14:00'));
    await move(svc, COACH, 'to-miss', local(7, '14:00'));
    await expect(svc.cancelSession(CLIENT, 'to-cancel', {})).resolves.toMatchObject({
      status: 'canceled',
      ...movedBy('coach', START),
    });
    jest.setSystemTime(new Date(plus(local(7, '14:00'), 40)));
    await expect(svc.markNoShow(COACH, 'to-miss')).resolves.toMatchObject({
      status: 'no_show',
      ...movedBy('coach', local(7, '10:00')),
    });
  });

  it('another coach, their client and another client cannot read them (the existing 404)', async () => {
    const { svc, db } = harness();
    db.addUser({ id: 'coach-2', name: 'Coach Lee', role: 'coach' });
    db.addUser({ id: 'client-3', name: 'Client Three', role: 'student', coach_id: 'coach-2' });
    const COACH_2: ActorContext = { id: 'coach-2', role: 'coach', email: null, coach_id: null };
    const CLIENT_3: ActorContext = {
      id: 'client-3',
      role: 'student',
      email: null,
      coach_id: 'coach-2',
    };
    confirmed(db, 's1');
    await move(svc, COACH, 's1', local(8, '14:00'));
    for (const actor of [COACH_2, CLIENT_3, CLIENT_2]) {
      expect((await failure(svc.getSession(actor, 's1'))).status).toBe(404);
      expect(await svc.listUpcomingForActor(actor)).toEqual([]);
    }
  });

  it('older app builds ignore them: the view only adds three keys and keeps every other', async () => {
    const { svc, db } = harness();
    confirmed(db, 's1');
    const NEW_KEYS = ['last_moved_at', 'moved_by_role', 'moved_from_start_at'];
    const before = await svc.getSession(CLIENT, 's1');
    expect(before).toMatchObject(UNMOVED);
    // The keys the session view had before C4MOVED, unchanged.
    expect(Object.keys(before).filter((k) => !NEW_KEYS.includes(k)).sort()).toEqual(
      [
        ...['id', 'coach_id', 'client_id', 'session_type_id', 'status', 'start_at', 'end_at'],
        ...['title', 'coach_notes_md', 'client_recap_md', 'video_provider', 'video_url'],
        ...['video_meeting_id', 'calendar_provider', 'calendar_event_id', 'approved_at'],
        ...['provider_idempotency_key', 'ended_at', 'end_reason', 'request_expires_at'],
        ...['created_at', 'updated_at', 'session_type', 'coach_name', 'client_name'],
        ...['meeting_link_status', 'cancellable', 'reschedulable', 'change_locked_at'],
      ].sort(),
    );
    const after = await move(svc, CLIENT, 's1', local(8, '14:00'));
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // Apart from the times, every earlier field reads the same after a move.
    const rest = (v: object) =>
      Object.entries(v).filter(([k]) => !NEW_KEYS.includes(k) && !k.endsWith('_at'));
    expect(rest(after)).toEqual(rest(before));
  });
});
