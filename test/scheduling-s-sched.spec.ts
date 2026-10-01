/**
 * S-SCHED: client Calendar backend contract.
 *
 * Covers: attachment-gated reads (types, availability, open slots), the
 * client booking rules (approved type required, not archived, exact type
 * length, inside open time incl. overrides), mobile DTO compatibility
 * (client_timezone / notes no longer 400 under forbidNonWhitelisted),
 * compare-and-set transitions, the client session view, the per-type
 * default meeting link, the single active welcome type, session-type-scoped
 * windows, the lead-time floor and cache invalidation on open slots.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import {
  CreateSessionTypeDto,
  RequestSessionDto,
  RescheduleSessionDto,
  UpdateSessionTypeDto,
} from '../src/scheduling/dto/scheduling.dto';
import { auditDouble, bookingEmitterDouble } from './utils/scheduling-test-doubles';

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    const val = row[k];
    if (v === null) {
      if (val !== null && val !== undefined) return false;
    } else if (v instanceof Date) {
      if (!(val instanceof Date) || val.getTime() !== v.getTime()) return false;
    } else if (typeof v === 'object') {
      if ('in' in v && !v.in.includes(val)) return false;
      if ('not' in v && val === v.not) return false;
      if ('lt' in v && !(val < v.lt)) return false;
      if ('lte' in v && !(val <= v.lte)) return false;
      if ('gt' in v && !(val > v.gt)) return false;
      if ('gte' in v && !(val >= v.gte)) return false;
    } else if (val !== v) {
      return false;
    }
  }
  return true;
}

function table(prefix: string, rows: Row[]) {
  return {
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
    findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matches(r, where))),
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `${prefix}-${rows.length + 1}`,
        created_at: new Date(),
        updated_at: new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const i = rows.findIndex((r) => r.id === where.id);
      rows[i] = { ...rows[i], ...data };
      return rows[i];
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      rows.forEach((r, i) => {
        if (matches(r, where)) {
          rows[i] = { ...r, ...data };
          count += 1;
        }
      });
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
      return { count: 0 };
    }),
    createMany: jest.fn(async ({ data }: any) => {
      for (const d of data) rows.push({ id: `${prefix}-${rows.length + 1}`, ...d });
      return { count: data.length };
    }),
  };
}

function build() {
  const state = {
    users: [
      { id: 'coach-1', role: 'coach', name: 'Coach One', coach_profile: { timezone: 'America/Los_Angeles' } },
      { id: 'coach-2', role: 'coach', name: 'Coach Two', coach_profile: { timezone: 'UTC' } },
    ] as Row[],
    sessionTypes: [] as Row[],
    availability: [] as Row[],
    overrides: [] as Row[],
    sessions: [] as Row[],
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => state.users.find((u) => u.id === where.id) ?? null),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: any) => {
        const u = state.users.find((x) => x.id === where.user_id);
        return u?.coach_profile ?? null;
      }),
    },
    sessionType: table('st', state.sessionTypes),
    coachAvailability: table('av', state.availability),
    coachAvailabilityOverride: table('ov', state.overrides),
    coachingSession: table('sess', state.sessions),
    $executeRaw: jest.fn(async () => 1),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const audit = auditDouble({ write: jest.fn(async () => undefined) });
  const emitter = {
    emitRequested: jest.fn(async () => undefined),
    emitConfirmed: jest.fn(async () => undefined),
    emitDeclined: jest.fn(async () => undefined),
    emitCancelled: jest.fn(async () => undefined),
    emitRescheduled: jest.fn(async () => undefined),
  };
  const registry = new SchedulingProviderRegistry(
    new StubCalendarAdapter(),
    new GoogleCalendarAdapter(),
    new StubVideoAdapter(),
    new GoogleMeetAdapter(),
    new ZoomVideoAdapter(),
  );
  const svc = new SchedulingService(
    prisma,
    audit,
    registry,
    bookingEmitterDouble(emitter),
  );
  return { svc, prisma, state, emitter };
}

const actor = (over: Partial<{ id: string; role: 'student' | 'coach' | 'owner'; coach_id: string | null }>) => ({
  id: 'client-1',
  role: 'student' as const,
  email: null,
  coach_id: 'coach-1',
  ip: null,
  userAgent: null,
  ...over,
});
const CLIENT = actor({});
const FOREIGN_CLIENT = actor({ id: 'client-9', coach_id: 'coach-2' });
const UNATTACHED = actor({ id: 'client-8', coach_id: null });
const COACH = actor({ id: 'coach-1', role: 'coach', coach_id: null });
const OTHER_COACH = actor({ id: 'coach-2', role: 'coach', coach_id: null });

// Mon 2026-10-05. LA is UTC-7 (PDT). A Mon 09:00-12:00 LA window is
// 16:00-19:00Z.
const NOW = new Date('2026-10-01T12:00:00Z');

function seedType(state: ReturnType<typeof build>['state'], over: Row = {}) {
  const row = {
    id: `st-${state.sessionTypes.length + 1}`,
    coach_id: 'coach-1',
    name: 'Check-in',
    description: null,
    duration_minutes: 30,
    auto_approve: false,
    default_video_provider: 'stub',
    is_welcome: false,
    default_meeting_url: null,
    archived_at: null,
    created_at: new Date(),
    ...over,
  };
  state.sessionTypes.push(row);
  return row;
}

function seedMondayMorning(state: ReturnType<typeof build>['state'], over: Row = {}) {
  state.availability.push({
    id: `av-${state.availability.length + 1}`,
    coach_id: 'coach-1',
    day_of_week: 1,
    start_minute: 9 * 60,
    end_minute: 12 * 60,
    session_type_id: null,
    ...over,
  });
}

const book = (typeId: string, start = '2026-10-05T16:00:00.000Z', end = '2026-10-05T16:30:00.000Z') => ({
  coach_id: 'coach-1',
  session_type_id: typeId,
  title: 'Check-in',
  start_at: start,
  end_at: end,
});

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
});
afterAll(() => jest.useRealTimers());

describe('S-SCHED attachment-gated reads', () => {
  it('my-coaches returns only the assigned coach, with name and time zone', async () => {
    const { svc } = build();
    await expect(svc.listMyCoaches(CLIENT)).resolves.toEqual([
      { coach_id: 'coach-1', name: 'Coach One', timezone: 'America/Los_Angeles' },
    ]);
    await expect(svc.listMyCoaches(UNATTACHED)).resolves.toEqual([]);
    await expect(svc.listMyCoaches(COACH)).resolves.toEqual([]);
  });

  it('assigned client lists only active types, without the coach meeting link', async () => {
    const { svc, state } = build();
    seedType(state, { default_meeting_url: 'https://meet.example/room' });
    seedType(state, { name: 'Old', archived_at: new Date() });
    const rows = await svc.listSessionTypes(CLIENT, 'coach-1', { includeArchived: true });
    expect(rows.map((r) => r.name)).toEqual(['Check-in']);
    expect(rows[0].default_meeting_url).toBeNull();
  });

  it('the coach can include archived types and sees the meeting link', async () => {
    const { svc, state } = build();
    seedType(state, { default_meeting_url: 'https://meet.example/room' });
    seedType(state, { name: 'Old', archived_at: new Date() });
    const rows = await svc.listSessionTypes(COACH, 'coach-1', { includeArchived: true });
    expect(rows).toHaveLength(2);
    expect(rows[0].default_meeting_url).toBe('https://meet.example/room');
  });

  it.each([
    ['a client of another coach', FOREIGN_CLIENT],
    ['an unattached client', UNATTACHED],
    ['a different coach', OTHER_COACH],
  ])('%s cannot list types, availability or open slots', async (_label, who) => {
    const { svc, state } = build();
    seedType(state);
    await expect(svc.listSessionTypes(who, 'coach-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getAvailability(who, 'coach-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.getOpenSlots(who, 'coach-1', { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a client cannot book a coach they are not attached to', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    await expect(svc.requestSession(FOREIGN_CLIENT, book(t.id))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.requestSession(UNATTACHED, book(t.id))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('S-SCHED client booking rules', () => {
  it('requires an appointment type', async () => {
    const { svc, state } = build();
    seedMondayMorning(state);
    const { session_type_id: _drop, ...noType } = book('x');
    await expect(svc.requestSession(CLIENT, noType)).rejects.toMatchObject({
      response: { error: 'SESSION_TYPE_REQUIRED' },
    });
  });

  it('rejects an archived type and another coach\'s type', async () => {
    const { svc, state } = build();
    const archived = seedType(state, { archived_at: new Date() });
    const foreign = seedType(state, { coach_id: 'coach-2' });
    seedMondayMorning(state);
    await expect(svc.requestSession(CLIENT, book(archived.id))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.requestSession(CLIENT, book(foreign.id))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a length different from the type duration', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    await expect(
      svc.requestSession(CLIENT, book(t.id, '2026-10-05T16:00:00Z', '2026-10-05T17:00:00Z')),
    ).rejects.toMatchObject({ response: { error: 'DURATION_MISMATCH' } });
  });

  it('rejects a time outside the coach availability (409 SLOT_UNAVAILABLE)', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    // 08:00 LA = 15:00Z, before the 09:00 window.
    await expect(
      svc.requestSession(CLIENT, book(t.id, '2026-10-05T15:00:00Z', '2026-10-05T15:30:00Z')),
    ).rejects.toMatchObject({ response: { error: 'SLOT_UNAVAILABLE' } });
  });

  it('rejects a time on a full-day time-off override', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    state.overrides.push({
      id: 'ov-1',
      coach_id: 'coach-1',
      date: new Date('2026-10-05T00:00:00Z'),
      start_minute: null,
      end_minute: null,
      kind: 'holiday',
    });
    await expect(svc.requestSession(CLIENT, book(t.id))).rejects.toBeInstanceOf(ConflictException);
  });

  it('auto-approve type is confirmed instantly; otherwise it is requested', async () => {
    const { svc, state, emitter } = build();
    const auto = seedType(state, { auto_approve: true });
    const manual = seedType(state);
    seedMondayMorning(state);
    const a = await svc.requestSession(CLIENT, book(auto.id));
    expect(a.status).toBe('scheduled');
    expect(emitter.emitConfirmed).toHaveBeenCalledTimes(1);
    const m = await svc.requestSession(
      CLIENT,
      book(manual.id, '2026-10-05T17:00:00.000Z', '2026-10-05T17:30:00.000Z'),
    );
    expect(m.status).toBe('requested');
    expect(emitter.emitRequested).toHaveBeenCalledTimes(1);
  });

  it('an occupied slot (incl. pending_provider) is rejected', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    state.sessions.push({
      id: 'sess-x',
      coach_id: 'coach-1',
      client_id: 'client-2',
      status: 'pending_provider',
      start_at: new Date('2026-10-05T16:00:00Z'),
      end_at: new Date('2026-10-05T16:30:00Z'),
    });
    await expect(svc.requestSession(CLIENT, book(t.id))).rejects.toBeInstanceOf(ConflictException);
  });

  it('takes the per-coach advisory lock inside the booking transaction', async () => {
    const { svc, state, prisma } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    await svc.requestSession(CLIENT, book(t.id));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const values = prisma.$executeRaw.mock.calls[0].slice(1);
    expect(values).toContain('tgp.coaching_session.coach:coach-1');
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'ReadCommitted' });
  });

  it('client notes reach the coach notification payload', async () => {
    const { svc, state, emitter } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    await svc.requestSession(CLIENT, { ...book(t.id), notes: '  Knee feels better  ' });
    expect(emitter.emitRequested).toHaveBeenCalledWith(expect.objectContaining({ notes: 'Knee feels better' }));
  });

  it('client reschedule must land in open time and keep the type length', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    const s = await svc.requestSession(CLIENT, book(t.id));
    await expect(
      svc.rescheduleSession(CLIENT, s.id, { start_at: '2026-10-05T20:00:00Z', end_at: '2026-10-05T20:30:00Z' }),
    ).rejects.toMatchObject({ response: { error: 'SLOT_UNAVAILABLE' } });
    await expect(
      svc.rescheduleSession(CLIENT, s.id, { start_at: '2026-10-05T17:00:00Z', end_at: '2026-10-05T18:00:00Z' }),
    ).rejects.toMatchObject({ response: { error: 'DURATION_MISMATCH' } });
    // Moving within the window (its own old slot does not block it).
    const moved = await svc.rescheduleSession(CLIENT, s.id, {
      start_at: '2026-10-05T16:15:00Z',
      end_at: '2026-10-05T16:45:00Z',
    });
    expect(new Date(moved.start_at).toISOString()).toBe('2026-10-05T16:15:00.000Z');
  });
});

describe('S-SCHED state integrity and views', () => {
  it('a transition that lost a race returns 409 SESSION_STATE_CHANGED', async () => {
    const { svc, state, prisma } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    const s = await svc.requestSession(CLIENT, book(t.id));
    // Simulate a concurrent cancel landing between the read and the write.
    prisma.coachingSession.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await expect(svc.approveSession(COACH, s.id)).rejects.toMatchObject({
      response: { error: 'SESSION_STATE_CHANGED' },
    });
    expect(state.sessions[0].status).toBe('requested');
  });

  it('clients never receive coach-internal notes or provider bookkeeping', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state);
    const s = await svc.requestSession(CLIENT, book(t.id));
    Object.assign(state.sessions[0], {
      coach_notes_md: 'private',
      client_recap_md: 'Great work today',
      provider_idempotency_key: 'k',
      calendar_event_id: 'c',
      video_meeting_id: 'v',
    });
    const view = (await svc.getSession(CLIENT, s.id)) as Row;
    expect(view.coach_notes_md).toBeUndefined();
    expect(view.provider_idempotency_key).toBeUndefined();
    expect(view.calendar_event_id).toBeUndefined();
    expect(view.video_meeting_id).toBeUndefined();
    expect(view.client_recap_md).toBe('Great work today');
    const listed = (await svc.listUpcomingForActor(CLIENT)) as Row[];
    expect(listed[0].coach_notes_md).toBeUndefined();
    const coachView = (await svc.getSession(COACH, s.id)) as Row;
    expect(coachView.coach_notes_md).toBe('private');
  });

  it('upcoming keeps an in-progress session; past lists ended ones', async () => {
    const { svc, state } = build();
    state.sessions.push(
      { id: 'live', coach_id: 'coach-1', client_id: 'client-1', status: 'scheduled', start_at: new Date('2026-10-01T11:50:00Z'), end_at: new Date('2026-10-01T12:20:00Z') },
      { id: 'done', coach_id: 'coach-1', client_id: 'client-1', status: 'completed', start_at: new Date('2026-09-30T11:00:00Z'), end_at: new Date('2026-09-30T11:30:00Z') },
    );
    const up = (await svc.listUpcomingForActor(CLIENT, 25, 'upcoming')) as Row[];
    expect(up.map((r) => r.id)).toEqual(['live']);
    const past = (await svc.listUpcomingForActor(CLIENT, 25, 'past')) as Row[];
    expect(past.map((r) => r.id)).toEqual(['done']);
  });

  it('confirmed session gets the type default meeting link when no link exists', async () => {
    const { svc, state } = build();
    const t = seedType(state, { auto_approve: true, default_meeting_url: 'https://zoom.example/j/123' });
    seedMondayMorning(state);
    const s = (await svc.requestSession(CLIENT, book(t.id))) as Row;
    expect(s.video_url).toBe('https://zoom.example/j/123');
    expect(s.video_provider).toBe('manual');
  });

  it('a manual per-session link set before approval is not overwritten', async () => {
    const { svc, state } = build();
    const t = seedType(state, { default_meeting_url: 'https://zoom.example/j/123' });
    seedMondayMorning(state);
    const s = await svc.requestSession(CLIENT, book(t.id));
    await svc.attachManualVideoLink(COACH, s.id, { video_url: 'https://other.example/x' });
    const approved = (await svc.approveSession(COACH, s.id)) as Row;
    expect(approved.video_url).toBe('https://other.example/x');
  });

  it('marking a type as the welcome type clears the flag on the others', async () => {
    const { svc, state } = build();
    const first = seedType(state, { is_welcome: true });
    const created = await svc.createSessionType(COACH, {
      name: 'Quick initialization',
      duration_minutes: 15,
      auto_approve: true,
      is_welcome: true,
    });
    expect(state.sessionTypes.find((r) => r.id === first.id)?.is_welcome).toBe(false);
    expect(created.is_welcome).toBe(true);
    await svc.updateSessionType(COACH, first.id, { is_welcome: true });
    expect(state.sessionTypes.filter((r) => r.is_welcome).map((r) => r.id)).toEqual([first.id]);
  });
});

describe('S-SCHED open slots', () => {
  it('uses the type duration and only unscoped or same-type windows', async () => {
    const { svc, state } = build();
    const quick = seedType(state, { duration_minutes: 15 });
    const other = seedType(state, { duration_minutes: 45 });
    // Mon 09:00-09:30 for everyone; Mon 10:00-11:00 only for `other`.
    seedMondayMorning(state, { start_minute: 9 * 60, end_minute: 9 * 60 + 30 });
    seedMondayMorning(state, { start_minute: 10 * 60, end_minute: 11 * 60, session_type_id: other.id });
    const range = { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' };
    const q = await svc.getOpenSlots(CLIENT, 'coach-1', { ...range, session_type_id: quick.id });
    expect(q.slots.map((s) => s.start_at)).toEqual(['2026-10-05T16:00:00.000Z', '2026-10-05T16:15:00.000Z']);
    expect(q.timezone).toBe('America/Los_Angeles');
    const o = await svc.getOpenSlots(CLIENT, 'coach-1', { ...range, session_type_id: other.id });
    expect(o.slots.map((s) => s.start_at)).toEqual(['2026-10-05T17:00:00.000Z']);
  });

  it('rejects an archived session type', async () => {
    const { svc, state } = build();
    const t = seedType(state, { archived_at: new Date() });
    await expect(
      svc.getOpenSlots(CLIENT, 'coach-1', { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z', session_type_id: t.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drops slots that start within the 5-minute lead time', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    // Thursday 2026-10-01 05:00-06:00 LA = 12:00-13:00Z; now is 12:00Z.
    state.availability.push({ id: 'av-thu', coach_id: 'coach-1', day_of_week: 4, start_minute: 300, end_minute: 360, session_type_id: null });
    const r = await svc.getOpenSlots(CLIENT, 'coach-1', {
      from: '2026-10-01T11:00:00Z',
      to: '2026-10-01T14:00:00Z',
      session_type_id: t.id,
    });
    expect(r.slots.map((s) => s.start_at)).toEqual(['2026-10-01T12:30:00.000Z']);
  });

  it('a booked slot disappears immediately (cache invalidated on booking)', async () => {
    const { svc, state } = build();
    const t = seedType(state);
    seedMondayMorning(state, { end_minute: 10 * 60 });
    const args = { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z', session_type_id: t.id };
    expect((await svc.getOpenSlots(CLIENT, 'coach-1', args)).slots).toHaveLength(2);
    await svc.requestSession(CLIENT, book(t.id));
    expect((await svc.getOpenSlots(CLIENT, 'coach-1', args)).slots.map((s) => s.start_at)).toEqual([
      '2026-10-05T16:30:00.000Z',
    ]);
  });
});

describe('S-SCHED DTO compatibility with the mobile contract', () => {
  async function errors(cls: any, body: object) {
    const inst = plainToInstance(cls, body);
    const errs = await validate(inst as object, { whitelist: true, forbidNonWhitelisted: true });
    return errs.map((e) => e.property);
  }

  it('accepts client_timezone and notes on request and reschedule', async () => {
    expect(
      await errors(RequestSessionDto, {
        ...book('3f1c9f7e-8f0a-4b8e-9a3a-0d4c2b1e5f6a'),
        coach_id: '3f1c9f7e-8f0a-4b8e-9a3a-0d4c2b1e5f6b',
        client_timezone: 'America/New_York',
        notes: 'hello',
      }),
    ).toEqual([]);
    expect(
      await errors(RescheduleSessionDto, {
        start_at: '2026-10-05T16:00:00Z',
        end_at: '2026-10-05T16:30:00Z',
        client_timezone: 'Etc/GMT+5',
      }),
    ).toEqual([]);
  });

  it('rejects a malformed time zone and over-long notes', async () => {
    const base = {
      ...book('3f1c9f7e-8f0a-4b8e-9a3a-0d4c2b1e5f6a'),
      coach_id: '3f1c9f7e-8f0a-4b8e-9a3a-0d4c2b1e5f6b',
    };
    expect(await errors(RequestSessionDto, { ...base, client_timezone: 'x; drop' })).toContain('client_timezone');
    expect(await errors(RequestSessionDto, { ...base, notes: 'a'.repeat(501) })).toContain('notes');
  });

  it('meeting links must be https; null clears on update', async () => {
    expect(
      await errors(CreateSessionTypeDto, { name: 'a', duration_minutes: 15, default_meeting_url: 'http://x.example/a' }),
    ).toContain('default_meeting_url');
    expect(
      await errors(CreateSessionTypeDto, { name: 'a', duration_minutes: 15, default_meeting_url: 'https://x.example/a', is_welcome: true }),
    ).toEqual([]);
    expect(await errors(UpdateSessionTypeDto, { default_meeting_url: null })).toEqual([]);
  });
});
