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
import * as fs from 'fs';
import * as path from 'path';
import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SessionReminderJob } from '../src/scheduling/jobs/reminder.job';
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
  const providers = registry();
  const svc = new SchedulingService(asPrisma(db), audit, providers, emitter);
  const reminder = new SessionReminderJob(asPrisma(db), emitter);
  return { db, notifications, svc, auditWrites, providers, reminder, emitter };
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

  it('bad open-slot queries carry INVALID_TIME and a plain next step', async () => {
    const { svc } = harness();
    const badLength = await failure(
      svc.getOpenSlots(CLIENT, 'coach-1', {
        from: '2026-10-06T16:00:00.000Z',
        to: '2026-10-06T19:00:00.000Z',
        duration_minutes: 900,
      }),
    );
    expect(badLength).toMatchObject({ status: 400, code: 'INVALID_TIME' });
    expect(badLength.message).toMatch(/1 to 480 minutes\)\. Pick an appointment type/);
    const backwards = await failure(
      svc.getOpenSlots(CLIENT, 'coach-1', {
        from: '2026-10-06T19:00:00.000Z',
        to: '2026-10-06T16:00:00.000Z',
        session_type_id: 'st-q',
      }),
    );
    expect(backwards).toMatchObject({ status: 400, code: 'INVALID_TIME' });
    expect(backwards.message).toMatch(
      /^Open times could not be listed: .*at most 14 days apart\.$/,
    );
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
    ).toBe('INVALID_LIST_QUERY');
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

// ─────────────────────────────────────────────────────────────────────────
// S-SCHED-3 fix round: every audit repro on #634 @ dbc10b7b as a regression
// test (Sol 5955780870 B-634-1..4, Opus 5956298627 B-634-5 and C-634-*).
// Each failed on dbc10b7b; the comment on each names the finding.
// ─────────────────────────────────────────────────────────────────────────

/** A pause point: the code under test calls hit() and waits until release(). */
function pausePoint() {
  let entered!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const released = new Promise<void>((r) => {
    resume = r;
  });
  return {
    reached,
    release: () => resume(),
    hit: async () => {
      entered();
      await released;
    },
  };
}

/** Pause the first coachingSession.updateMany whose data matches `when`. */
function pauseSessionWrite(db: SchedulingFakeDb, when: (data: Record<string, unknown>) => boolean) {
  const gate = pausePoint();
  const original = db.coachingSession.updateMany;
  let armed = true;
  db.coachingSession.updateMany = async (args) => {
    if (armed && when(args.data)) {
      armed = false;
      await gate.hit();
    }
    return original(args);
  };
  return gate;
}

function withReminders<T>(fn: () => Promise<T>): Promise<T> {
  const old = process.env.BOOKING_REMINDERS_ENABLED;
  process.env.BOOKING_REMINDERS_ENABLED = 'on';
  return fn().finally(() => {
    if (old === undefined) delete process.env.BOOKING_REMINDERS_ENABLED;
    else process.env.BOOKING_REMINDERS_ENABLED = old;
  });
}

describe('S-SCHED-3 B-634-1: transitions are fenced on the booking revision, not only status', () => {
  it('a paused approval loses to a client move: SESSION_MOVED, the new request time stands, no stale confirmation', async () => {
    const { svc, db, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const gate = pauseSessionWrite(db, (d) => d.status === 'scheduled' && !!d.approved_at);
    const approving = Promise.allSettled([svc.approveSession(COACH, s.id)]);
    await gate.reached;
    await svc.rescheduleSession(CLIENT, s.id, { start_at: TUE_1100, end_at: TUE_1115 });
    gate.release();
    const [result] = await approving;
    expect(rejectionCode(result)).toBe('SESSION_MOVED');
    const row = db.sessions.find((r) => r.id === s.id);
    expect(row?.status).toBe('requested');
    expect((row?.start_at as Date).toISOString()).toBe(TUE_1100);
    expect(notifications.kindsFor('client-1')).not.toContain(NotificationKind.BOOKING_CONFIRMED);

    // The coach refreshes and approves the time they now see; the
    // confirmation names that committed time.
    const ok = await svc.approveSession(COACH, s.id, { expectedStartAt: TUE_1100 });
    expect(ok.status).toBe('scheduled');
    const confirm = notifications.pushes.find(
      (p) => p.userId === 'client-1' && p.data.kind === NotificationKind.BOOKING_CONFIRMED,
    );
    expect(confirm?.body).toContain('11:00 AM');
    expect(confirm?.body).not.toContain('10:00 AM');
  });

  it('a paused decline loses to a client move: SESSION_MOVED and the moved request stays in the inbox', async () => {
    const { svc, db, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const gate = pauseSessionWrite(db, (d) => d.status === 'declined');
    const declining = Promise.allSettled([svc.declineSession(COACH, s.id, 'busy')]);
    await gate.reached;
    await svc.rescheduleSession(CLIENT, s.id, { start_at: TUE_1100, end_at: TUE_1115 });
    gate.release();
    expect(rejectionCode((await declining)[0])).toBe('SESSION_MOVED');
    expect(db.sessions.find((r) => r.id === s.id)?.status).toBe('requested');
    expect(notifications.kindsFor('client-1')).not.toContain(NotificationKind.BOOKING_DECLINED);
  });

  it('a paused coach cancel loses to a client move of the same request', async () => {
    const { svc, db } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const gate = pauseSessionWrite(db, (d) => d.status === 'canceled');
    const cancelling = Promise.allSettled([svc.cancelSession(COACH, s.id, {})]);
    await gate.reached;
    await svc.rescheduleSession(CLIENT, s.id, { start_at: TUE_1100, end_at: TUE_1115 });
    gate.release();
    expect(rejectionCode((await cancelling)[0])).toBe('SESSION_MOVED');
    expect(db.sessions.find((r) => r.id === s.id)?.status).toBe('requested');
  });

  it('a stale inbox card (expected_start_at) is refused before any write, for approve, decline and cancel', async () => {
    const { svc, db } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    await svc.rescheduleSession(CLIENT, s.id, { start_at: TUE_1100, end_at: TUE_1115 });
    const approve = await failure(svc.approveSession(COACH, s.id, { expectedStartAt: TUE_1000 }));
    expect(approve).toMatchObject({ status: 409, code: 'SESSION_MOVED' });
    expect(approve.message).toMatch(/new time/);
    expect(
      (await failure(svc.declineSession(COACH, s.id, undefined, { expectedStartAt: TUE_1000 })))
        .code,
    ).toBe('SESSION_MOVED');
    expect(
      (await failure(svc.cancelSession(COACH, s.id, { expected_start_at: TUE_1000 }))).code,
    ).toBe('SESSION_MOVED');
    expect(
      (await failure(svc.approveSession(COACH, s.id, { expectedStartAt: 'not-a-time' }))).code,
    ).toBe('INVALID_TIME');
    expect(db.sessions.find((r) => r.id === s.id)?.status).toBe('requested');
  });
});

describe('S-SCHED-3 B-634-3: provisioning never overwrites a newer change', () => {
  function pauseCalendar(
    providers: SchedulingProviderRegistry,
    result?: { id: string; provider: string },
  ) {
    const adapter = providers.resolveCalendar('stub');
    const original = adapter.createEvent.bind(adapter);
    const gate = pausePoint();
    adapter.createEvent = async (input) => {
      await gate.hit();
      const r = await original(input);
      return result
        ? {
            externalEventId: result.id,
            resolvedProvider: result.provider as typeof r.resolvedProvider,
          }
        : r;
    };
    return gate;
  }

  it('a manual link saved while provisioning runs is kept (Sol probe), and the coach is not asked for a link', async () => {
    const { svc, db, providers, notifications } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const gate = pauseCalendar(providers);
    const approving = svc.approveSession(COACH, s.id);
    await gate.reached;
    await svc.attachManualVideoLink(COACH, s.id, {
      video_url: 'https://meet.example.com/new-room',
    });
    gate.release();
    const final = await approving;
    expect(final.video_url).toBe('https://meet.example.com/new-room');
    const row = db.sessions.find((r) => r.id === s.id);
    expect(row?.video_url).toBe('https://meet.example.com/new-room');
    expect(row?.video_provider).toBe('manual');
    expect(row?.calendar_event_id).toMatch(/^stub-cal-/);
    expect(notifications.kindsFor('coach-1')).not.toContain(NotificationKind.BOOKING_LINK_NEEDED);
  });

  it('a cancel during provisioning stands: no overwrite, no confirmation, the new calendar event is cancelled', async () => {
    const { svc, db, providers, notifications, auditWrites } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    // The adapter reports a real (non-stub) calendar event, as Google would.
    const gate = pauseCalendar(providers, { id: 'gcal-evt-1', provider: 'google_calendar' });
    const cancelEvent = jest.fn(async (_id: string) => undefined);
    providers.resolveCalendar('google_calendar').cancelEvent = cancelEvent;
    const approving = svc.approveSession(COACH, s.id);
    await gate.reached;
    await svc.cancelSession(CLIENT, s.id, { reason: 'plans changed' });
    gate.release();
    const final = await approving;
    expect(final.status).toBe('canceled');
    const row = db.sessions.find((r) => r.id === s.id);
    expect(row?.status).toBe('canceled');
    expect(row?.calendar_event_id).toBeNull();
    expect(cancelEvent).toHaveBeenCalledWith('gcal-evt-1');
    expect(notifications.kindsFor('client-1')).not.toContain(NotificationKind.BOOKING_CONFIRMED);
    expect(notifications.kindsFor('coach-1')).not.toContain(NotificationKind.BOOKING_LINK_NEEDED);
    expect(JSON.stringify(auditWrites)).toContain('superseded_revision');
  });

  it('a move during instant-confirm provisioning keeps the new time and the confirmation names it', async () => {
    const { svc, db, providers, notifications } = harness();
    const gate = pauseCalendar(providers);
    const booking = svc.requestSession(CLIENT, request(CLIENT, 'st-open', TUE_1000, TUE_1030));
    await gate.reached;
    const created = db.sessions.find((r) => r.client_id === 'client-1' && r.status === 'scheduled');
    expect(created).toBeDefined();
    await svc.rescheduleSession(COACH, String(created?.id), {
      start_at: TUE_1100,
      end_at: TUE_1130,
    });
    gate.release();
    const final = await booking;
    expect(new Date(final.start_at).toISOString()).toBe(TUE_1100);
    const row = db.sessions.find((r) => r.id === created?.id);
    expect((row?.start_at as Date).toISOString()).toBe(TUE_1100);
    const confirm = notifications.pushes.find(
      (p) => p.userId === 'client-1' && p.data.kind === NotificationKind.BOOKING_CONFIRMED,
    );
    expect(confirm?.body).toContain('11:00 AM');
  });
});

describe('S-SCHED-3 B-634-4 / C-634-3: keyset pages on (start_at, id); status filter', () => {
  it('21 past rows sharing one start time page as 20 + 1 with no repeats (Sol probe)', async () => {
    const { svc, db } = harness();
    for (let i = 0; i < 21; i++) {
      db.addSession({
        id: `past-tie-${String(i).padStart(2, '0')}`,
        coach_id: 'coach-1',
        client_id: 'client-1',
        session_type_id: 'st-q',
        status: 'canceled',
        start_at: new Date('2026-09-30T17:00:00.000Z'),
        end_at: new Date('2026-09-30T17:15:00.000Z'),
      });
    }
    const first = await svc.listSessionsForActor(CLIENT, { scope: 'past', limit: 20 });
    const last = first[first.length - 1];
    const next = await svc.listSessionsForActor(CLIENT, {
      scope: 'past',
      limit: 20,
      before: new Date(last.start_at).toISOString(),
      before_id: last.id,
    });
    expect(first).toHaveLength(20);
    expect(next).toHaveLength(1);
    const ids = [...first, ...next].map((s) => s.id);
    expect(new Set(ids).size).toBe(21);
  });

  it('limit 1 walks a tie and the row after it in order (Opus probe)', async () => {
    const { svc, db } = harness();
    const T = new Date('2026-09-30T17:00:00.000Z');
    const end = new Date(T.getTime() + 15 * 60_000);
    db.addSession({
      id: 'tie-a',
      coach_id: 'coach-1',
      client_id: 'client-2',
      status: 'declined',
      start_at: T,
      end_at: end,
    });
    db.addSession({
      id: 'tie-b',
      coach_id: 'coach-1',
      client_id: 'client-2',
      status: 'completed',
      start_at: T,
      end_at: end,
    });
    db.addSession({
      id: 'early',
      coach_id: 'coach-1',
      client_id: 'client-2',
      status: 'completed',
      start_at: new Date('2026-09-29T17:00:00.000Z'),
      end_at: new Date('2026-09-29T17:15:00.000Z'),
    });
    const seen: string[] = [];
    let cursor: { before: string; before_id: string } | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await svc.listSessionsForActor(CLIENT_2, {
        scope: 'past',
        limit: 1,
        ...(cursor ?? {}),
      });
      if (page.length === 0) break;
      seen.push(page[0].id);
      cursor = { before: new Date(page[0].start_at).toISOString(), before_id: page[0].id };
    }
    expect(seen).toEqual(['tie-b', 'tie-a', 'early']);
  });

  it('upcoming pages with after/after_id and the inbox filter returns only requests', async () => {
    const { svc, db } = harness();
    const T = new Date(TUE_1000);
    const end = new Date(T.getTime() + 15 * 60_000);
    for (let i = 0; i < 5; i++) {
      db.addSession({
        id: `c-${i}`,
        coach_id: 'coach-1',
        client_id: 'client-2',
        status: 'canceled',
        start_at: T,
        end_at: end,
      });
    }
    db.addSession({
      id: 'r-1',
      coach_id: 'coach-1',
      client_id: 'client-2',
      status: 'requested',
      start_at: new Date(TUE_1100),
      end_at: new Date(TUE_1115),
    });
    const inbox = await svc.listSessionsForActor(COACH, {
      scope: 'upcoming',
      limit: 2,
      statuses: ['requested'],
    });
    expect(inbox.map((s) => s.id)).toEqual(['r-1']);
    const p1 = await svc.listSessionsForActor(COACH, { scope: 'upcoming', limit: 3 });
    const tail = p1[p1.length - 1];
    const p2 = await svc.listSessionsForActor(COACH, {
      scope: 'upcoming',
      limit: 10,
      after: new Date(tail.start_at).toISOString(),
      after_id: tail.id,
    });
    expect([...p1, ...p2].map((s) => s.id)).toEqual(['c-0', 'c-1', 'c-2', 'c-3', 'c-4', 'r-1']);
  });

  it('unreadable cursors are a coded 400 with a next step', async () => {
    const { svc } = harness();
    for (const args of [
      { scope: 'past' as const, before: 'yesterday' },
      { scope: 'past' as const, before_id: 'abc' },
      { scope: 'past' as const, before: TUE_1000, before_id: "x' OR 1=1" },
      { scope: 'upcoming' as const, after: 'soon' },
    ]) {
      const f = await failure(svc.listSessionsForActor(CLIENT, args));
      expect(f).toMatchObject({ status: 400, code: 'INVALID_LIST_QUERY' });
      expect(f.message).toMatch(/Reload the list/);
    }
  });
});

describe('S-SCHED-3 B-634-5: restoring an archived former welcome type', () => {
  it('restores as a regular type when another welcome type is active; explicit is_welcome moves the marker', async () => {
    const { svc, db } = harness();
    await svc.updateSessionType(COACH, 'st-w', { archived: true });
    const fresh = await svc.createSessionType(COACH, {
      name: 'New welcome',
      duration_minutes: 15,
      auto_approve: true,
      is_welcome: true,
    });
    const restored = await svc.updateSessionType(COACH, 'st-w', { archived: false });
    expect(restored.archived_at).toBeNull();
    expect(restored.is_welcome).toBe(false);
    expect(db.sessionTypes.find((t) => t.id === fresh.id)?.is_welcome).toBe(true);

    const moved = await svc.updateSessionType(COACH, 'st-w', { is_welcome: true });
    expect(moved.is_welcome).toBe(true);
    expect(db.sessionTypes.find((t) => t.id === fresh.id)?.is_welcome).toBe(false);
  });

  it('restores as the welcome type when no other welcome type is active', async () => {
    const { svc } = harness();
    await svc.updateSessionType(COACH, 'st-w', { archived: true });
    const restored = await svc.updateSessionType(COACH, 'st-w', { archived: false });
    expect(restored).toMatchObject({ archived_at: null, is_welcome: true });
  });
});

describe('S-SCHED-3 B-634-2: reminder delivery is recoverable and channel-aware', () => {
  function dueSession(db: SchedulingFakeDb, id = 'rem-1', minutes = 60) {
    return db.addSession({
      id,
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-q',
      status: 'scheduled',
      start_at: new Date(NOW.getTime() + minutes * 60_000),
      end_at: new Date(NOW.getTime() + (minutes + 15) * 60_000),
      video_url: 'https://meet.example.com/kim',
    });
  }
  const remindersFor = (n: FakeNotifications) =>
    n.rows.filter((r) => r.kind === NotificationKind.BOOKING_REMINDER_1H);

  it('both channels fail, then recover: the next sweep delivers to both recipients (Sol probe)', async () => {
    const { db, notifications, reminder } = harness();
    dueSession(db);
    notifications.createNotification.mockRejectedValueOnce(new Error('temporary db outage'));
    notifications.createNotification.mockRejectedValueOnce(new Error('temporary db outage'));
    notifications.pushToUser.mockRejectedValueOnce(new Error('temporary push outage'));
    notifications.pushToUser.mockRejectedValueOnce(new Error('temporary push outage'));
    await withReminders(async () => {
      await reminder.runOneHourReminderSweep();
      expect(remindersFor(notifications)).toHaveLength(0);
      expect(db.deliveryLogs.map((l) => l.status)).toEqual(['retry', 'retry']);
      await reminder.runOneHourReminderSweep();
      expect(remindersFor(notifications)).toHaveLength(2);
      expect(notifications.pushes).toHaveLength(2);
      expect(db.deliveryLogs.map((l) => l.status)).toEqual(['sent', 'sent']);
      await reminder.runOneHourReminderSweep();
      expect(remindersFor(notifications)).toHaveLength(2);
    });
  });

  it('partial failure retries only the failed channel; the retried push links the first in-app row', async () => {
    const { db, notifications, reminder, emitter } = harness();
    dueSession(db);
    notifications.pushToUser.mockResolvedValueOnce({ delivered: false, code: 'transport-error' });
    await withReminders(async () => {
      const first = await reminder.dispatchWindow({
        lowerOffsetMinutes: 55,
        upperOffsetMinutes: 65,
        kind: NotificationKind.BOOKING_REMINDER_1H,
        emit: (r, o, s, ctx) =>
          emitter.emitReminder1h({
            recipientUserId: r,
            otherPartyDisplayName: o,
            sessionId: s.id,
            scheduledAt: s.start_at,
            ...ctx,
          }),
      });
      expect(first).toMatchObject({ dispatched: 1, retrying: 1, failed: 0 });
      expect(remindersFor(notifications)).toHaveLength(2);
      await reminder.runOneHourReminderSweep();
      expect(remindersFor(notifications)).toHaveLength(2);
      const clientPushes = notifications.pushes.filter((p) => p.userId === 'client-1');
      expect(clientPushes).toHaveLength(1);
      const clientRow = db.deliveryLogs.find((l) => l.user_id === 'client-1');
      expect(clientRow).toMatchObject({ status: 'sent', attempts: 2 });
      expect(clientPushes[0].data.notificationId).toBe(clientRow?.notification_id);
    });
  });

  it('a worker that died after claiming is taken over once its lease expires; a live lease is left alone', async () => {
    const { db, notifications, reminder } = harness();
    const s = dueSession(db);
    db.deliveryLogs.push(
      {
        id: 'stuck',
        session_id: s.id,
        user_id: 'client-1',
        kind: NotificationKind.BOOKING_REMINDER_1H,
        status: 'sending',
        attempts: 1,
        lease_until: new Date(NOW.getTime() - 60_000),
        claim_token: 'dead-worker',
        session_start_at: s.start_at,
        inapp_done_at: null,
        push_done_at: null,
        notification_id: null,
      },
      {
        id: 'live',
        session_id: s.id,
        user_id: 'coach-1',
        kind: NotificationKind.BOOKING_REMINDER_1H,
        status: 'sending',
        attempts: 1,
        lease_until: new Date(NOW.getTime() + 60_000),
        claim_token: 'other-replica',
        session_start_at: s.start_at,
        inapp_done_at: null,
        push_done_at: null,
        notification_id: null,
      },
    );
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(remindersFor(notifications).map((r) => r.user_id)).toEqual(['client-1']);
    expect(db.deliveryLogs.find((l) => l.id === 'stuck')).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
    expect(db.deliveryLogs.find((l) => l.id === 'live')).toMatchObject({
      status: 'sending',
      claim_token: 'other-replica',
    });
  });

  it('a database error on claim is a failure, not a duplicate; the next sweep delivers', async () => {
    const { db, notifications, reminder } = harness();
    dueSession(db);
    const create = db.notificationDeliveryLog.create;
    let failNext = 2;
    db.notificationDeliveryLog.create = async (args) => {
      if (failNext-- > 0) throw Object.assign(new TypeError('connection reset'), { code: 'P1017' });
      return create(args);
    };
    await withReminders(async () => {
      const r1 = await reminder.dispatchWindow({
        lowerOffsetMinutes: 55,
        upperOffsetMinutes: 65,
        kind: NotificationKind.BOOKING_REMINDER_1H,
        emit: async () => ({ inapp: 'written', push: 'delivered' }),
      });
      expect(r1).toMatchObject({ dispatched: 0, skipped: 0, failed: 2 });
      await reminder.runOneHourReminderSweep();
      expect(remindersFor(notifications)).toHaveLength(2);
    });
  });

  it('preference suppression and no device are settled answers, never retried', async () => {
    const { db, notifications, reminder } = harness();
    dueSession(db);
    notifications.prefs.set('client-1', { muted: true });
    notifications.pushResult = { delivered: false, code: 'no-token' };
    await withReminders(async () => {
      await reminder.runOneHourReminderSweep();
      await reminder.runOneHourReminderSweep();
    });
    expect(remindersFor(notifications).map((r) => r.user_id)).toEqual(['coach-1']);
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(db.deliveryLogs.map((l) => [l.user_id, l.status, l.attempts])).toEqual([
      ['client-1', 'sent', 1],
      ['coach-1', 'sent', 1],
    ]);
  });

  it('two replicas sweeping at once deliver exactly once per recipient', async () => {
    const { db, notifications, reminder, emitter } = harness();
    const replica = new SessionReminderJob(asPrisma(db), emitter);
    dueSession(db);
    await withReminders(() =>
      Promise.all([reminder.runOneHourReminderSweep(), replica.runOneHourReminderSweep()]),
    );
    expect(remindersFor(notifications)).toHaveLength(2);
    expect(notifications.pushes).toHaveLength(2);
  });

  it('a claim for an older start time is a new revision: the moved session is reminded for its new time', async () => {
    const { db, notifications, reminder } = harness();
    const s = dueSession(db);
    db.deliveryLogs.push({
      id: 'old-time',
      session_id: s.id,
      user_id: 'client-1',
      kind: NotificationKind.BOOKING_REMINDER_1H,
      status: 'sent',
      attempts: 1,
      lease_until: null,
      claim_token: 'old',
      session_start_at: new Date(NOW.getTime() + 24 * 60 * 60_000),
      inapp_done_at: NOW,
      push_done_at: NOW,
      notification_id: 'n-old',
    });
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(
      remindersFor(notifications)
        .map((r) => r.user_id)
        .sort(),
    ).toEqual(['client-1', 'coach-1']);
    expect(db.deliveryLogs.find((l) => l.id === 'old-time')).toMatchObject({
      status: 'sent',
      session_start_at: s.start_at,
    });
  });

  it('a session cancelled after the sweep read it is not reminded, and its claim is released', async () => {
    const { db, notifications, reminder, svc } = harness();
    dueSession(db);
    const findMany = db.coachingSession.findMany;
    db.coachingSession.findMany = async (args) => {
      const rows = await findMany(args);
      await svc.cancelSession(COACH, 'rem-1', { reason: 'sick' });
      return rows;
    };
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(remindersFor(notifications)).toHaveLength(0);
    expect(db.deliveryLogs).toHaveLength(0);
  });

  it('gives up after the attempt limit and says so', async () => {
    const { db, notifications, reminder } = harness();
    dueSession(db);
    notifications.pushResult = { delivered: false, code: 'transport-error' };
    await withReminders(async () => {
      for (let i = 0; i < 5; i++) await reminder.runOneHourReminderSweep();
    });
    expect(db.deliveryLogs.map((l) => [l.status, l.attempts])).toEqual([
      ['gave_up', 3],
      ['gave_up', 3],
    ]);
    expect(notifications.pushToUser).toHaveBeenCalledTimes(6);
    expect(remindersFor(notifications)).toHaveLength(2);
    expect(String(db.deliveryLogs[0].last_error)).toContain('push');
  });
});

describe('S-SCHED-4 B-634-2: unfinished reminders are recovered on the next real tick, after the band', () => {
  const MIN = 60_000;
  function confirmed(
    db: SchedulingFakeDb,
    id: string,
    startMinutes: number,
    clientId = 'client-1',
    status = 'scheduled',
  ): { id: string; start_at: Date } {
    const start_at = new Date(NOW.getTime() + startMinutes * MIN);
    db.addSession({
      id,
      coach_id: 'coach-1',
      client_id: clientId,
      session_type_id: 'st-q',
      status,
      start_at,
      end_at: new Date(NOW.getTime() + (startMinutes + 15) * MIN),
      video_url: 'https://meet.example.com/kim',
    });
    return { id, start_at };
  }
  function logRow(
    over: Partial<Record<string, unknown>> & { id: string; session_id: string; user_id: string },
  ) {
    return {
      kind: NotificationKind.BOOKING_REMINDER_1H,
      status: 'retry',
      attempts: 1,
      lease_until: null,
      claim_token: `tok-${over.id}`,
      session_start_at: null,
      inapp_done_at: null,
      push_done_at: null,
      notification_id: null,
      last_error: null,
      created_at: NOW,
      ...over,
    };
  }
  // Run at a later wall clock (the real cron cadence), then restore NOW.
  async function at<T>(offsetMinutes: number, fn: () => Promise<T>): Promise<T> {
    jest.setSystemTime(new Date(NOW.getTime() + offsetMinutes * MIN));
    try {
      return await withReminders(fn);
    } finally {
      jest.setSystemTime(NOW);
    }
  }
  const ofKind = (n: FakeNotifications, kind: string) => n.rows.filter((r) => r.kind === kind);

  it('1h: both recipients fail at the final tick (start in 55m); the +5m tick delivers both (Sol counterexample)', async () => {
    const { db, notifications, reminder } = harness();
    confirmed(db, 'edge-1h', 55);
    notifications.createNotification.mockRejectedValueOnce(new Error('temporary db outage'));
    notifications.createNotification.mockRejectedValueOnce(new Error('temporary db outage'));
    notifications.pushToUser.mockRejectedValueOnce(new Error('temporary push outage'));
    notifications.pushToUser.mockRejectedValueOnce(new Error('temporary push outage'));
    await at(0, () => reminder.runOneHourReminderSweep());
    expect(db.deliveryLogs.map((l) => [l.status, l.attempts])).toEqual([
      ['retry', 1],
      ['retry', 1],
    ]);
    // +5m: the session (now 50m away) has left [55m, 65m].
    await at(5, () => reminder.runOneHourReminderSweep());
    expect(
      ofKind(notifications, NotificationKind.BOOKING_REMINDER_1H)
        .map((r) => r.user_id)
        .sort(),
    ).toEqual(['client-1', 'coach-1']);
    expect(notifications.pushes).toHaveLength(2);
    expect(db.deliveryLogs.map((l) => [l.status, l.attempts])).toEqual([
      ['sent', 2],
      ['sent', 2],
    ]);
    // Settled: later ticks do nothing more.
    await at(10, () => reminder.runOneHourReminderSweep());
    expect(ofKind(notifications, NotificationKind.BOOKING_REMINDER_1H)).toHaveLength(2);
    expect(notifications.pushes).toHaveLength(2);
  });

  it('24h: both recipients fail at the final tick (start in 23h45m); the +15m tick delivers both', async () => {
    const { db, notifications, reminder } = harness();
    confirmed(db, 'edge-24h', 24 * 60 - 15);
    notifications.createNotification.mockRejectedValueOnce(new Error('temporary db outage'));
    notifications.createNotification.mockRejectedValueOnce(new Error('temporary db outage'));
    notifications.pushToUser.mockRejectedValueOnce(new Error('temporary push outage'));
    notifications.pushToUser.mockRejectedValueOnce(new Error('temporary push outage'));
    await at(0, () => reminder.runTwentyFourHourReminderSweep());
    expect(db.deliveryLogs.map((l) => l.status)).toEqual(['retry', 'retry']);
    await at(15, () => reminder.runTwentyFourHourReminderSweep());
    const sent = ofKind(notifications, NotificationKind.BOOKING_REMINDER_24H);
    expect(sent.map((r) => r.user_id).sort()).toEqual(['client-1', 'coach-1']);
    expect(db.deliveryLogs.map((l) => [l.status, l.attempts])).toEqual([
      ['sent', 2],
      ['sent', 2],
    ]);
  });

  it('partial failure at the final tick: the next tick re-sends only the push, linked to the first in-app row', async () => {
    const { db, notifications, reminder } = harness();
    confirmed(db, 'edge-push', 55);
    notifications.pushToUser.mockResolvedValueOnce({ delivered: false, code: 'transport-error' });
    await at(0, () => reminder.runOneHourReminderSweep());
    const failed = db.deliveryLogs.find((l) => l.status === 'retry');
    expect(failed).toBeDefined();
    const firstInApp = failed?.notification_id;
    expect(firstInApp).toBeTruthy();
    await at(5, () => reminder.runOneHourReminderSweep());
    expect(ofKind(notifications, NotificationKind.BOOKING_REMINDER_1H)).toHaveLength(2);
    const retried = db.deliveryLogs.find((l) => l.id === failed?.id);
    expect(retried).toMatchObject({ status: 'sent', attempts: 2, notification_id: firstInApp });
    const pushes = notifications.pushes.filter((p) => p.userId === failed?.user_id);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].data.notificationId).toBe(firstInApp);
  });

  it('worker crash at the final tick: a live lease is left alone, the expired lease is taken over on the next tick', async () => {
    const { db, notifications, reminder } = harness();
    const s = confirmed(db, 'edge-crash', 55);
    db.deliveryLogs.push(
      logRow({
        id: 'dead',
        session_id: s.id,
        user_id: 'client-1',
        status: 'sending',
        lease_until: new Date(NOW.getTime() + 4 * MIN),
        claim_token: 'dead-worker',
        session_start_at: s.start_at,
      }),
      logRow({
        id: 'done',
        session_id: s.id,
        user_id: 'coach-1',
        status: 'sent',
        session_start_at: s.start_at,
        inapp_done_at: NOW,
        push_done_at: NOW,
      }),
    );
    // +3m: the dead worker's lease is still live; nothing is sent.
    await at(3, () => reminder.runOneHourReminderSweep());
    expect(ofKind(notifications, NotificationKind.BOOKING_REMINDER_1H)).toHaveLength(0);
    expect(db.deliveryLogs.find((l) => l.id === 'dead')).toMatchObject({
      status: 'sending',
      claim_token: 'dead-worker',
    });
    // +5m: lease expired, session 50m away (outside the band): recovered,
    // and only for the recipient whose work was unfinished.
    await at(5, () => reminder.runOneHourReminderSweep());
    expect(
      ofKind(notifications, NotificationKind.BOOKING_REMINDER_1H).map((r) => r.user_id),
    ).toEqual(['client-1']);
    expect(db.deliveryLogs.find((l) => l.id === 'dead')).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
    expect(db.deliveryLogs.find((l) => l.id === 'done')).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
  });

  it('a recovered session never claims a recipient that had no unfinished work', async () => {
    const { db, notifications, reminder } = harness();
    const s = confirmed(db, 'edge-one', 50);
    db.deliveryLogs.push(
      logRow({
        id: 'r-client',
        session_id: s.id,
        user_id: 'client-1',
        session_start_at: s.start_at,
      }),
    );
    const result = await at(0, () =>
      reminder.dispatchWindow({
        lowerOffsetMinutes: 55,
        upperOffsetMinutes: 65,
        kind: NotificationKind.BOOKING_REMINDER_1H,
        emit: async () => ({ inapp: 'written', push: 'delivered' }),
      }),
    );
    expect(result).toMatchObject({ scanned: 1, recovered: 1, dispatched: 1, retired: 0 });
    expect(db.deliveryLogs.map((l) => l.user_id)).toEqual(['client-1']);
    expect(notifications.rows).toHaveLength(0);
  });

  it('retires work that can never be sent, keeps its receipts, and sends nothing', async () => {
    const { db, notifications, reminder } = harness();
    const cancelled = confirmed(db, 'gone-cancelled', 40, 'client-1', 'canceled');
    const started = confirmed(db, 'gone-started', -5, 'client-2');
    const exhausted = confirmed(db, 'gone-exhausted', 45, 'client-3');
    const reassigned = confirmed(db, 'gone-recipient', 48, 'client-4');
    const superseded = confirmed(db, 'gone-superseded', 30, 'client-5');
    const later = confirmed(db, 'moved-later', 300, 'client-6');
    db.deliveryLogs.push(
      logRow({
        id: 'x-cancelled',
        session_id: cancelled.id,
        user_id: 'client-1',
        session_start_at: cancelled.start_at,
        inapp_done_at: NOW,
        notification_id: 'n-kept',
      }),
      logRow({
        id: 'x-started',
        session_id: started.id,
        user_id: 'client-2',
        session_start_at: started.start_at,
      }),
      logRow({
        id: 'x-exhausted',
        session_id: exhausted.id,
        user_id: 'client-3',
        status: 'sending',
        attempts: 3,
        lease_until: new Date(NOW.getTime() - MIN),
        session_start_at: exhausted.start_at,
      }),
      logRow({
        id: 'x-recipient',
        session_id: reassigned.id,
        user_id: 'client-1',
        session_start_at: reassigned.start_at,
      }),
      // Claimed for an older start; the new start (30m) is past its band.
      logRow({
        id: 'x-superseded',
        session_id: superseded.id,
        user_id: 'client-5',
        session_start_at: new Date(NOW.getTime() + 24 * 60 * MIN),
      }),
      // Claimed for an older start; the new start is still ahead of its
      // band, so the band pass re-arms it later. S-SCHED-5: it is parked
      // (receipts kept) so it can never pin the recovery page.
      logRow({
        id: 'x-later',
        session_id: later.id,
        user_id: 'client-6',
        session_start_at: new Date(NOW.getTime() + 55 * MIN),
      }),
    );
    const result = await at(0, () => reminder.runOneHourReminderSweep().then(() => null));
    expect(result).toBeNull();
    expect(notifications.rows).toHaveLength(0);
    expect(notifications.pushes).toHaveLength(0);
    const byId = (id: string) => db.deliveryLogs.find((l) => l.id === id);
    expect(byId('x-cancelled')).toMatchObject({
      status: 'gave_up',
      last_error: 'retired:session_cancelled',
      inapp_done_at: NOW,
      notification_id: 'n-kept',
    });
    expect(byId('x-started')).toMatchObject({
      status: 'gave_up',
      last_error: 'retired:session_started',
    });
    expect(byId('x-exhausted')).toMatchObject({
      status: 'gave_up',
      attempts: 3,
      lease_until: null,
      last_error: 'retired:attempts_exhausted',
    });
    expect(byId('x-recipient')).toMatchObject({
      status: 'gave_up',
      last_error: 'retired:recipient_changed',
    });
    expect(byId('x-superseded')).toMatchObject({
      status: 'gave_up',
      last_error: 'retired:superseded',
    });
    expect(byId('x-later')).toMatchObject({ status: 'parked', last_error: 'parked:moved_later' });
  });

  it('a 24h reminder still unfinished when the 1h band is reached is retired, never sent as "tomorrow"', async () => {
    const { db, notifications, reminder } = harness();
    const s = confirmed(db, 'late-24h', 50);
    db.deliveryLogs.push(
      logRow({
        id: 'late',
        session_id: s.id,
        user_id: 'client-1',
        kind: NotificationKind.BOOKING_REMINDER_24H,
        session_start_at: s.start_at,
      }),
    );
    await at(0, () => reminder.runTwentyFourHourReminderSweep());
    expect(ofKind(notifications, NotificationKind.BOOKING_REMINDER_24H)).toHaveLength(0);
    expect(db.deliveryLogs[0]).toMatchObject({
      status: 'gave_up',
      last_error: 'retired:superseded',
    });
  });

  it('a taken-over row whose session is cancelled mid-claim keeps its receipts (closed, not deleted)', async () => {
    const { db, notifications, reminder, svc } = harness();
    const s = confirmed(db, 'mid-cancel', 50);
    db.deliveryLogs.push(
      logRow({
        id: 'mid',
        session_id: s.id,
        user_id: 'client-1',
        session_start_at: s.start_at,
        inapp_done_at: NOW,
        notification_id: 'n-first',
      }),
    );
    const findFirst = db.notificationDeliveryLog.findFirst;
    db.notificationDeliveryLog.findFirst = async (args) => {
      const row = await findFirst(args);
      await svc.cancelSession(COACH, s.id, { reason: 'sick' });
      db.notificationDeliveryLog.findFirst = findFirst;
      return row;
    };
    await at(0, () => reminder.runOneHourReminderSweep());
    expect(ofKind(notifications, NotificationKind.BOOKING_REMINDER_1H)).toHaveLength(0);
    expect(db.deliveryLogs.find((l) => l.id === 'mid')).toMatchObject({
      status: 'gave_up',
      inapp_done_at: NOW,
      notification_id: 'n-first',
      last_error: 'retired:session_cancelled',
    });
  });
});

/**
 * S-SCHED-5 (Sol re-audit @ d1661ab8): the three executed probes in
 * ops/aud-sol3-112/backend634-independent-boundaries.spec.ts as regression
 * tests, plus their 24h and safety counterparts. Each fails on d1661ab8.
 */
describe('S-SCHED-5 B-634-2 / B-634-6: missed first claims, fair recovery, safe diagnostics', () => {
  const MIN = 60_000;
  function confirmed(
    db: SchedulingFakeDb,
    id: string,
    startMinutes: number,
    coachId = 'coach-1',
    over: Record<string, unknown> = {},
  ): Date {
    const start = new Date(NOW.getTime() + startMinutes * MIN);
    db.addSession({
      id,
      coach_id: coachId,
      client_id: 'client-1',
      session_type_id: 'st-q',
      status: 'scheduled',
      start_at: start,
      end_at: new Date(start.getTime() + 15 * MIN),
      video_url: 'https://meet.example.com/r5',
      ...over,
    });
    return start;
  }
  function retryRow(
    id: string,
    sessionId: string,
    forStart: Date,
    createdAt = NOW,
    kind: string = NotificationKind.BOOKING_REMINDER_1H,
  ) {
    return {
      id,
      session_id: sessionId,
      user_id: 'client-1',
      kind,
      status: 'retry',
      attempts: 1,
      lease_until: null,
      claim_token: `token-${id}`,
      session_start_at: forStart,
      inapp_done_at: null,
      push_done_at: null,
      notification_id: null,
      last_error: null,
      created_at: createdAt,
    };
  }
  function failInserts(db: SchedulingFakeDb, message = 'synthetic pool timeout before insert') {
    const create = db.notificationDeliveryLog.create;
    db.notificationDeliveryLog.create = async () => {
      throw new Prisma.PrismaClientKnownRequestError(message, {
        code: 'P2024',
        clientVersion: 'test',
      });
    };
    return () => {
      db.notificationDeliveryLog.create = create;
    };
  }
  afterEach(() => jest.setSystemTime(NOW));

  it('1h: both first-claim inserts fail at the final due tick (55m); the next real tick (50m) delivers both (Sol probe)', async () => {
    const { db, notifications, reminder } = harness();
    confirmed(db, 'claim-failed-edge', 55);
    const restore = failInserts(db);
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(db.deliveryLogs).toHaveLength(0);
    restore();
    jest.setSystemTime(new Date(NOW.getTime() + 5 * MIN));
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(notifications.rows).toHaveLength(2);
    expect(notifications.pushes).toHaveLength(2);
    expect(db.deliveryLogs.map((l) => l.status)).toEqual(['sent', 'sent']);
    // And never twice: the following tick finds both rows.
    jest.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(notifications.rows).toHaveLength(2);
  });

  it('24h: first-claim inserts fail at the final due tick; the next 15m tick delivers the "tomorrow" reminder', async () => {
    const { db, notifications, reminder } = harness();
    confirmed(db, 'claim-failed-24h', 24 * 60 - 14);
    const restore = failInserts(db);
    await withReminders(() => reminder.runTwentyFourHourReminderSweep());
    expect(db.deliveryLogs).toHaveLength(0);
    restore();
    jest.setSystemTime(new Date(NOW.getTime() + 15 * MIN));
    await withReminders(() => reminder.runTwentyFourHourReminderSweep());
    const sent = notifications.rows.filter((r) => r.kind === NotificationKind.BOOKING_REMINDER_24H);
    expect(sent).toHaveLength(2);
    expect(notifications.pushes).toHaveLength(2);
  });

  it('a session booked after its band (confirmed 40m before start) is not sent a back-dated reminder', async () => {
    const { db, notifications, reminder } = harness();
    const start = new Date(NOW.getTime() + 40 * MIN);
    confirmed(db, 'late-booking', 40, 'coach-1', { approved_at: NOW, created_at: NOW });
    expect(start.getTime() - NOW.getTime()).toBe(40 * MIN);
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(notifications.rows).toHaveLength(0);
    expect(db.deliveryLogs).toHaveLength(0);
  });

  it('200 retained moved-later rows do not pin the recovery page: the eligible retry is sent within the next ticks (Sol probe)', async () => {
    const { db, notifications, reminder } = harness();
    for (let i = 0; i < 200; i++) {
      const id = `future-${i}`;
      confirmed(db, id, 300 + i * 20, `coach-future-${i}`);
      db.deliveryLogs.push(
        retryRow(
          `old-${i}`,
          id,
          new Date(NOW.getTime() - (i + 1) * 24 * 60 * MIN),
          new Date(NOW.getTime() - 60_000),
        ),
      );
    }
    const eligible = confirmed(db, 'eligible-after-first-page', 50);
    db.deliveryLogs.push(retryRow('eligible', 'eligible-after-first-page', eligible));
    for (let tick = 0; tick < 3; tick++) {
      jest.setSystemTime(new Date(NOW.getTime() + tick * 5 * MIN));
      await withReminders(() => reminder.runOneHourReminderSweep());
    }
    expect(db.deliveryLogs.find((r) => r.id === 'eligible')?.status).toBe('sent');
    expect(notifications.pushes.length).toBeGreaterThanOrEqual(1);
    // The retained rows are parked (receipts kept), not deleted or sent.
    const old = db.deliveryLogs.filter((r) => String(r.id).startsWith('old-'));
    expect(old).toHaveLength(200);
    expect(old.every((r) => r.status === 'parked')).toBe(true);
  });

  it('a parked row is re-armed and sent when its new time reaches the band', async () => {
    const { db, notifications, reminder } = harness();
    confirmed(db, 'moved-later', 120);
    db.deliveryLogs.push(retryRow('moved', 'moved-later', new Date(NOW.getTime() + 30 * MIN)));
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(db.deliveryLogs.find((r) => r.id === 'moved')?.status).toBe('parked');
    jest.setSystemTime(new Date(NOW.getTime() + 60 * MIN));
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(db.deliveryLogs.find((r) => r.id === 'moved')?.status).toBe('sent');
    expect(notifications.rows.filter((r) => r.user_id === 'client-1')).toHaveLength(1);
  });

  it('a failed recovery read never logs raw ORM text and is reported as a failed recovery (Sol probe)', async () => {
    const { db, reminder, emitter } = harness();
    const canary = 'SYNTHETIC_PRIVATE_QUERY_CANARY';
    db.notificationDeliveryLog.findMany = async () => {
      throw new Prisma.PrismaClientKnownRequestError(`private query args ${canary}`, {
        code: 'P2024',
        clientVersion: 'test',
      });
    };
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await withReminders(() => reminder.runOneHourReminderSweep());
      const res = await withReminders(() =>
        reminder.dispatchWindow({
          lowerOffsetMinutes: 55,
          upperOffsetMinutes: 65,
          kind: NotificationKind.BOOKING_REMINDER_1H,
          emit: (recipient, otherName, session, ctx) =>
            emitter.emitReminder1h({
              recipientUserId: recipient,
              otherPartyDisplayName: otherName,
              sessionId: session.id,
              scheduledAt: session.start_at,
              recipientRole: ctx.recipientRole,
            }),
        }),
      );
      expect(res.recovery_failed).toBe(1);
      const logged = JSON.stringify([...errors.mock.calls, ...warns.mock.calls]);
      expect(logged).not.toContain(canary);
      expect(logged).toContain('P2024');
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('claim insert and dispatch failures log only the safe code, including an ORM error wrapped as a cause', async () => {
    const { db, reminder } = harness();
    confirmed(db, 'diag-1', 60);
    const canary = 'SYNTHETIC_CAUSE_CANARY';
    const restore = failInserts(db, `insert args ${canary}`);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await withReminders(() => reminder.runOneHourReminderSweep());
      restore();
      const cause = new Prisma.PrismaClientKnownRequestError(`cause args ${canary}`, {
        code: 'P2010',
        clientVersion: 'test',
      });
      const res = await reminder.dispatchWindow({
        lowerOffsetMinutes: 55,
        upperOffsetMinutes: 65,
        kind: NotificationKind.BOOKING_REMINDER_1H,
        emit: async () => {
          throw Object.assign(new Error(`wrapped ${canary}`), { cause });
        },
      });
      expect(res.retrying).toBe(2);
      const logged = JSON.stringify([...errors.mock.calls, ...warns.mock.calls]);
      expect(logged).not.toContain(canary);
      expect(logged).toContain('P2024');
      expect(logged).toContain('P2010');
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });
});

/**
 * S-SCHED-5 round 2 (Sol + Opus B-634-2 @ 4d987916): the catch-up pass must
 * reach a session whose first claim failed even when more than one page of
 * already-reminded sessions starts earlier in the catch-up interval. Each
 * case fails on 4d987916 (first 200 sessions read, filtered after the limit).
 */
describe('S-SCHED-5 round 2 B-634-2: catch-up walks the whole interval, not the first page', () => {
  const MIN = 60_000;
  afterEach(() => jest.setSystemTime(NOW));
  function addConfirmed(db: SchedulingFakeDb, id: string, start: Date, coachId: string): void {
    db.addSession({
      id,
      coach_id: coachId,
      client_id: 'client-1',
      session_type_id: 'st-q',
      status: 'scheduled',
      start_at: start,
      end_at: new Date(start.getTime() + 15 * MIN),
      video_url: 'https://meet.example.com/r6',
      approved_at: new Date(NOW.getTime() - 3 * 24 * 60 * MIN),
      created_at: new Date(NOW.getTime() - 3 * 24 * 60 * MIN),
    });
  }
  function settled(
    db: SchedulingFakeDb,
    sessionId: string,
    userId: string,
    kind: string,
    start: Date,
  ) {
    db.deliveryLogs.push({
      id: `sent-${sessionId}-${userId}`,
      session_id: sessionId,
      user_id: userId,
      kind,
      status: 'sent',
      attempts: 1,
      lease_until: null,
      claim_token: null,
      session_start_at: start,
      inapp_done_at: NOW,
      push_done_at: NOW,
      notification_id: null,
      last_error: null,
      created_at: NOW,
    });
  }
  function failInserts(db: SchedulingFakeDb) {
    const create = db.notificationDeliveryLog.create;
    db.notificationDeliveryLog.create = async () => {
      throw new Prisma.PrismaClientKnownRequestError('synthetic pool timeout before insert', {
        code: 'P2024',
        clientVersion: 'test',
      });
    };
    return () => {
      db.notificationDeliveryLog.create = create;
    };
  }

  it.each([
    {
      label: '1h',
      kind: NotificationKind.BOOKING_REMINDER_1H,
      // Final due tick: the trailing session sits at the band's lower edge.
      trailingMinutes: 55,
      // 250 settled sessions earlier in the catch-up interval at the next tick.
      prefixFrom: 31,
      prefixSpan: 18,
      cadence: 5,
      run: (r: SessionReminderJob) => r.runOneHourReminderSweep(),
    },
    {
      label: '24h',
      kind: NotificationKind.BOOKING_REMINDER_24H,
      trailingMinutes: 24 * 60 - 14,
      // Absolute 23h31m..23h44m: below the band now, and still in the
      // catch-up interval (and ahead of the trailing session) at +15m.
      prefixFrom: 24 * 60 - 29,
      prefixSpan: 14,
      cadence: 15,
      run: (r: SessionReminderJob) => r.runTwentyFourHourReminderSweep(),
    },
  ])(
    '$label: a first claim that failed is delivered at the next real tick behind 250 already-reminded sessions',
    async ({ kind, trailingMinutes, prefixFrom, prefixSpan, cadence, run }) => {
      const { db, notifications, reminder } = harness();
      for (let i = 0; i < 250; i++) {
        const start = new Date(
          NOW.getTime() + prefixFrom * MIN + Math.floor((i * prefixSpan * MIN) / 250 / MIN) * MIN,
        );
        const coachId = `coach-prefix-${i}`;
        addConfirmed(db, `prefix-${String(i).padStart(3, '0')}`, start, coachId);
        settled(db, `prefix-${String(i).padStart(3, '0')}`, 'client-1', kind, start);
        settled(db, `prefix-${String(i).padStart(3, '0')}`, coachId, kind, start);
      }
      const trailingStart = new Date(NOW.getTime() + trailingMinutes * MIN);
      addConfirmed(db, 'trailing', trailingStart, 'coach-1');
      const restore = failInserts(db);
      await withReminders(() => run(reminder));
      expect(db.deliveryLogs.filter((l) => l.session_id === 'trailing')).toHaveLength(0);
      restore();
      // The very next real tick reaches it, while all 250 settled sessions are
      // still ahead of it in the catch-up interval (the first 200-row page
      // alone would never contain it).
      jest.setSystemTime(new Date(NOW.getTime() + cadence * MIN));
      await withReminders(() => run(reminder));
      expect(
        db.deliveryLogs
          .filter((l) => l.session_id === 'trailing')
          .map((l) => l.status)
          .sort(),
      ).toEqual(['sent', 'sent']);
      // Keep ticking through the catch-up interval: still exactly once.
      for (let t = 2; t * cadence <= 30; t++) {
        jest.setSystemTime(new Date(NOW.getTime() + t * cadence * MIN));
        await withReminders(() => run(reminder));
      }
      const trailingRows = db.deliveryLogs.filter((l) => l.session_id === 'trailing');
      expect(trailingRows.map((l) => [l.user_id, l.status]).sort()).toEqual([
        ['client-1', 'sent'],
        ['coach-1', 'sent'],
      ]);
      const trailingSends = notifications.rows.filter(
        (r) => r.kind === kind && (r.payload as Record<string, unknown>)?.sessionId === 'trailing',
      );
      expect(trailingSends).toHaveLength(2);
      // Nothing in the settled prefix was sent again.
      expect(
        notifications.rows.filter((r) =>
          String((r.payload as Record<string, unknown>)?.sessionId ?? '').startsWith('prefix-'),
        ),
      ).toHaveLength(0);
    },
  );

  it('the walk keeps the no-back-dated-reminder rule behind a full page (late booking is skipped)', async () => {
    const { db, notifications, reminder } = harness();
    for (let i = 0; i < 210; i++) {
      const start = new Date(NOW.getTime() + (26 + (i % 20)) * MIN);
      const id = `p-${String(i).padStart(3, '0')}`;
      addConfirmed(db, id, start, `coach-p-${i}`);
      settled(db, id, 'client-1', NotificationKind.BOOKING_REMINDER_1H, start);
      settled(db, id, `coach-p-${i}`, NotificationKind.BOOKING_REMINDER_1H, start);
    }
    const late = new Date(NOW.getTime() + 50 * MIN);
    db.addSession({
      id: 'late-booked',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-q',
      status: 'scheduled',
      start_at: late,
      end_at: new Date(late.getTime() + 15 * MIN),
      approved_at: NOW,
      created_at: NOW,
    });
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(db.deliveryLogs.filter((l) => l.session_id === 'late-booked')).toHaveLength(0);
    expect(notifications.rows).toHaveLength(0);
  });
});

// B-634-9 (Sol @ bb6f3ea8): client-facing scheduling error copy speaks to the
// reader directly (no "we"/"us"/"our") and names a working next step, while
// status, machine code and existence hiding stay exactly as they were.
describe('B-634-9: scheduling error envelopes are direct and actionable', () => {
  const COLLECTIVE_VOICE = /\b(we|us|our|we're|we've|we'll|let's)\b/i;
  const NEXT_STEP = /\b(Open|Refresh|Pick|Message|Reload|Fix|Use|Decline|Mark|add)\b/;

  function expectDirect(f: Failure): void {
    expect(f.message).not.toMatch(COLLECTIVE_VOICE);
    expect(f.message).toMatch(NEXT_STEP);
  }

  it('404 SESSION_NOT_FOUND: same direct copy for a missing and a foreign session', async () => {
    const { svc } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const foreign = await failure(svc.getSession(CLIENT_2, s.id));
    const missing = await failure(svc.getSession(CLIENT, 'no-such-session'));
    const lifecycleMissing = await failure(svc.approveSession(COACH, 'no-such-session'));
    for (const f of [foreign, missing, lifecycleMissing]) {
      expect(f).toEqual({
        status: 404,
        code: 'SESSION_NOT_FOUND',
        message: 'That session is no longer available. Open Calendar to see your sessions.',
      });
      expectDirect(f);
    }
  });

  it('404 SESSION_TYPE_UNAVAILABLE on edit: missing and foreign types read the same', async () => {
    const { svc } = harness();
    const missing = await failure(svc.updateSessionType(COACH, 'no-such-type', { name: 'x' }));
    const foreign = await failure(svc.updateSessionType(OTHER_COACH, 'st-q', { name: 'x' }));
    for (const f of [missing, foreign]) {
      expect(f).toEqual({
        status: 404,
        code: 'SESSION_TYPE_UNAVAILABLE',
        message:
          'That appointment type is no longer available. Refresh your appointment types and try the change again.',
      });
      expectDirect(f);
    }
  });

  it('404 COACH_NOT_FOUND and 403 COACH_NOT_BOOKABLE keep status and code with direct copy', async () => {
    const { svc } = harness();
    const noCoach = await failure(
      svc.getOpenSlots(OWNER, 'no-such-coach', {
        from: TUE_1000,
        to: '2026-10-07T17:00:00.000Z',
        session_type_id: null,
        duration_minutes: 30,
      }),
    );
    expect(noCoach).toMatchObject({ status: 404, code: 'COACH_NOT_FOUND' });
    expectDirect(noCoach);
    const otherCalendar = await failure(svc.listSessionTypes(OTHER_COACH, 'coach-1'));
    expect(otherCalendar).toMatchObject({ status: 403, code: 'COACH_NOT_BOOKABLE' });
    expectDirect(otherCalendar);
    const notAssigned = await failure(svc.listSessionTypes(FOREIGN_CLIENT, 'coach-1'));
    expect(notAssigned).toMatchObject({ status: 403, code: 'COACH_NOT_BOOKABLE' });
    expectDirect(notAssigned);
  });

  it('every schedulingError message in src/scheduling is free of we/us, and SESSION_NOT_FOUND uses one constant', () => {
    const dir = path.join(__dirname, '..', 'src', 'scheduling');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(dir, f));
    const messages: string[] = [];
    let inlineNotFound = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /schedulingError\(\s*SchedulingErrorCode\.\w+,\s*(?:'([^']*)'|`([^`]*)`|"([^"]*)")/g,
      )) {
        messages.push(m[1] ?? m[2] ?? m[3] ?? '');
      }
      for (const m of src.matchAll(/new \w+Exception\(\s*'([^']*)'/g)) messages.push(m[1]);
      inlineNotFound += [...src.matchAll(/SchedulingErrorCode\.SESSION_NOT_FOUND,\s*['`"]/g)]
        .length;
    }
    expect(messages.length).toBeGreaterThan(30);
    expect(messages.filter((m) => COLLECTIVE_VOICE.test(m))).toEqual([]);
    expect(inlineNotFound).toBe(0);
  });
});

// C-634-6 (Opus @ bb6f3ea8): catch-up counts a participant as covered only by
// a row for the session's CURRENT start. A stale row (an earlier start of a
// moved session) or a parked row whose re-arm write failed at the band's last
// tick is otherwise invisible to both recovery and catch-up.
describe('C-634-6: catch-up coverage is keyed on the current start time', () => {
  const MIN = 60_000;
  afterEach(() => jest.setSystemTime(NOW));
  function addConfirmed(db: SchedulingFakeDb, id: string, start: Date): void {
    db.addSession({
      id,
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-q',
      status: 'scheduled',
      start_at: start,
      end_at: new Date(start.getTime() + 15 * MIN),
      video_url: 'https://meet.example.com/c6',
      approved_at: new Date(NOW.getTime() - 3 * 24 * 60 * MIN),
      created_at: new Date(NOW.getTime() - 3 * 24 * 60 * MIN),
    });
  }
  function logRow(sessionId: string, userId: string, status: string, forStart: Date) {
    return {
      id: `c6-${sessionId}-${userId}`,
      session_id: sessionId,
      user_id: userId,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      status,
      attempts: 1,
      lease_until: null,
      claim_token: null,
      session_start_at: forStart,
      inapp_done_at: status === 'sent' ? NOW : null,
      push_done_at: status === 'sent' ? NOW : null,
      notification_id: null,
      last_error: null,
      created_at: NOW,
    };
  }
  function failTakeovers(db: SchedulingFakeDb) {
    const updateMany = db.notificationDeliveryLog.updateMany;
    db.notificationDeliveryLog.updateMany = async () => {
      throw new Prisma.PrismaClientKnownRequestError('synthetic pool timeout on re-arm', {
        code: 'P2024',
        clientVersion: 'test',
      });
    };
    return () => {
      db.notificationDeliveryLog.updateMany = updateMany;
    };
  }

  it.each([
    { label: 'a stale sent row for an earlier start', status: 'sent', stale: true },
    { label: 'a parked row', status: 'parked', stale: false },
  ])(
    '1h: $label whose re-arm fails at the final due tick is delivered by the next tick',
    async ({ status, stale }) => {
      const { db, notifications, reminder } = harness();
      const start = new Date(NOW.getTime() + 55 * MIN);
      const forStart = stale ? new Date(start.getTime() - 3 * 60 * MIN) : start;
      addConfirmed(db, 'moved', start);
      db.deliveryLogs.push(logRow('moved', 'client-1', status, forStart));
      db.deliveryLogs.push(logRow('moved', 'coach-1', status, forStart));
      const restore = failTakeovers(db);
      await withReminders(() => reminder.runOneHourReminderSweep());
      restore();
      expect(notifications.rows).toHaveLength(0);
      // Next real tick: 50 minutes out, below the band.
      jest.setSystemTime(new Date(NOW.getTime() + 5 * MIN));
      await withReminders(() => reminder.runOneHourReminderSweep());
      expect(notifications.rows.map((r) => r.user_id).sort()).toEqual(['client-1', 'coach-1']);
      expect(notifications.pushes).toHaveLength(2);
      for (const l of db.deliveryLogs) {
        expect(l).toMatchObject({ status: 'sent' });
        expect(l.session_start_at).toEqual(start);
      }
      // And never twice.
      jest.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
      await withReminders(() => reminder.runOneHourReminderSweep());
      expect(notifications.rows).toHaveLength(2);
    },
  );

  it('rows for the current start (sent, gave_up) and legacy rows (no start) still count as covered', async () => {
    const { db, notifications, reminder } = harness();
    const a = new Date(NOW.getTime() + 50 * MIN);
    const b = new Date(NOW.getTime() + 45 * MIN);
    addConfirmed(db, 'settled-now', a);
    addConfirmed(db, 'legacy', b);
    db.deliveryLogs.push(logRow('settled-now', 'client-1', 'sent', a));
    db.deliveryLogs.push(logRow('settled-now', 'coach-1', 'gave_up', a));
    const legacy = logRow('legacy', 'client-1', 'sent', b);
    db.deliveryLogs.push({ ...legacy, session_start_at: null });
    db.deliveryLogs.push({ ...logRow('legacy', 'coach-1', 'sent', b), session_start_at: null });
    await withReminders(() => reminder.runOneHourReminderSweep());
    expect(notifications.rows).toHaveLength(0);
    expect(notifications.pushes).toHaveLength(0);
  });
});

// Pre-push checklist (a) over the whole PR: provider and reminder error paths
// log only IDs and machine codes. A synthetic private string in an error
// message (provider SDK text, ORM query text) never reaches a logger argument.
describe('checklist (a): scheduling error logs carry no free-form error text', () => {
  const CANARY = 'PRIVATE-CANARY-meet-link-Jamie-notes-91c2';
  const LOG_METHODS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
  let spies: jest.SpyInstance[] = [];
  beforeEach(() => {
    spies = LOG_METHODS.map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
    jest.setSystemTime(NOW);
  });
  function logged(): string {
    return JSON.stringify(spies.flatMap((s) => s.mock.calls));
  }
  function ormCanary(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError(`Query failed: ${CANARY}`, {
      code: 'P2024',
      clientVersion: 'test',
      meta: { target: CANARY },
    });
  }

  it.each([
    { label: 'a provider SDK error', make: () => new TypeError(`calendar said: ${CANARY}`) },
    { label: 'an ORM error', make: () => ormCanary() },
  ])(
    'provisioning failure ($label): booking stands, log has the session id only',
    async ({ make }) => {
      const { svc, providers } = harness();
      const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
      providers.resolveCalendar('stub').createEvent = async () => {
        throw make();
      };
      const final = await svc.approveSession(COACH, s.id);
      expect(final.status).toBe('scheduled');
      const text = logged();
      expect(text).toContain(`provider provisioning failed for session=${s.id}`);
      expect(text).not.toContain(CANARY);
    },
  );

  it('provider cancellation and superseded-artifact cleanup failures never log the provider message', async () => {
    const { svc, providers } = harness();
    const s = await svc.requestSession(CLIENT, request(CLIENT, 'st-q', TUE_1000, TUE_1015));
    const adapter = providers.resolveCalendar('stub');
    const original = adapter.createEvent.bind(adapter);
    const gate = pausePoint();
    adapter.createEvent = async (input) => {
      await gate.hit();
      await original(input);
      return { externalEventId: 'gcal-evt-9', resolvedProvider: 'google_calendar' };
    };
    providers.resolveCalendar('google_calendar').cancelEvent = async () => {
      throw new TypeError(`google said: ${CANARY}`);
    };
    const approving = svc.approveSession(COACH, s.id);
    await gate.reached;
    await svc.cancelSession(CLIENT, s.id, { reason: 'plans changed' });
    gate.release();
    expect((await approving).status).toBe('canceled');
    const text = logged();
    expect(text).toMatch(/(superseded artifact cleanup|Provider cancellation) failed for session=/);
    expect(text).toContain('TypeError');
    expect(text).not.toContain(CANARY);
  });

  it('a reminder dispatch that throws a non-ORM error logs its class only', async () => {
    const { db, reminder, emitter } = harness();
    const start = new Date(NOW.getTime() + 57 * 60_000);
    db.addSession({
      id: 'canary-reminder',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-q',
      status: 'scheduled',
      start_at: start,
      end_at: new Date(start.getTime() + 15 * 60_000),
      video_url: 'https://meet.example.com/a',
      approved_at: new Date(NOW.getTime() - 3 * 24 * 3_600_000),
      created_at: new Date(NOW.getTime() - 3 * 24 * 3_600_000),
    });
    jest.spyOn(emitter, 'emitReminder1h').mockImplementation(async () => {
      throw new RangeError(`render failed: ${CANARY}`);
    });
    await withReminders(() => reminder.runOneHourReminderSweep());
    const text = logged();
    expect(text).toContain('session=canary-reminder');
    expect(text).toContain('RangeError');
    expect(text).not.toContain(CANARY);
  });
});
