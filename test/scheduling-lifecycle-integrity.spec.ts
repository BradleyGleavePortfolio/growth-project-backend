/**
 * S-SCHED-2: native scheduling lifecycle integrity.
 *
 * Drives the real SchedulingService / lifecycle / open-slots / access
 * services and the real BookingEmitter over an in-memory Prisma double
 * (test/utils/scheduling-fake-db.ts) that models the per-coach advisory
 * lock and the no-overlap exclusion constraint. Covers:
 *   - the booking validation matrix (type, duration, availability,
 *     overrides, lead time, horizon, limits, welcome rule),
 *   - ownership (head coach, sub-coach, foreign coach, archived types,
 *     session reads, coach-only fields),
 *   - races (N concurrent requests, approve vs cancel, double approve,
 *     reschedule vs request) with a control that proves the harness can
 *     produce a double booking when both guards are off,
 *   - lifecycle rules (re-approval on client move, reminder re-arm, call
 *     link recovery, past/upcoming lists),
 *   - real notification delivery shape (one in-app row + push with tap
 *     routing) for each lifecycle event.
 * The database-level floor itself is proven against real Postgres in
 * test/scheduling-booking-concurrency.live.spec.ts.
 */
import { HttpException } from '@nestjs/common';
import { AuditService } from '../src/audit/audit.service';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import type { PushDeliveryResult } from '../src/notifications/push-delivery.types';
import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { ActorContext } from '../src/scheduling/scheduling.types';
import { SchedulingFakeDb, asPrisma } from './utils/scheduling-fake-db';

// Monday 2026-10-05 08:00 PDT.
const NOW = new Date('2026-10-05T15:00:00.000Z');
// Tuesday 2026-10-06, coach-local (America/Los_Angeles, PDT = UTC-7).
const TUE_1000 = '2026-10-06T17:00:00.000Z';
const TUE_1015 = '2026-10-06T17:15:00.000Z';
const TUE_1030 = '2026-10-06T17:30:00.000Z';
const TUE_1100 = '2026-10-06T18:00:00.000Z';
const TUE_1115 = '2026-10-06T18:15:00.000Z';
const TUE_1130 = '2026-10-06T18:30:00.000Z';

const COACH: ActorContext = { id: 'coach-1', role: 'coach', email: null, coach_id: null };
const SUB_COACH: ActorContext = { id: 'coach-2', role: 'coach', email: null, coach_id: null };
const OTHER_COACH: ActorContext = { id: 'coach-3', role: 'coach', email: null, coach_id: null };
const OWNER: ActorContext = { id: 'owner-1', role: 'owner', email: null, coach_id: null };
const CLIENT: ActorContext = { id: 'client-1', role: 'student', email: null, coach_id: 'coach-1' };
const CLIENT_2: ActorContext = {
  id: 'client-2',
  role: 'student',
  email: null,
  coach_id: 'coach-1',
};
const FOREIGN_CLIENT: ActorContext = {
  id: 'client-9',
  role: 'student',
  email: null,
  coach_id: 'coach-3',
};

function client(n: number): ActorContext {
  return { id: `client-${n}`, role: 'student', email: null, coach_id: 'coach-1' };
}

class FakeNotifications {
  rows: CreateNotificationInput[] = [];
  pushes: Array<{ userId: string; title: string; body: string; data: Record<string, unknown> }> =
    [];
  prefs = new Map<string, Record<string, unknown>>();
  pushResult: PushDeliveryResult = { delivered: true, code: 'delivered' };

  createNotification = jest.fn(async (input: CreateNotificationInput) => {
    const p = this.prefs.get(input.user_id) ?? {};
    if (p.muted === true || p.booking_inapp === false) return null;
    this.rows.push(input);
    return { id: `notif-${this.rows.length}` };
  });

  getPreferences = jest.fn(async (userId: string) => ({
    user_id: userId,
    timezone: 'America/Los_Angeles',
    booking_push: true,
    booking_inapp: true,
    muted: false,
    ...(this.prefs.get(userId) ?? {}),
  }));

  pushToUser = jest.fn(
    async (userId: string, title: string, body: string, data?: Record<string, unknown>) => {
      this.pushes.push({ userId, title, body, data: data ?? {} });
      return this.pushResult;
    },
  );

  kindsFor(userId: string): string[] {
    return this.rows.filter((r) => r.user_id === userId).map((r) => r.kind);
  }
}

function registry(): SchedulingProviderRegistry {
  return new SchedulingProviderRegistry(
    new StubCalendarAdapter(),
    new GoogleCalendarAdapter(),
    new StubVideoAdapter(),
    new GoogleMeetAdapter(),
    new ZoomVideoAdapter(),
  );
}

function seed(db: SchedulingFakeDb): void {
  db.addUser({ id: 'coach-1', name: 'Coach Kim', role: 'coach' });
  db.addUser({ id: 'coach-2', name: 'Coach Lee', role: 'coach' });
  db.addUser({ id: 'coach-3', name: 'Coach Ray', role: 'coach' });
  db.addUser({ id: 'owner-1', name: 'Owner', role: 'owner' });
  for (let n = 1; n <= 6; n++) {
    db.addUser({ id: `client-${n}`, name: `Client ${n}`, role: 'student', coach_id: 'coach-1' });
  }
  db.addUser({ id: 'client-9', name: 'Client Nine', role: 'student', coach_id: 'coach-3' });

  db.addSessionType({
    id: 'st-w',
    coach_id: 'coach-1',
    name: 'Quick initialization',
    duration_minutes: 30,
    auto_approve: true,
    is_welcome: true,
    default_meeting_url: 'https://meet.example.com/coach-kim',
  });
  db.addSessionType({
    id: 'st-q',
    coach_id: 'coach-1',
    name: 'Quick Q/A Call',
    duration_minutes: 15,
    auto_approve: false,
  });
  db.addSessionType({
    id: 'st-open',
    coach_id: 'coach-1',
    name: 'Open call',
    duration_minutes: 30,
    auto_approve: true,
  });
  db.addSessionType({
    id: 'st-old',
    coach_id: 'coach-1',
    name: 'Retired type',
    duration_minutes: 30,
    auto_approve: true,
    archived_at: new Date('2026-09-01T00:00:00Z'),
  });
  db.addSessionType({
    id: 'st-sub',
    coach_id: 'coach-2',
    name: 'Form check',
    duration_minutes: 30,
    auto_approve: true,
  });
  db.addSessionType({
    id: 'st-c3',
    coach_id: 'coach-3',
    name: 'Other coach call',
    duration_minutes: 30,
    auto_approve: true,
  });

  for (const coach of ['coach-1', 'coach-2', 'coach-3']) {
    for (let day = 1; day <= 5; day++) db.addWindow(coach, day, 9 * 60, 17 * 60);
  }
  // Saturday 09:00-10:00 offers only the Q/A type.
  db.addWindow('coach-1', 6, 9 * 60, 10 * 60, 'st-q');
  // Wednesday 2026-10-07 is a holiday; Sunday 2026-10-11 has extra hours.
  db.addOverride({
    coach_id: 'coach-1',
    date: '2026-10-07',
    kind: 'holiday',
    start_minute: null,
    end_minute: null,
  });
  db.addOverride({
    coach_id: 'coach-1',
    date: '2026-10-11',
    kind: 'extra',
    start_minute: 10 * 60,
    end_minute: 12 * 60,
  });

  // client-1 is delegated to sub-coach coach-2 inside coach-1's team.
  db.subAssignments.push({
    id: 'sa-1',
    head_coach_id: 'coach-1',
    sub_coach_id: 'coach-2',
    client_id: 'client-1',
    unassigned_at: null,
    assigned_at: new Date('2026-09-01T00:00:00Z'),
  });
  db.teamAssignments.push({
    id: 'team-1',
    head_coach_id: 'coach-1',
    sub_coach_id: 'coach-2',
    archived_at: null,
  });
}

function harness() {
  const db = new SchedulingFakeDb();
  seed(db);
  const notifications = new FakeNotifications();
  const emitter = new BookingEmitter(
    Object.assign(
      Object.create(NotificationsService.prototype) as NotificationsService,
      notifications,
    ),
  );
  const auditWrites: unknown[] = [];
  const audit = Object.assign(Object.create(AuditService.prototype) as AuditService, {
    write: jest.fn(async (input: unknown) => {
      auditWrites.push(input);
    }),
  });
  const svc = new SchedulingService(asPrisma(db), audit, registry(), emitter);
  return { db, notifications, svc, auditWrites };
}

interface Failure {
  status: number;
  code: string;
  message: string;
}

async function failure(p: Promise<unknown>): Promise<Failure> {
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

function rejectionCode(r: PromiseSettledResult<unknown>): string | null {
  if (r.status !== 'rejected') return null;
  const err: unknown = r.reason;
  if (!(err instanceof HttpException)) return 'non-http';
  const res = err.getResponse();
  const body: Record<string, unknown> = typeof res === 'object' && res !== null ? { ...res } : {};
  return String(body.code);
}

function request(actor: ActorContext, typeId: string | undefined, start: string, end: string) {
  return {
    coach_id: actor.coach_id ?? 'coach-1',
    session_type_id: typeId,
    title: 'Session',
    start_at: start,
    end_at: end,
  };
}

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

describe('booking validation matrix (request)', () => {
  it('requires an appointment type', async () => {
    const { svc } = harness();
    const f = await failure(
      svc.requestSession(CLIENT, request(CLIENT, undefined, TUE_1000, TUE_1015)),
    );
    expect(f).toMatchObject({ status: 400, code: 'SESSION_TYPE_REQUIRED' });
    expect(f.message).toMatch(/appointment type/i);
  });

  it.each([
    ['archived type', 'st-old'],
    ["another coach's type", 'st-c3'],
    ['unknown type', '00000000-0000-4000-8000-000000000000'],
  ])('refuses %s with SESSION_TYPE_UNAVAILABLE', async (_label, typeId) => {
    const { svc } = harness();
    const f = await failure(
      svc.requestSession(CLIENT, request(CLIENT, typeId, TUE_1000, TUE_1030)),
    );
    expect(f).toMatchObject({ status: 400, code: 'SESSION_TYPE_UNAVAILABLE' });
  });

  it('refuses a duration that differs from the type (DURATION_MISMATCH)', async () => {
    const { svc } = harness();
    const f = await failure(
      svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1030)),
    );
    expect(f).toMatchObject({ status: 400, code: 'DURATION_MISMATCH' });
    expect(f.message).toContain('15 minutes');
  });

  it.each([
    ['before open hours (Tue 07:00 local)', '2026-10-06T14:00:00.000Z', '2026-10-06T14:15:00.000Z'],
    ['straddling close (Tue 16:50 local)', '2026-10-06T23:50:00.000Z', '2026-10-07T00:05:00.000Z'],
    ['on a holiday (Wed 10:00 local)', '2026-10-07T17:00:00.000Z', '2026-10-07T17:15:00.000Z'],
    [
      'on a closed weekend day (Sun 09:00 local)',
      '2026-10-11T16:00:00.000Z',
      '2026-10-11T16:15:00.000Z',
    ],
  ])('refuses a time %s with SLOT_UNAVAILABLE', async (_label, start, end) => {
    const { svc } = harness();
    const f = await failure(svc.requestSession(CLIENT, request(CLIENT, 'st-q', start, end)));
    expect(f).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
  });

  it('accepts a time inside extra hours (Sun 10:00 local)', async () => {
    const { svc } = harness();
    const s = await svc.requestSession(
      CLIENT,
      request(CLIENT, 'st-q', '2026-10-11T17:00:00.000Z', '2026-10-11T17:15:00.000Z'),
    );
    expect(s.status).toBe('requested');
  });

  it('honours windows scoped to one type (Saturday is Q/A only)', async () => {
    const { svc } = harness();
    const ok = await svc.requestSession(
      CLIENT,
      request(CLIENT, 'st-q', '2026-10-10T16:00:00.000Z', '2026-10-10T16:15:00.000Z'),
    );
    expect(ok.status).toBe('requested');
    const f = await failure(
      svc.requestSession(
        CLIENT_2,
        request(CLIENT_2, 'st-open', '2026-10-10T16:30:00.000Z', '2026-10-10T17:00:00.000Z'),
      ),
    );
    expect(f.code).toBe('SLOT_UNAVAILABLE');
  });

  it('refuses a start inside the 5 minute lead time (SESSION_IN_PAST)', async () => {
    const { svc } = harness();
    const start = new Date(NOW.getTime() + 2 * 60_000).toISOString();
    const end = new Date(NOW.getTime() + 17 * 60_000).toISOString();
    const f = await failure(svc.requestSession(CLIENT, request(CLIENT, 'st-q', start, end)));
    expect(f).toMatchObject({ status: 400, code: 'SESSION_IN_PAST' });
  });

  it('refuses a start beyond the booking horizon (BEYOND_BOOKING_HORIZON)', async () => {
    const { svc } = harness();
    const f = await failure(
      svc.requestSession(
        CLIENT,
        request(CLIENT, 'st-q', '2027-03-02T17:00:00.000Z', '2027-03-02T17:15:00.000Z'),
      ),
    );
    expect(f).toMatchObject({ status: 400, code: 'BEYOND_BOOKING_HORIZON' });
  });

  it('refuses unreadable, inverted or sub-minute times (INVALID_TIME)', async () => {
    const { svc } = harness();
    for (const [start, end] of [
      ['not-a-date', TUE_1015],
      [TUE_1015, TUE_1000],
      ['2026-10-06T17:00:30.000Z', '2026-10-06T17:15:30.000Z'],
    ]) {
      const f = await failure(svc.requestSession(CLIENT, request(CLIENT, 'st-q', start, end)));
      expect(f).toMatchObject({ status: 400, code: 'INVALID_TIME' });
    }
  });

  it('coach-approval type creates a request; the coach gets an in-app row and a push to the inbox', async () => {
    const { svc, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    expect(s).toMatchObject({
      status: 'requested',
      approved_at: null,
      session_type_id: 'st-q',
      meeting_link_status: 'awaiting_approval',
      cancellable: true,
      reschedulable: true,
    });
    expect(notifications.kindsFor('coach-1')).toEqual([NotificationKind.BOOKING_REQUESTED]);
    const push = notifications.pushes.find((p) => p.userId === 'coach-1');
    expect(push).toBeDefined();
    expect(push?.title).toBe('New session request');
    expect(push?.body).toContain('Quick Q/A Call');
    expect(push?.body).toContain('Tue, Oct 6, 10:00 AM PDT');
    expect(push?.data).toMatchObject({
      kind: 'booking_requested',
      actionScreen: 'CoachBookingInbox',
      actionParams: { sessionId: s.id },
    });
    // Nothing for the client until the coach answers.
    expect(notifications.kindsFor('client-1')).toEqual([]);
  });

  it('instant-confirm type is scheduled, gets the default meeting link, and notifies both sides', async () => {
    const { svc, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-w', TUE_1000, TUE_1030));
    expect(s.status).toBe('scheduled');
    expect(s.approved_at).not.toBeNull();
    expect(s.video_url).toBe('https://meet.example.com/coach-kim');
    expect(s.video_provider).toBe('manual');
    expect(s.meeting_link_status).toBe('ready');
    expect(s.session_type).toMatchObject({ id: 'st-w', is_welcome: true });
    expect(notifications.kindsFor('client-1')).toEqual([NotificationKind.BOOKING_CONFIRMED]);
    expect(notifications.kindsFor('coach-1')).toEqual([NotificationKind.BOOKING_CONFIRMED]);
    const clientPush = notifications.pushes.find((p) => p.userId === 'client-1');
    expect(clientPush?.data).toMatchObject({
      actionScreen: 'CalendarSession',
      actionParams: { sessionId: s.id },
    });
  });

  it('instant-confirm type without a link prompts the coach and shows the client a pending link', async () => {
    const { svc, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-open', TUE_1000, TUE_1030));
    expect(s.status).toBe('scheduled');
    expect(s.video_url).toBeNull();
    expect(s.meeting_link_status).toBe('pending');
    expect(notifications.kindsFor('coach-1')).toEqual([
      NotificationKind.BOOKING_CONFIRMED,
      NotificationKind.BOOKING_LINK_NEEDED,
    ]);
    const prompt = notifications.rows.find((r) => r.kind === NotificationKind.BOOKING_LINK_NEEDED);
    expect(prompt?.body).toMatch(/no call link yet/);
  });

  it('a pending request holds its slot: overlap is refused and the slot leaves open slots', async () => {
    const { svc } = harness();
    await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const f = await failure(
      svc.requestSession(CLIENT_2, request(CLIENT_2, 'st-open', TUE_1000, TUE_1030)),
    );
    expect(f).toMatchObject({ status: 409, code: 'SLOT_TAKEN' });
    const slots = await svc.getOpenSlots(CLIENT_2, 'coach-1', {
      from: '2026-10-06T16:00:00.000Z',
      to: '2026-10-06T19:00:00.000Z',
      session_type_id: 'st-q',
    });
    expect(slots.duration_minutes).toBe(15);
    expect(slots.session_type_id).toBe('st-q');
    const starts = slots.slots.map((x) => x.start_at);
    expect(starts).not.toContain(TUE_1000);
    expect(starts).toContain(TUE_1015);
    // Back-to-back with the request is bookable.
    const next = await svc.requestSession(CLIENT_2, request(CLIENT_2, 'st-q', TUE_1015, TUE_1030));
    expect(next.status).toBe('requested');
  });

  it('a declined request frees its slot', async () => {
    const { svc } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    await svc.declineSession(COACH, s.id, 'Away that morning');
    const again = await svc.requestSession(CLIENT_2, request(CLIENT_2, 'st-q', TUE_1000, TUE_1015));
    expect(again.status).toBe('requested');
  });

  it('caps waiting requests per client per coach (PENDING_REQUEST_LIMIT)', async () => {
    const { svc } = harness();
    await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1100, TUE_1115));
    await svc.requestSession(
      CLIENT,
      request(CLIENT, 'st-q', '2026-10-06T19:00:00.000Z', '2026-10-06T19:15:00.000Z'),
    );
    const f = await failure(
      svc.requestSession(
        CLIENT,
        request(CLIENT, 'st-q', '2026-10-06T20:00:00.000Z', '2026-10-06T20:15:00.000Z'),
      ),
    );
    expect(f).toMatchObject({ status: 409, code: 'PENDING_REQUEST_LIMIT' });
    // Instant-confirm types are not capped by the waiting-request limit.
    const instant = await svc.requestSession(
      CLIENT,
      request(CLIENT, 'st-open', '2026-10-06T21:00:00.000Z', '2026-10-06T21:30:00.000Z'),
    );
    expect(instant.status).toBe('scheduled');
  });

  it('allows one upcoming welcome call per client (WELCOME_ALREADY_BOOKED)', async () => {
    const { svc } = harness();
    await svc.requestSession(CLIENT, request(CLIENT, 'st-w', TUE_1000, TUE_1030));
    const f = await failure(
      svc.requestSession(CLIENT, request(CLIENT, 'st-w', TUE_1100, TUE_1130)),
    );
    expect(f).toMatchObject({ status: 409, code: 'WELCOME_ALREADY_BOOKED' });
    // A different client can still book theirs.
    const other = await svc.requestSession(CLIENT_2, request(CLIENT_2, 'st-w', TUE_1100, TUE_1130));
    expect(other.status).toBe('scheduled');
  });

  it('open slots never offer times inside the lead window', async () => {
    const { svc } = harness();
    // Monday 08:00 local now; Monday window opens 09:00, so every Monday
    // slot is later than now + 5 min; ask from now.
    const slots = await svc.getOpenSlots(CLIENT, 'coach-1', {
      from: NOW.toISOString(),
      to: '2026-10-05T17:00:00.000Z',
      session_type_id: 'st-q',
    });
    const earliest = Math.min(...slots.slots.map((x) => new Date(x.start_at).getTime()));
    expect(earliest).toBeGreaterThanOrEqual(NOW.getTime() + 5 * 60_000);
    expect(slots.slots[0].start_at).toBe('2026-10-05T16:00:00.000Z');
  });
});

describe('ownership (T4)', () => {
  it('a client of another coach cannot read types, hours, open slots, or book', async () => {
    const { svc } = harness();
    for (const p of [
      svc.listSessionTypes(FOREIGN_CLIENT, 'coach-1'),
      svc.getAvailability(FOREIGN_CLIENT, 'coach-1'),
      svc.getOpenSlots(FOREIGN_CLIENT, 'coach-1', {
        from: '2026-10-06T16:00:00.000Z',
        to: '2026-10-06T19:00:00.000Z',
        session_type_id: 'st-q',
      }),
      svc.requestSession(FOREIGN_CLIENT, { ...request(CLIENT, 'st-q', TUE_1000, TUE_1015) }),
    ]) {
      const f = await failure(p);
      expect(f).toMatchObject({ status: 403, code: 'COACH_NOT_BOOKABLE' });
    }
  });

  it('a coach cannot read another coach’s types or hours; owner can', async () => {
    const { svc } = harness();
    expect((await failure(svc.listSessionTypes(OTHER_COACH, 'coach-1'))).status).toBe(403);
    expect((await failure(svc.getAvailability(OTHER_COACH, 'coach-1'))).status).toBe(403);
    expect((await svc.listSessionTypes(OWNER, 'coach-1')).length).toBeGreaterThan(0);
  });

  it('a client sees only active types and never the default meeting link', async () => {
    const { svc } = harness();
    const types = await svc.listSessionTypes(CLIENT, 'coach-1', { includeArchived: true });
    expect(types.map((t) => t.id).sort()).toEqual(['st-open', 'st-q', 'st-w']);
    expect(types[0].id).toBe('st-w');
    expect(types.every((t) => t.default_meeting_url === null)).toBe(true);
    const own = await svc.listSessionTypes(COACH, 'coach-1', { includeArchived: true });
    expect(own.map((t) => t.id)).toContain('st-old');
    expect(own.find((t) => t.id === 'st-w')?.default_meeting_url).toBe(
      'https://meet.example.com/coach-kim',
    );
  });

  it('a delegated client can book their sub-coach; archiving the team link removes it', async () => {
    const { svc, db } = harness();
    const s = await svc.requestSession(CLIENT, {
      ...request(CLIENT, 'st-sub', TUE_1000, TUE_1030),
      coach_id: 'coach-2',
    });
    expect(s).toMatchObject({ coach_id: 'coach-2', status: 'scheduled' });
    // client-2 has no sub assignment.
    const f = await failure(
      svc.requestSession(CLIENT_2, {
        ...request(CLIENT_2, 'st-sub', TUE_1100, TUE_1130),
        coach_id: 'coach-2',
      }),
    );
    expect(f.code).toBe('COACH_NOT_BOOKABLE');
    db.teamAssignments[0].archived_at = new Date();
    const g = await failure(
      svc.requestSession(CLIENT, {
        ...request(CLIENT, 'st-sub', '2026-10-06T20:00:00.000Z', '2026-10-06T20:30:00.000Z'),
        coach_id: 'coach-2',
      }),
    );
    expect(g.code).toBe('COACH_NOT_BOOKABLE');
  });

  it('my-coaches lists head coach then sub-coach, with the welcome type and its booking', async () => {
    const { svc } = harness();
    const before = await svc.listMyCoaches(CLIENT);
    expect(before.map((c) => [c.coach_id, c.relationship])).toEqual([
      ['coach-1', 'head_coach'],
      ['coach-2', 'sub_coach'],
    ]);
    expect(before[0]).toMatchObject({
      name: 'Coach Kim',
      timezone: 'America/Los_Angeles',
      bookable_type_count: 3,
      welcome: { session_type_id: 'st-w', active_session_id: null },
    });
    expect(before[1].welcome).toBeNull();
    const booked = await svc.requestSession(CLIENT, request(CLIENT, 'st-w', TUE_1000, TUE_1030));
    const after = await svc.listMyCoaches(CLIENT);
    expect(after[0].welcome).toMatchObject({
      active_session_id: booked.id,
      active_session_status: 'scheduled',
      active_session_start_at: TUE_1000,
      completed_at: null,
    });
    expect(await svc.listMyCoaches(COACH)).toEqual([]);
  });

  it('my-coaches keeps the welcome call marked done after it is completed', async () => {
    const { svc, db } = harness();
    db.addSession({
      id: 'w-done',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-w',
      status: 'completed',
      start_at: new Date('2026-10-01T16:00:00.000Z'),
      end_at: new Date('2026-10-01T16:30:00.000Z'),
    });
    const [head] = await svc.listMyCoaches(CLIENT);
    expect(head.welcome).toMatchObject({
      active_session_id: null,
      completed_at: '2026-10-01T16:30:00.000Z',
    });
  });

  it('session reads: own client and coach only; client never sees coach-only fields', async () => {
    const { svc, db } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const row = db.sessions.find((x) => x.id === s.id);
    if (row) row.coach_notes_md = 'Private: discuss plateau';
    const asClient = await svc.getSession(CLIENT, s.id);
    expect(asClient.coach_notes_md).toBeNull();
    expect(asClient.provider_idempotency_key).toBeNull();
    const asCoach = await svc.getSession(COACH, s.id);
    expect(asCoach.coach_notes_md).toBe('Private: discuss plateau');
    expect((await failure(svc.getSession(CLIENT_2, s.id))).code).toBe('SESSION_NOT_FOUND');
    expect((await failure(svc.getSession(OTHER_COACH, s.id))).status).toBe(404);
    const listed = await svc.listSessionsForActor(CLIENT, { scope: 'upcoming' });
    expect(listed.every((x) => x.coach_notes_md === null)).toBe(true);
  });

  it('after a coach change the client can still read the session but not move or cancel it', async () => {
    const { svc } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const moved: ActorContext = { ...CLIENT, coach_id: 'coach-3' };
    expect((await svc.getSession(moved, s.id)).id).toBe(s.id);
    expect((await failure(svc.cancelSession(moved, s.id, {}))).code).toBe(
      'NOT_SESSION_PARTICIPANT',
    );
    expect(
      (await failure(svc.rescheduleSession(moved, s.id, { start_at: TUE_1100, end_at: TUE_1115 })))
        .code,
    ).toBe('NOT_SESSION_PARTICIPANT');
  });

  it('only the session coach approves, declines, completes or adds the link', async () => {
    const { svc } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    expect((await failure(svc.approveSession(CLIENT, s.id))).status).toBe(403);
    expect((await failure(svc.approveSession(SUB_COACH, s.id))).status).toBe(404);
    expect(
      (
        await failure(
          svc.attachManualVideoLink(CLIENT, s.id, { video_url: 'https://x.example.com/r' }),
        )
      ).status,
    ).toBe(403);
  });
});

describe('races', () => {
  it('N concurrent requests for one slot: exactly one wins, the rest get SLOT_TAKEN', async () => {
    const { svc, db } = harness();
    const actors = [1, 2, 3, 4, 5].map(client);
    const results = await Promise.allSettled(
      actors.map((a) => svc.requestSession(a, request(a, 'st-q', TUE_1000, TUE_1015))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map(rejectionCode)).toEqual([
      'SLOT_TAKEN',
      'SLOT_TAKEN',
      'SLOT_TAKEN',
      'SLOT_TAKEN',
    ]);
    expect(db.sessions.filter((s) => s.status === 'requested')).toHaveLength(1);
    expect(db.lockKeys).toHaveLength(5);
    expect(new Set(db.lockKeys).size).toBe(1);
  });

  it('control: with the lock and the constraint both off the harness does double book', async () => {
    const { svc, db } = harness();
    db.enforceLock = false;
    db.enforceExclusion = false;
    const actors = [1, 2, 3].map(client);
    const results = await Promise.allSettled(
      actors.map((a) => svc.requestSession(a, request(a, 'st-q', TUE_1000, TUE_1015))),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(1);
  });

  it('database floor: with the lock off, the exclusion constraint still leaves one booking and maps to SLOT_TAKEN', async () => {
    const { svc, db } = harness();
    db.enforceLock = false;
    const actors = [1, 2, 3, 4].map(client);
    const results = await Promise.allSettled(
      actors.map((a) => svc.requestSession(a, request(a, 'st-q', TUE_1000, TUE_1015))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => rejectionCode(r) === 'SLOT_TAKEN'),
    ).toBe(true);
  });

  it('approve vs cancel: exactly one wins and only the winner notifies', async () => {
    const { svc, db, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    notifications.rows = [];
    const [approve, cancel] = await Promise.allSettled([
      svc.approveSession(COACH, s.id),
      svc.cancelSession(CLIENT, s.id, { reason: 'Plans changed' }),
    ]);
    const fulfilled = [approve, cancel].filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const loser = [approve, cancel].find((r) => r.status === 'rejected');
    expect(loser && rejectionCode(loser)).toBe('SESSION_STATE_CHANGED');
    const final = db.sessions.find((x) => x.id === s.id);
    if (approve.status === 'fulfilled') {
      expect(final?.status).toBe('scheduled');
      expect(notifications.kindsFor('client-1')).toEqual([NotificationKind.BOOKING_CONFIRMED]);
      expect(notifications.kindsFor('coach-1')).not.toContain(NotificationKind.BOOKING_CANCELLED);
    } else {
      expect(final?.status).toBe('canceled');
      expect(notifications.kindsFor('coach-1')).toEqual([NotificationKind.BOOKING_CANCELLED]);
      expect(notifications.kindsFor('client-1')).toEqual([]);
    }
  });

  it('double approve: one confirmation, one SESSION_STATE_CHANGED', async () => {
    const { svc, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const results = await Promise.allSettled([
      svc.approveSession(COACH, s.id),
      svc.approveSession(COACH, s.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(rejectionCode).filter((c) => c !== null)).toEqual(['SESSION_STATE_CHANGED']);
    expect(notifications.kindsFor('client-1')).toEqual([NotificationKind.BOOKING_CONFIRMED]);
  });

  it('reschedule into a slot vs a new request for it: one wins', async () => {
    const { svc, db } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-open', TUE_1000, TUE_1030));
    const results = await Promise.allSettled([
      svc.rescheduleSession(CLIENT, s.id, { start_at: TUE_1100, end_at: TUE_1130 }),
      svc.requestSession(CLIENT_2, request(CLIENT_2, 'st-open', TUE_1100, TUE_1130)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(rejectionCode).filter((c) => c !== null)).toEqual(['SLOT_TAKEN']);
    const at1100 = db.sessions.filter(
      (x) =>
        x.start_at instanceof Date &&
        x.start_at.toISOString() === TUE_1100 &&
        x.status === 'scheduled',
    );
    expect(at1100).toHaveLength(1);
  });

  it('a stale reschedule (row changed after it was read) is refused', async () => {
    const { svc, db } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-open', TUE_1000, TUE_1030));
    const results = await Promise.allSettled([
      svc.rescheduleSession(CLIENT, s.id, { start_at: TUE_1100, end_at: TUE_1130 }),
      svc.rescheduleSession(CLIENT, s.id, {
        start_at: '2026-10-06T20:00:00.000Z',
        end_at: '2026-10-06T20:30:00.000Z',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(rejectionCode).filter((c) => c !== null)).toEqual(['SESSION_STATE_CHANGED']);
    expect(db.sessions.filter((x) => x.status === 'scheduled')).toHaveLength(1);
  });
});

describe('lifecycle rules', () => {
  it('client moving a confirmed approval-type session sends it back for approval and re-arms reminders', async () => {
    const { svc, db, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    await svc.approveSession(COACH, s.id);
    db.deliveryLogs.push({
      id: 'log-x',
      session_id: s.id,
      user_id: 'client-1',
      kind: 'booking_reminder_24h',
    });
    notifications.rows = [];
    const moved = await svc.rescheduleSession(CLIENT, s.id, {
      start_at: TUE_1100,
      end_at: TUE_1115,
    });
    expect(moved).toMatchObject({
      status: 'requested',
      approved_at: null,
      start_at: new Date(TUE_1100),
    });
    expect(db.deliveryLogs.filter((l) => l.session_id === s.id)).toHaveLength(0);
    const toCoach = notifications.rows.filter((r) => r.user_id === 'coach-1');
    expect(toCoach.map((r) => r.kind)).toEqual([NotificationKind.BOOKING_RESCHEDULED]);
    expect(toCoach[0].payload).toMatchObject({ title: 'Session move requested' });
  });

  it('client moving an instant-confirm session stays confirmed and must keep the type duration', async () => {
    const { svc, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-open', TUE_1000, TUE_1030));
    const bad = await failure(
      svc.rescheduleSession(CLIENT, s.id, { start_at: TUE_1100, end_at: TUE_1115 }),
    );
    expect(bad.code).toBe('DURATION_MISMATCH');
    const outside = await failure(
      svc.rescheduleSession(CLIENT, s.id, {
        start_at: '2026-10-07T17:00:00.000Z',
        end_at: '2026-10-07T17:30:00.000Z',
      }),
    );
    expect(outside.code).toBe('SLOT_UNAVAILABLE');
    notifications.rows = [];
    const moved = await svc.rescheduleSession(CLIENT, s.id, {
      start_at: TUE_1100,
      end_at: TUE_1130,
    });
    expect(moved.status).toBe('scheduled');
    expect(notifications.kindsFor('coach-1')).toEqual([NotificationKind.BOOKING_RESCHEDULED]);
    // Moving within its own old time (overlapping itself) is fine.
    const nudged = await svc.rescheduleSession(CLIENT, s.id, {
      start_at: TUE_1115,
      end_at: '2026-10-06T18:45:00.000Z',
    });
    expect(nudged.start_at).toEqual(new Date(TUE_1115));
  });

  it('coach may move outside open hours but never onto another booking; client is notified', async () => {
    const { svc, notifications } = harness();
    const a = await svc.requestSession(CLIENT, request(CLIENT, 'st-open', TUE_1000, TUE_1030));
    await svc.requestSession(CLIENT_2, request(CLIENT_2, 'st-open', TUE_1100, TUE_1130));
    const clash = await failure(
      svc.rescheduleSession(COACH, a.id, {
        start_at: TUE_1115,
        end_at: '2026-10-06T18:45:00.000Z',
      }),
    );
    expect(clash.code).toBe('SLOT_TAKEN');
    notifications.rows = [];
    const evening = await svc.rescheduleSession(COACH, a.id, {
      start_at: '2026-10-07T01:00:00.000Z',
      end_at: '2026-10-07T01:30:00.000Z',
    });
    expect(evening.status).toBe('scheduled');
    expect(notifications.kindsFor('client-1')).toEqual([NotificationKind.BOOKING_RESCHEDULED]);
  });

  it('approving a request whose time has passed is refused (SESSION_STARTED)', async () => {
    const { svc, db } = harness();
    db.addSession({
      id: 'old-req',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-q',
      status: 'requested',
      start_at: new Date('2026-10-05T14:00:00.000Z'),
      end_at: new Date('2026-10-05T14:15:00.000Z'),
    });
    expect((await failure(svc.approveSession(COACH, 'old-req'))).code).toBe('SESSION_STARTED');
    const declined = await svc.declineSession(COACH, 'old-req');
    expect(declined.status).toBe('declined');
  });

  it('client cannot cancel a started session; the coach can; completion waits for the start', async () => {
    const { svc, db } = harness();
    db.addSession({
      id: 'live',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-open',
      status: 'scheduled',
      start_at: new Date('2026-10-05T14:50:00.000Z'),
      end_at: new Date('2026-10-05T15:20:00.000Z'),
    });
    db.addSession({
      id: 'future',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-open',
      status: 'scheduled',
      start_at: new Date(TUE_1000),
      end_at: new Date(TUE_1030),
    });
    expect((await failure(svc.cancelSession(CLIENT, 'live', {}))).code).toBe('SESSION_STARTED');
    expect((await failure(svc.completeSession(COACH, 'future', {}))).code).toBe(
      'SESSION_NOT_ACTIVE',
    );
    expect((await failure(svc.markNoShow(COACH, 'future'))).code).toBe('SESSION_NOT_ACTIVE');
    expect((await svc.completeSession(COACH, 'live', { coach_notes_md: 'Good call' })).status).toBe(
      'completed',
    );
    expect((await failure(svc.cancelSession(COACH, 'live', {}))).code).toBe(
      'SESSION_STATE_CHANGED',
    );
  });

  it('call link: refuses unsafe links, recovers a session waiting on a provider link, tells the client', async () => {
    const { svc, db, notifications } = harness();
    db.addSession({
      id: 'waiting',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-open',
      status: 'pending_provider',
      start_at: new Date(TUE_1000),
      end_at: new Date(TUE_1030),
    });
    for (const bad of ['javascript:alert(1)', 'http://insecure.example.com/room', 'zoom.us/j/1']) {
      expect(
        (await failure(svc.attachManualVideoLink(COACH, 'waiting', { video_url: bad }))).code,
      ).toBe('INVALID_MEETING_LINK');
    }
    const pending = await svc.getSession(CLIENT, 'waiting');
    expect(pending.meeting_link_status).toBe('pending');
    const fixed = await svc.attachManualVideoLink(COACH, 'waiting', {
      video_url: ' https://zoom.example.com/j/123 ',
    });
    expect(fixed).toMatchObject({
      status: 'scheduled',
      video_url: 'https://zoom.example.com/j/123',
      video_provider: 'manual',
      meeting_link_status: 'ready',
    });
    expect(notifications.kindsFor('client-1')).toEqual([NotificationKind.BOOKING_LINK_READY]);
    const phone = await svc.attachManualVideoLink(COACH, 'waiting', {
      video_url: 'tel:+1 425 555 0100',
    });
    expect(phone.meeting_link_status).toBe('ready');
  });

  it('upcoming and past lists are scoped, ordered and paged', async () => {
    const { svc, db } = harness();
    const mk = (id: string, start: string, status: string, clientId = 'client-1') =>
      db.addSession({
        id,
        coach_id: 'coach-1',
        client_id: clientId,
        session_type_id: 'st-open',
        status,
        start_at: new Date(start),
        end_at: new Date(new Date(start).getTime() + 30 * 60_000),
      });
    mk('p1', '2026-09-28T17:00:00.000Z', 'completed');
    mk('p2', '2026-09-30T17:00:00.000Z', 'canceled');
    mk('p3', '2026-10-01T17:00:00.000Z', 'no_show');
    mk('other', '2026-10-02T17:00:00.000Z', 'completed', 'client-2');
    mk('u1', TUE_1000, 'scheduled');
    mk('u0', '2026-10-05T14:45:00.000Z', 'scheduled');

    const past = await svc.listSessionsForActor(CLIENT, { scope: 'past' });
    expect(past.map((s) => s.id)).toEqual(['p3', 'p2', 'p1']);
    const page2 = await svc.listSessionsForActor(CLIENT, {
      scope: 'past',
      limit: 2,
      before: '2026-09-30T17:00:00.000Z',
    });
    expect(page2.map((s) => s.id)).toEqual(['p1']);
    const upcoming = await svc.listSessionsForActor(CLIENT, { scope: 'upcoming' });
    // In-progress session first (ends after now), then the future one.
    expect(upcoming.map((s) => s.id)).toEqual(['u0', 'u1']);
    expect(upcoming[0].cancellable).toBe(false);
    expect(upcoming[1].cancellable).toBe(true);
    const coachPast = await svc.listSessionsForActor(COACH, { scope: 'past' });
    expect(coachPast.map((s) => s.id)).toContain('other');
    expect(
      (await failure(svc.listSessionsForActor(CLIENT, { scope: 'past', before: 'yesterday' })))
        .code,
    ).toBe('INVALID_TIME');
  });

  it('welcome marker: one active welcome type per coach, moved transactionally', async () => {
    const { svc, db } = harness();
    const created = await svc.createSessionType(COACH, {
      name: 'New intro',
      duration_minutes: 20,
      auto_approve: true,
      is_welcome: true,
      default_meeting_url: 'https://meet.example.com/intro',
    });
    expect(created.is_welcome).toBe(true);
    expect(db.sessionTypes.find((t) => t.id === 'st-w')?.is_welcome).toBe(false);
    const back = await svc.updateSessionType(COACH, 'st-w', { is_welcome: true });
    expect(back.is_welcome).toBe(true);
    expect(db.sessionTypes.find((t) => t.id === created.id)?.is_welcome).toBe(false);
    const f = await failure(
      svc.updateSessionType(COACH, 'st-q', { default_meeting_url: 'http://insecure.example.com' }),
    );
    expect(f.code).toBe('INVALID_MEETING_LINK');
    const cleared = await svc.updateSessionType(COACH, 'st-w', { default_meeting_url: '' });
    expect(cleared.default_meeting_url).toBeNull();
  });

  it('every booking notification is plain: no exclamation marks, bounded length', async () => {
    const { svc, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    await svc.approveSession(COACH, s.id);
    await svc.rescheduleSession(COACH, s.id, { start_at: TUE_1100, end_at: TUE_1115 });
    await svc.cancelSession(CLIENT, s.id, {});
    const b = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    await svc.declineSession(COACH, b.id);
    expect(notifications.rows.length).toBeGreaterThanOrEqual(6);
    for (const r of notifications.rows) {
      expect(r.body).not.toMatch(/!/);
      expect(r.body.length).toBeLessThanOrEqual(160);
      expect(r.channel).toBe('inapp');
    }
    for (const p of notifications.pushes) {
      expect(p.title).not.toMatch(/!/);
      expect(p.data.actionParams).toBeDefined();
    }
  });
});
