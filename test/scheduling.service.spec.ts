import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { AuditService, type AuditWriteInput } from '../src/audit/audit.service';
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

// State machine + audit + permission behaviour of SchedulingService over the
// shared scheduling Prisma double (test/utils/scheduling-fake-db.ts). The
// S-SCHED-2 validation / ownership / race matrix lives in
// test/scheduling-lifecycle-integrity.spec.ts; the database floor in
// test/scheduling-booking-concurrency.live.spec.ts.

// Monday 2026-06-01 is fully open for coach-1 (00:00-24:00 every day).
const PINNED_NOW = new Date('2026-05-31T12:00:00Z');

const COACH_ACTOR: ActorContext = {
  id: 'coach-1',
  role: 'coach',
  email: 'co@c.test',
  coach_id: null,
  ip: '127.0.0.1',
  userAgent: 'jest',
};
const CLIENT_ACTOR: ActorContext = {
  id: 'client-1',
  role: 'student',
  email: 'cl@c.test',
  coach_id: 'coach-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

function build() {
  const db = new SchedulingFakeDb();
  db.addUser({ id: 'coach-1', name: 'Coach One', role: 'coach' });
  db.addUser({ id: 'coach-2', name: 'Coach Two', role: 'coach' });
  db.addUser({ id: 'client-1', name: 'Client One', role: 'student', coach_id: 'coach-1' });
  db.addUser({ id: 'client-2', name: 'Client Two', role: 'student', coach_id: 'coach-2' });
  db.addSessionType({
    id: 'st-1',
    coach_id: 'coach-1',
    name: '30-min check-in',
    duration_minutes: 30,
    auto_approve: false,
  });
  db.addSessionType({
    id: 'st-2',
    coach_id: 'coach-2',
    name: 'Coach two call',
    duration_minutes: 30,
    auto_approve: false,
  });
  for (let d = 0; d <= 6; d++) {
    db.addWindow('coach-1', d, 0, 24 * 60);
    db.addWindow('coach-2', d, 0, 24 * 60);
  }
  const writes: AuditWriteInput[] = [];
  const audit = Object.assign(Object.create(AuditService.prototype) as AuditService, {
    write: jest.fn(async (input: AuditWriteInput) => {
      writes.push(input);
    }),
  });
  const notifications = Object.assign(
    Object.create(NotificationsService.prototype) as NotificationsService,
    {
      createNotification: jest.fn(async () => ({ id: 'n' })),
      getPreferences: jest.fn(async () => ({ timezone: 'America/Los_Angeles' })),
      pushToUser: jest.fn(async () => ({ delivered: false, code: 'no-token' as const })),
    },
  );
  const calendarSpy = new GoogleCalendarAdapter();
  const meetSpy = new GoogleMeetAdapter();
  const zoomSpy = new ZoomVideoAdapter();
  const registry = new SchedulingProviderRegistry(
    new StubCalendarAdapter(),
    calendarSpy,
    new StubVideoAdapter(),
    meetSpy,
    zoomSpy,
  );
  const svc = new SchedulingService(
    asPrisma(db),
    audit,
    registry,
    new BookingEmitter(notifications, asPrisma(db)),
  );
  return { db, svc, writes, real: { calendarSpy, meetSpy, zoomSpy } };
}

function request(
  svc: SchedulingService,
  start = '2026-06-01T15:00:00Z',
  end = '2026-06-01T15:30:00Z',
) {
  return svc.requestSession(CLIENT_ACTOR, {
    coach_id: 'coach-1',
    session_type_id: 'st-1',
    title: '30-min check-in',
    start_at: start,
    end_at: end,
  });
}

describe('SchedulingService — request + state machine + audit', () => {
  let h: ReturnType<typeof build>;

  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(PINNED_NOW);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    // No provider env flags set: every adapter falls back to the stub.
    delete process.env.GOOGLE_CALENDAR_ENABLED;
    delete process.env.GOOGLE_MEET_ENABLED;
    delete process.env.ZOOM_ENABLED;
    h = build();
  });

  it('client requests a session — written as `requested`, audit recorded', async () => {
    const session = await request(h.svc);
    expect(session.status).toBe('requested');
    expect(session.client_id).toBe('client-1');
    expect(h.writes.find((w) => w.action === 'session.requested')).toBeTruthy();
    // Provisioning happens on approval, not request.
    expect(h.writes.find((w) => w.action === 'session.provider.calendar_created')).toBeUndefined();
  });

  it('client cannot request a session against a coach that is not theirs', async () => {
    await expect(
      h.svc.requestSession(CLIENT_ACTOR, {
        coach_id: 'coach-2',
        session_type_id: 'st-2',
        title: 'x',
        start_at: '2026-06-01T15:00:00Z',
        end_at: '2026-06-01T15:30:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects end_at <= start_at on request', async () => {
    await expect(
      request(h.svc, '2026-06-01T15:00:00Z', '2026-06-01T15:00:00Z'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('coach approves -> `scheduled`, stub provider mints ids, audits cover both sides, real adapters untouched', async () => {
    const requested = await request(h.svc);
    const approved = await h.svc.approveSession(COACH_ACTOR, requested.id);
    expect(approved.status).toBe('scheduled');
    expect(approved.calendar_event_id).toMatch(/^stub-cal-sess-sess-\d+-/);
    // StubVideoAdapter returns joinUrl: null so fake URLs never reach rows.
    expect(approved.video_url).toBeNull();
    expect(approved.provider_idempotency_key).toMatch(/^sess-sess-\d+-/);
    expect(h.writes.map((w) => w.action)).toEqual(
      expect.arrayContaining([
        'session.requested',
        'session.approved',
        'session.provider.calendar_created',
        'session.provider.video_created',
      ]),
    );
  });

  it('client cannot approve a session', async () => {
    const requested = await request(h.svc);
    await expect(h.svc.approveSession(CLIENT_ACTOR, requested.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('cannot transition from completed back to scheduled', async () => {
    const requested = await request(h.svc);
    await h.svc.approveSession(COACH_ACTOR, requested.id);
    jest.setSystemTime(new Date('2026-06-01T15:31:00Z'));
    try {
      await h.svc.completeSession(COACH_ACTOR, requested.id, {});
      // Split 2/9: refused before and after the lifecycle piece (4/9 makes it 409).
      await expect(h.svc.approveSession(COACH_ACTOR, requested.id)).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(h.db.sessions.find((x) => x.id === requested.id)?.status).toBe('completed');
    } finally {
      jest.setSystemTime(PINNED_NOW);
    }
  });

  it('cannot cancel a completed session', async () => {
    const requested = await request(h.svc);
    await h.svc.approveSession(COACH_ACTOR, requested.id);
    jest.setSystemTime(new Date('2026-06-01T15:31:00Z'));
    try {
      await h.svc.completeSession(COACH_ACTOR, requested.id, {});
      // Split 2/9: refused before and after the lifecycle piece (4/9 makes it 409).
      await expect(h.svc.cancelSession(COACH_ACTOR, requested.id, {})).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(h.db.sessions.find((x) => x.id === requested.id)?.status).toBe('completed');
    } finally {
      jest.setSystemTime(PINNED_NOW);
    }
  });

  it('reschedule is allowed in requested or scheduled, captures previous + new times', async () => {
    const requested = await request(h.svc);
    h.db.deliveryLogs.push({
      id: 'claim-old-time',
      session_id: requested.id,
      user_id: 'client-1',
      kind: 'booking_reminder_24h',
      start_at: new Date('2026-06-01T15:00:00Z'),
    });
    const rescheduled = await h.svc.rescheduleSession(CLIENT_ACTOR, requested.id, {
      start_at: '2026-06-02T15:00:00Z',
      end_at: '2026-06-02T15:30:00Z',
      reason: 'conflict',
    });
    expect(rescheduled.start_at.toISOString()).toBe('2026-06-02T15:00:00.000Z');
    // Sol B-647-1: the move re-arms the reminders through the claim key
    // (session, user, kind, start_at), so it never deletes claims; a stale
    // sweep's old-time claim cannot suppress the new time.
    expect(h.db.deliveryLogs.filter((l) => l.session_id === requested.id).map((l) => l.id)).toEqual(
      ['claim-old-time'],
    );
    const audit = h.writes.find((w) => w.action === 'session.rescheduled');
    expect(audit?.metadata).toMatchObject({
      previous_start_at: '2026-06-01T15:00:00.000Z',
      new_start_at: '2026-06-02T15:00:00.000Z',
      reason: 'conflict',
    });
  });

  it('attaching a manual video link sets provider=manual and audits', async () => {
    const requested = await request(h.svc);
    await h.svc.approveSession(COACH_ACTOR, requested.id);
    const updated = await h.svc.attachManualVideoLink(COACH_ACTOR, requested.id, {
      video_url: 'https://whereby.com/coach-1/personal-room',
    });
    expect(updated.video_provider).toBe('manual');
    expect(updated.video_url).toBe('https://whereby.com/coach-1/personal-room');
    expect(h.writes.find((w) => w.action === 'session.video_link_attached')).toBeTruthy();
  });

  it('listUpcomingForActor scopes results by role', async () => {
    await request(h.svc);
    expect(await h.svc.listUpcomingForActor(CLIENT_ACTOR)).toHaveLength(1);
    expect(await h.svc.listUpcomingForActor(COACH_ACTOR)).toHaveLength(1);
    const otherClient: ActorContext = { ...CLIENT_ACTOR, id: 'client-2', coach_id: 'coach-2' };
    expect(await h.svc.listUpcomingForActor(otherClient)).toHaveLength(0);
  });

  it('availability-set is atomic: deletes old, creates new, audits once per call', async () => {
    await h.svc.setAvailability(COACH_ACTOR, 'coach-1', [
      { day_of_week: 1, start_minute: 9 * 60, end_minute: 12 * 60 },
      { day_of_week: 3, start_minute: 14 * 60, end_minute: 16 * 60 },
    ]);
    expect(h.db.availability.filter((a) => a.coach_id === 'coach-1')).toHaveLength(2);
    await h.svc.setAvailability(COACH_ACTOR, 'coach-1', [
      { day_of_week: 5, start_minute: 10 * 60, end_minute: 11 * 60 },
    ]);
    const rows = h.db.availability.filter((a) => a.coach_id === 'coach-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].day_of_week).toBe(5);
    expect(h.writes.filter((w) => w.action === 'coach.availability_updated')).toHaveLength(2);
  });

  it('rejects availability windows where end_minute <= start_minute', async () => {
    await expect(
      h.svc.setAvailability(COACH_ACTOR, 'coach-1', [
        { day_of_week: 1, start_minute: 600, end_minute: 600 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never calls a real provider adapter while the provider flags are off', async () => {
    const calls = [
      jest.spyOn(h.real.calendarSpy, 'createEvent'),
      jest.spyOn(h.real.meetSpy, 'createMeeting'),
      jest.spyOn(h.real.zoomSpy, 'createMeeting'),
    ];
    const requested = await request(h.svc);
    await h.svc.approveSession(COACH_ACTOR, requested.id);
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });
});
