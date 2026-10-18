/**
 * timeline.service.spec.ts — Phase 7B
 *
 * Tests that TimelineService correctly composes events from synthetic
 * fixture data, orders them reverse-chronologically, respects lane
 * filters, paginates correctly, never exposes PTM risk_score, and never reads
 * a coach message (#TIMELINE-COACH op 1; live proof in
 * test/rls/timeline-no-coach-messages-rls.spec.ts).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TimelineService } from '../src/timeline/timeline.service';
import { PrismaService } from '../src/prisma.service';

// ─── Synthetic fixture data ───────────────────────────────────────────────────

const UID = 'user_test_001';

// Newest first, as the service's orderBy returns them.
const WEIGHT_LOGS = [
  {
    id: 'wl_3',
    user_id: UID,
    date: new Date('2025-10-03T08:00:00Z'),
    weight_lbs: 184.0,
    notes: null,
  },
  {
    id: 'wl_2',
    user_id: UID,
    date: new Date('2025-10-02T08:00:00Z'),
    weight_lbs: 184.5,
    notes: null,
  },
  {
    id: 'wl_1',
    user_id: UID,
    date: new Date('2025-10-01T08:00:00Z'),
    weight_lbs: 185.0,
    notes: 'Morning weigh-in',
  },
];

const STREAK_SIGNALS = [
  {
    id: 'sig_streak_7',
    user_id: UID,
    signal_type: 'checkin_streak',
    value: 7,
    recorded_at: new Date('2025-10-08T09:00:00Z'),
    metadata: null,
  },
  {
    id: 'sig_streak_30',
    user_id: UID,
    signal_type: 'checkin_streak',
    value: 30,
    recorded_at: new Date('2025-11-01T09:00:00Z'),
    metadata: null,
  },
];

const FINANCE_SIGNALS = [
  {
    id: 'sig_fin_1',
    user_id: UID,
    signal_type: 'finance_milestone',
    value: 1,
    recorded_at: new Date('2025-10-15T12:00:00Z'),
    metadata: { milestoneRef: 'goal_networth_1k' },
  },
];

const BUILD_WEEK_COMPLETIONS = [
  {
    id: 'bw_1',
    user_id: UID,
    status: 'completed',
    current_day: 7,
    completed_at: new Date('2025-10-10T17:00:00Z'),
  },
];

// A tripwire: the service must never read these.
const COACH_MESSAGES = [
  {
    id: 'msg_1',
    client_id: UID,
    from_user_id: 'coach_001',
    body: 'Great week. Keep the momentum going.',
    voice_url: null,
    voice_duration_sec: null,
    created_at: new Date('2025-10-06T14:00:00Z'),
    fromUser: { name: 'Coach Alex' },
  },
  {
    id: 'msg_2',
    client_id: UID,
    from_user_id: 'coach_001',
    body: null,
    voice_url: 'https://storage.example/voice_001.m4a',
    voice_duration_sec: 42,
    created_at: new Date('2025-10-20T10:00:00Z'),
    fromUser: { name: 'Coach Alex' },
  },
];

const MISS_SIGNALS = [
  {
    id: 'sig_miss_1',
    user_id: UID,
    signal_type: 'checkin_miss',
    value: 3,
    recorded_at: new Date('2025-10-25T09:00:00Z'),
    metadata: null,
  },
];

// ─── Prisma mock factory ───────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    weightLog: {
      findMany: jest.fn().mockResolvedValue(WEIGHT_LOGS),
    },
    userProfile: {
      findUnique: jest.fn().mockResolvedValue({ weight_unit: 'lbs' }),
    },
    clientSignal: {
      findMany: jest.fn().mockImplementation(({ where }) => {
        const type = where?.signal_type;
        if (type === 'checkin_streak') return Promise.resolve(STREAK_SIGNALS);
        if (type === 'finance_milestone') return Promise.resolve(FINANCE_SIGNALS);
        if (type === 'checkin_miss') return Promise.resolve(MISS_SIGNALS);
        return Promise.resolve([]);
      }),
    },
    buildWeekEnrollment: {
      findMany: jest.fn().mockResolvedValue(BUILD_WEEK_COMPLETIONS),
    },
    coachMessage: {
      findMany: jest.fn().mockResolvedValue(COACH_MESSAGES),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TimelineService', () => {
  let service: TimelineService;
  let prismaMock: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prismaMock = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<TimelineService>(TimelineService);
  });

  // ── Ordering ───────────────────────────────────────────────────────────────

  it('returns events in reverse-chronological order', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body', 'win', 'friction'],
      limit: 50,
    });

    const timestamps = result.events.map((e) => new Date(e.at).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });

  // ── Lane filtering ─────────────────────────────────────────────────────────

  it('returns only body events when lanes=body', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body'],
      limit: 50,
    });

    expect(result.events.every((e) => e.lane === 'body')).toBe(true);
    expect(prismaMock.coachMessage.findMany).not.toHaveBeenCalled();
    expect(prismaMock.clientSignal.findMany).not.toHaveBeenCalled();
  });

  it('returns only win events when lanes=win', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['win'],
      limit: 50,
    });

    expect(result.events.every((e) => e.lane === 'win')).toBe(true);
    expect(prismaMock.weightLog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.coachMessage.findMany).not.toHaveBeenCalled();
  });

  it('returns only friction events when lanes=friction', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['friction'],
      limit: 50,
    });

    expect(result.events.every((e) => e.lane === 'friction')).toBe(true);
  });

  // ── Win events: streak thresholds ──────────────────────────────────────────

  it('produces one win event per distinct streak threshold crossing', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['win'],
      limit: 50,
    });

    const streakMilestones = result.events.filter(
      (e) => e.lane === 'win' && (e as any).eventType === 'checkin_streak_milestone',
    );
    expect(streakMilestones.length).toBe(STREAK_SIGNALS.length);
  });

  // ── Build Week Day 7 event ──────────────────────────────────────────────────

  it('includes a build_week_complete event for day-7 enrollment completion', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['win'],
      limit: 50,
    });

    const bwEvent = result.events.find(
      (e) => (e as any).eventType === 'build_week_complete',
    );
    expect(bwEvent).toBeDefined();
    expect((bwEvent as any).metadata.dayCompleted).toBe(7);
  });

  // ── No coach lane ──────────────────────────────────────────────────────────

  it('never reads a coach message, whatever lanes are asked for', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body', 'win', 'friction'],
      limit: 50,
    });

    expect(prismaMock.coachMessage.findMany).not.toHaveBeenCalled();
    expect(new Set(result.events.map((e) => e.lane))).toEqual(new Set(['body', 'win', 'friction']));
    const words = result.events.map((e) => `${e.title} ${e.body ?? ''}`).join(' ');
    expect(words).not.toMatch(/Coach Alex|momentum|note/i);
  });

  // ── Privacy: no PTM risk_score ─────────────────────────────────────────────

  it('never exposes ptm risk_score anywhere in any event', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body', 'win', 'friction'],
      limit: 50,
    });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toMatch(/risk_score/i);
    expect(serialised).not.toMatch(/riskScore/i);
    expect(serialised).not.toMatch(/ptm_score/i);
  });

  // ── Pagination ─────────────────────────────────────────────────────────────

  it('returns nextCursor when more events exist beyond the limit', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body', 'win', 'friction'],
      limit: 2,
    });

    // With our fixture data there are more than 2 events total.
    if (result.total > 2) {
      expect(result.nextCursor).not.toBeNull();
      expect(typeof result.nextCursor).toBe('string');
    }
    expect(result.events.length).toBeLessThanOrEqual(2);
  });

  it('returns null nextCursor when all events fit in one page', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body', 'win', 'friction'],
      limit: 50,
    });

    expect(result.nextCursor).toBeNull();
  });

  // ── User isolation ─────────────────────────────────────────────────────────

  it('queries only the provided userId — never all users', async () => {
    await service.getTimeline(UID, {
      sinceDays: 30,
      lanes: ['body'],
      limit: 10,
    });

    // Every Prisma call must have been scoped to user_id: UID.
    const calls = prismaMock.weightLog.findMany.mock.calls;
    calls.forEach((call: any[]) => {
      expect(call[0]?.where?.user_id).toBe(UID);
    });
  });

  // ── Body lane: unit and trend ──────────────────────────────────────────────

  const bodyRows = async () =>
    (await service.getTimeline(UID, { sinceDays: 180, lanes: ['body'], limit: 50 })).events.map(
      ({ title, body, metadata }) => ({ title, body, metadata }),
    );

  it('shows each weigh-in with the C8 trend from the second day, notes kept', async () => {
    expect(await bodyRows()).toEqual([
      { title: 'Weighed in at 184.0 lb', body: 'Trend 184.9 lb', metadata: { weightLbs: 184.0, trendLbs: expect.closeTo(184.855, 6) } },
      { title: 'Weighed in at 184.5 lb', body: 'Trend 185.0 lb', metadata: { weightLbs: 184.5, trendLbs: expect.closeTo(184.95, 6) } },
      { title: 'Weighed in at 185.0 lb', body: 'Morning weigh-in', metadata: { weightLbs: 185.0, trendLbs: null } },
    ]);
  });

  it("shows weigh-ins in the client's unit", async () => {
    prismaMock.userProfile.findUnique.mockResolvedValue({ weight_unit: 'kg' });
    const [newest] = await bodyRows();
    expect([newest.title, newest.body]).toEqual(['Weighed in at 83.5 kg', 'Trend 83.8 kg']);
    expect(prismaMock.userProfile.findUnique).toHaveBeenCalledWith({ where: { user_id: UID }, select: { weight_unit: true } });
  });

  // ── Wording ────────────────────────────────────────────────────────────────

  it('words streaks, Build Week and missed check-ins plainly, with no count on a miss', async () => {
    const result = await service.getTimeline(UID, { sinceDays: 180, lanes: ['win', 'friction'], limit: 50 });
    const words = result.events
      .filter((e) => e.eventType !== 'finance_milestone')
      .map(({ title, body }) => [title, body]);
    expect(words).toEqual([
      ['30 days of check-ins in a row', undefined],
      ['No check-in', undefined],
      ['Build Week complete, day 7 of 7', undefined],
      ['7 days of check-ins in a row', undefined],
    ]);
  });

  // ── Friction lane: consecutive miss count ──────────────────────────────────

  it('reports the correct consecutive miss count in friction events', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['friction'],
      limit: 50,
    });

    const missEvent = result.events[0] as any;
    expect(missEvent.eventType).toBe('missed_checkin');
    expect(missEvent.metadata.consecutiveMisses).toBe(3);
  });
});
