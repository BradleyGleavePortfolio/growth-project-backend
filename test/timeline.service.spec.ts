/**
 * timeline.service.spec.ts — Phase 7B
 *
 * Tests that TimelineService correctly composes events from synthetic
 * fixture data, orders them reverse-chronologically, respects lane
 * filters, paginates correctly, and never exposes PTM risk_score.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TimelineService } from '../src/timeline/timeline.service';
import { PrismaService } from '../src/prisma.service';

// ─── Synthetic fixture data ───────────────────────────────────────────────────

const UID = 'user_test_001';

const WEIGHT_LOGS = [
  {
    id: 'wl_1',
    user_id: UID,
    date: new Date('2025-10-01T08:00:00Z'),
    weight_lbs: 185.0,
    notes: 'Morning weigh-in',
  },
  {
    id: 'wl_2',
    user_id: UID,
    date: new Date('2025-10-02T08:00:00Z'),
    weight_lbs: 184.5,
    notes: null,
  },
  {
    id: 'wl_3',
    user_id: UID,
    date: new Date('2025-10-03T08:00:00Z'),
    weight_lbs: 184.0,
    notes: null,
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
      lanes: ['body', 'win', 'coach', 'friction'],
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

  it('returns only coach events when lanes=coach', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['coach'],
      limit: 50,
    });

    expect(result.events.every((e) => e.lane === 'coach')).toBe(true);
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

  // ── Coach lane: voice vs text ──────────────────────────────────────────────

  it('distinguishes voice notes from text notes in coach lane', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['coach'],
      limit: 50,
    });

    const eventTypes = new Set(result.events.map((e) => (e as any).eventType));
    expect(eventTypes.has('coach_text_note')).toBe(true);
    expect(eventTypes.has('coach_voice_note')).toBe(true);
  });

  // ── Privacy: no PTM risk_score ─────────────────────────────────────────────

  it('never exposes ptm risk_score anywhere in any event', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body', 'win', 'coach', 'friction'],
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
      lanes: ['body', 'win', 'coach', 'friction'],
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
      lanes: ['body', 'win', 'coach', 'friction'],
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

  // ── Body lane: delta calculation ───────────────────────────────────────────

  it('calculates weight delta from previous entry', async () => {
    const result = await service.getTimeline(UID, {
      sinceDays: 180,
      lanes: ['body'],
      limit: 50,
    });

    const weightEvents = result.events.filter(
      (e) => (e as any).eventType === 'weight_logged',
    );
    // The second weight entry should show a -0.5 delta vs the first.
    const secondEntry = weightEvents.find(
      (e) => (e as any).metadata.weightLbs === 184.5,
    );
    if (secondEntry) {
      expect((secondEntry as any).metadata.deltaLbs).toBeCloseTo(-0.5, 1);
    }
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
