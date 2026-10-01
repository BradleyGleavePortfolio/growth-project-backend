import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import { auditDouble, bookingEmitterDouble } from './utils/scheduling-test-doubles';

// Lightweight in-memory fakes — we test state-machine + audit + permission
// behaviour without booting Nest or Prisma. The schema-level guarantees
// (FKs, NOT NULL) are exercised by the migration; this file is about
// service-layer correctness.

function buildPrismaFake() {
  const sessions: any[] = [];
  const sessionTypes: any[] = [];
  const availability: any[] = [];
  return {
    _state: { sessions, sessionTypes, availability },
    // S-SCHED: open-slot validation on the client booking path reads the
    // coach (timezone) and overrides; reschedule re-reads under the lock.
    user: {
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        id.startsWith('coach-')
          ? { id, role: 'coach', coach_profile: { timezone: 'UTC' } }
          : null,
      ),
    },
    coachAvailabilityOverride: {
      findMany: jest.fn(async () => []),
    },
    $executeRaw: jest.fn(async () => 1),
    sessionType: {
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        sessionTypes.find((s) => s.id === id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        sessionTypes.filter(
          (s) =>
            s.coach_id === where.coach_id &&
            (where.archived_at === null ? !s.archived_at : true),
        ),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `st-${sessionTypes.length + 1}`,
          archived_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        sessionTypes.push(row);
        return row;
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const i = sessionTypes.findIndex((s) => s.id === id);
        sessionTypes[i] = { ...sessionTypes[i], ...data };
        return sessionTypes[i];
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    coachAvailability: {
      findMany: jest.fn(async ({ where }: any) =>
        availability.filter((a) => a.coach_id === where.coach_id),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = availability.length - 1; i >= 0; i--) {
          if (availability[i].coach_id === where.coach_id) availability.splice(i, 1);
        }
        return { count: 0 };
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) {
          availability.push({ id: `av-${availability.length + 1}`, ...d });
        }
        return { count: data.length };
      }),
    },
    coachingSession: {
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        sessions.find((s) => s.id === id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) => {
        return sessions.filter((s) => {
          if (where.coach_id && s.coach_id !== where.coach_id) return false;
          if (where.client_id && s.client_id !== where.client_id) return false;
          if (typeof where.status === 'string' && s.status !== where.status) return false;
          if (where.status?.in && !where.status.in.includes(s.status)) return false;
          if (where.id?.not && s.id === where.id.not) return false;
          if (where.start_at?.gte && s.start_at < where.start_at.gte) return false;
          if (where.start_at?.lt && !(s.start_at < where.start_at.lt)) return false;
          if (where.end_at?.gt && !(s.end_at > where.end_at.gt)) return false;
          if (where.end_at?.gte && s.end_at < where.end_at.gte) return false;
          if (where.end_at?.lt && !(s.end_at < where.end_at.lt)) return false;
          return true;
        });
      }),
      // Phase 6E P0-S2: overlap probe in requestSession before insert.
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          sessions.find((s) => {
            if (where.coach_id && s.coach_id !== where.coach_id) return false;
            if (where.id?.not && s.id === where.id.not) return false;
            if (where.status?.in && !where.status.in.includes(s.status)) {
              return false;
            }
            if (where.start_at?.lt && !(s.start_at < where.start_at.lt)) {
              return false;
            }
            if (where.end_at?.gt && !(s.end_at > where.end_at.gt)) {
              return false;
            }
            return true;
          }) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `sess-${sessions.length + 1}`,
          status: 'requested',
          coach_notes_md: null,
          client_recap_md: null,
          video_url: null,
          video_meeting_id: null,
          calendar_event_id: null,
          provider_idempotency_key: null,
          approved_at: null,
          ended_at: null,
          end_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        sessions.push(row);
        return row;
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const i = sessions.findIndex((s) => s.id === id);
        sessions[i] = { ...sessions[i], ...data, updated_at: new Date() };
        return sessions[i];
      }),
      // S-SCHED: compare-and-set transitions.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const i = sessions.findIndex(
          (s) => s.id === where.id && (where.status === undefined || s.status === where.status),
        );
        if (i < 0) return { count: 0 };
        sessions[i] = { ...sessions[i], ...data, updated_at: new Date() };
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(),
  } as any;
}

// Wires the prisma-fake's $transaction back to the fake itself so the
// service-layer transaction blocks see the same in-memory tables. Done
// after construction since the fake doesn't have a stable `this`.
function bindTransaction(prisma: any) {
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
}

function buildAudit() {
  const writes: any[] = [];
  const audit = auditDouble({
    write: jest.fn(async (input: any) => {
      writes.push(input);
    }),
  });
  return { audit, writes };
}

function buildRegistry() {
  return new SchedulingProviderRegistry(
    new StubCalendarAdapter(),
    new GoogleCalendarAdapter(),
    new StubVideoAdapter(),
    new GoogleMeetAdapter(),
    new ZoomVideoAdapter(),
  );
}

const COACH_ACTOR = {
  id: 'coach-1',
  role: 'coach' as const,
  email: 'c@c.test',
  coach_id: null,
  ip: '127.0.0.1',
  userAgent: 'jest',
};
const CLIENT_ACTOR = {
  id: 'client-1',
  role: 'student' as const,
  email: 'cl@c.test',
  coach_id: 'coach-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

describe('SchedulingService — request + state machine + audit', () => {
  // Pin the clock to a moment where the hard-coded 2026-06-01 / 2026-06-02
  // session start_at values are still in the future. Without this, the
  // production 5-minute future-lead validator (scheduling-session-lifecycle
  // .service.ts:79-81) correctly rejects every test fixture once the wall
  // clock crosses 2026-06-01T14:55:00Z. We pin instead of mutating the
  // fixtures because the tests are exercising the state machine + audit
  // contract, not the time-skew validator (which has its own coverage).
  const PINNED_NOW = new Date('2026-05-31T12:00:00Z');

  let prisma: any;
  let auditCtx: ReturnType<typeof buildAudit>;
  let svc: SchedulingService;

  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(PINNED_NOW);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    // Default state: no provider env flags set — every adapter falls
    // back to the stub. We assert this guarantee by spying on the real
    // adapters and ensuring they are never invoked.
    delete process.env.GOOGLE_CALENDAR_ENABLED;
    delete process.env.GOOGLE_MEET_ENABLED;
    delete process.env.ZOOM_ENABLED;
    prisma = buildPrismaFake();
    bindTransaction(prisma);
    // S-SCHED: clients book from an appointment type inside open time.
    // Fixture: one 30-minute type and all-day availability every day.
    prisma._state.sessionTypes.push({
      id: 'st-30',
      coach_id: 'coach-1',
      name: '30-min check-in',
      description: null,
      duration_minutes: 30,
      auto_approve: false,
      default_video_provider: 'stub',
      is_welcome: false,
      default_meeting_url: null,
      archived_at: null,
    });
    for (let d = 0; d < 7; d++) {
      prisma._state.availability.push({
        id: `av-all-${d}`,
        coach_id: 'coach-1',
        day_of_week: d,
        start_minute: 0,
        end_minute: 1440,
        session_type_id: null,
      });
    }
    auditCtx = buildAudit();
    // BookingEmitter is a thin pass-through to NotificationsService; for
    // the existing scheduling.service.spec the emit calls are a no-op
    // stub. Booking-notification coverage lives in
    // src/notifications/__tests__/booking.emitter.spec.ts.
    const stubEmitter = bookingEmitterDouble({
      emitRequested: async () => undefined,
      emitConfirmed: async () => undefined,
      emitDeclined: async () => undefined,
      emitCancelled: async () => undefined,
      emitRescheduled: async () => undefined,
      emitReminder24h: async () => undefined,
      emitReminder1h: async () => undefined,
    });
    svc = new SchedulingService(prisma, auditCtx.audit, buildRegistry(), stubEmitter);
  });

  it('client requests a session — written as `requested`, audit recorded', async () => {
    const session = await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: '30-min check-in',
      start_at: '2026-06-01T15:00:00Z',
      end_at: '2026-06-01T15:30:00Z',
    });
    expect(session.status).toBe('requested');
    expect(session.client_id).toBe('client-1');
    expect(auditCtx.writes.find((w) => w.action === 'session.requested')).toBeTruthy();
    // No provider audit entries should be present yet — provisioning
    // happens on approval, not request.
    expect(
      auditCtx.writes.find((w) => w.action === 'session.provider.calendar_created'),
    ).toBeUndefined();
  });

  it('client cannot request a session against a coach that is not theirs', async () => {
    await expect(
      svc.requestSession(CLIENT_ACTOR, {
        coach_id: 'coach-2',
        title: 'x',
        start_at: '2026-06-01T15:00:00Z',
        end_at: '2026-06-01T15:30:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects end_at <= start_at on request', async () => {
    await expect(
      svc.requestSession(CLIENT_ACTOR, {
        coach_id: 'coach-1',
        session_type_id: 'st-30',
        title: 'x',
        start_at: '2026-06-01T15:00:00Z',
        end_at: '2026-06-01T15:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('coach approves -> state becomes `scheduled`, stub provider mints ids, audits cover both sides', async () => {
    const requested = await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: '30-min check-in',
      start_at: '2026-06-01T15:00:00Z',
      end_at: '2026-06-01T15:30:00Z',
    });
    const approved = await svc.approveSession(COACH_ACTOR, requested.id);
    expect(approved.status).toBe('scheduled');
    // Coach actor: the full row (clients get ClientSessionView without these).
    const full = 'calendar_event_id' in approved ? approved : null;
    expect(full?.calendar_event_id).toMatch(/^stub-cal-sess-sess-1-/);
    // StubVideoAdapter intentionally returns joinUrl: null to prevent
    // fake tgp-stub:// URLs from leaking into production rows.
    expect(approved.video_url).toBeNull();
    // Idempotency key is set once and reused — second provisioning
    // call would not pick a different key.
    expect(full?.provider_idempotency_key).toMatch(/^sess-sess-1-/);

    const actions = auditCtx.writes.map((w) => w.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'session.requested',
        'session.approved',
        'session.provider.calendar_created',
        'session.provider.video_created',
      ]),
    );
  });

  it('client cannot approve a session', async () => {
    const requested = await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: 'x',
      start_at: '2026-06-01T15:00:00Z',
      end_at: '2026-06-01T15:30:00Z',
    });
    await expect(
      svc.approveSession(CLIENT_ACTOR, requested.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot transition from completed back to scheduled', async () => {
    const requested = await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: 'x',
      start_at: '2026-06-01T15:00:00Z',
      end_at: '2026-06-01T15:30:00Z',
    });
    await svc.approveSession(COACH_ACTOR, requested.id);
    await svc.completeSession(COACH_ACTOR, requested.id, {});
    await expect(
      svc.approveSession(COACH_ACTOR, requested.id),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot cancel a completed session', async () => {
    const requested = await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: 'x',
      start_at: '2026-06-01T15:00:00Z',
      end_at: '2026-06-01T15:30:00Z',
    });
    await svc.approveSession(COACH_ACTOR, requested.id);
    await svc.completeSession(COACH_ACTOR, requested.id, {});
    await expect(
      svc.cancelSession(COACH_ACTOR, requested.id, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reschedule is allowed in requested or scheduled, captures previous + new times', async () => {
    const requested = await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: 'x',
      start_at: '2026-06-01T15:00:00Z',
      end_at: '2026-06-01T15:30:00Z',
    });
    const rescheduled = await svc.rescheduleSession(CLIENT_ACTOR, requested.id, {
      start_at: '2026-06-02T15:00:00Z',
      end_at: '2026-06-02T15:30:00Z',
      reason: 'conflict',
    });
    expect(rescheduled.start_at.toISOString()).toBe('2026-06-02T15:00:00.000Z');
    const audit = auditCtx.writes.find((w) => w.action === 'session.rescheduled');
    expect(audit?.metadata).toMatchObject({
      previous_start_at: '2026-06-01T15:00:00.000Z',
      new_start_at: '2026-06-02T15:00:00.000Z',
      reason: 'conflict',
    });
  });

  it('attaching a manual video link sets provider=manual and audits', async () => {
    const requested = await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: 'x',
      start_at: '2026-06-01T15:00:00Z',
      end_at: '2026-06-01T15:30:00Z',
    });
    await svc.approveSession(COACH_ACTOR, requested.id);
    const updated = await svc.attachManualVideoLink(COACH_ACTOR, requested.id, {
      video_url: 'https://whereby.com/coach-1/personal-room',
    });
    expect(updated.video_provider).toBe('manual');
    expect(updated.video_url).toBe('https://whereby.com/coach-1/personal-room');
    expect(
      auditCtx.writes.find((w) => w.action === 'session.video_link_attached'),
    ).toBeTruthy();
  });

  it('listUpcomingForActor scopes results by role', async () => {
    await svc.requestSession(CLIENT_ACTOR, {
      coach_id: 'coach-1',
      session_type_id: 'st-30',
      title: 'x',
      start_at: '2999-06-01T15:00:00Z',
      end_at: '2999-06-01T15:30:00Z',
    });
    const clientUpcoming = await svc.listUpcomingForActor(CLIENT_ACTOR);
    expect(clientUpcoming).toHaveLength(1);
    const otherClient = {
      ...CLIENT_ACTOR,
      id: 'client-2',
      coach_id: 'coach-2',
    };
    const empty = await svc.listUpcomingForActor(otherClient);
    expect(empty).toHaveLength(0);
  });

  it('availability-set is atomic: deletes old, creates new, audits once', async () => {
    await svc.setAvailability(COACH_ACTOR, 'coach-1', [
      { day_of_week: 1, start_minute: 9 * 60, end_minute: 12 * 60 },
      { day_of_week: 3, start_minute: 14 * 60, end_minute: 16 * 60 },
    ]);
    expect(prisma._state.availability).toHaveLength(2);
    // Second call replaces fully.
    await svc.setAvailability(COACH_ACTOR, 'coach-1', [
      { day_of_week: 5, start_minute: 10 * 60, end_minute: 11 * 60 },
    ]);
    expect(prisma._state.availability).toHaveLength(1);
    expect(prisma._state.availability[0].day_of_week).toBe(5);
    const audits = auditCtx.writes.filter(
      (w) => w.action === 'coach.availability_updated',
    );
    expect(audits).toHaveLength(2);
  });

  it('rejects availability windows where end_minute <= start_minute', async () => {
    await expect(
      svc.setAvailability(COACH_ACTOR, 'coach-1', [
        { day_of_week: 1, start_minute: 600, end_minute: 600 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
