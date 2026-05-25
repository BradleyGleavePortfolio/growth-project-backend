// test/coach-brief.service.spec.ts
//
// R43 Coach Brief — unit tests. The Anthropic client is injected via
// BRIEF_ANTHROPIC_CLIENT_TOKEN so no network traffic occurs.
//
// We mock prisma per-method with jest.fn rather than constructing a full
// fake, because the service issues many distinct queries (some via raw
// SQL) and the goal of these tests is behaviour, not query plumbing.

import {
  CoachBriefService,
  buildActionItems,
  buildBriefPrompt,
  buildFallbackNarrative,
  buildHeadCoachSystemPrompt,
  buildSoloCoachSystemPrompt,
  bucketDateLocal,
} from '../src/coach/brief/coach-brief.service';
import type {
  BriefContext,
  BriefContextHeadCoach,
} from '../src/coach/brief/coach-brief.types';
import { CoachBriefScheduler } from '../src/coach/brief/coach-brief.scheduler';
import { CoachDailyLogService } from '../src/coach/brief/coach-daily-log.service';
import { CoachBriefPreferencesService } from '../src/coach/brief/coach-brief-preferences.service';

// ─── Helpers ───────────────────────────────────────────────────────────

function makePrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coachBrief: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coachDailyLog: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    coachBriefPreferences: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    checkIn: {
      findMany: jest.fn(),
    },
    clientPurchase: {
      aggregate: jest.fn(),
      count: jest.fn(),
    },
    coachMessage: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
}

function makeAnthropic(textOrError: string | Error) {
  return {
    messages: {
      create: jest.fn(async () => {
        if (textOrError instanceof Error) throw textOrError;
        return { content: [{ type: 'text', text: textOrError }] };
      }),
    },
  } as any;
}

function makeConfig(values: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn((k: string) => values[k]),
  } as any;
}

function makeContext(overrides: Partial<BriefContext> = {}): BriefContext {
  return {
    brief_mode: 'solo_coach',
    date: '2026-05-25',
    checked_in_today: 5,
    missed_checkin: 2,
    workouts_pending_approval: 1,
    workouts_approved_today: 0,
    paid_today_count: 0,
    revenue_today_cents: 0,
    renewals_upcoming_7d: 0,
    dunning_in_progress: 0,
    weight_logs_flagged: 0,
    unread_messages: 0,
    coach_name: 'Sarah Johnson',
    coach_first_name: 'Sarah',
    roster_size: 7,
    ...overrides,
  };
}

// Mock everything the solo aggregator queries so we can call generateBrief.
function wireDefaultMocks(prisma: any, coachId: string, clientIds: string[]) {
  prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);
  prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
  prisma.teamSubCoachAssignment.count.mockResolvedValue(0);
  prisma.user.findMany
    // resolveClientScope -> students under coach
    .mockResolvedValueOnce(clientIds.map((id) => ({ id })))
    // aggregateSoloContext -> missing check-in clients
    .mockResolvedValueOnce([]);
  prisma.user.findUnique.mockResolvedValue({ name: 'Sarah Johnson' });
  prisma.checkIn.findMany.mockResolvedValue([]);
  prisma.clientWorkoutAssignment.findMany.mockResolvedValue([]);
  prisma.clientWorkoutAssignment.count.mockResolvedValue(0);
  prisma.clientPurchase.aggregate.mockResolvedValue({
    _sum: { amount_cents: null },
    _count: { _all: 0 },
  });
  prisma.clientPurchase.count.mockResolvedValue(0);
  prisma.coachMessage.findMany.mockResolvedValue([]);
  prisma.$queryRaw.mockResolvedValue([{ count: 0n }, { total: 0n }]); // dunning queries
}

// ─── Mode detection ────────────────────────────────────────────────────

describe('CoachBriefService.detectBriefMode', () => {
  it('returns sub_coach when an active TeamSubCoachAssignment exists as sub_coach_id', async () => {
    const prisma = makePrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue({ id: 'a1' });

    const svc = new CoachBriefService(prisma as any, makeConfig());
    expect(await svc.detectBriefMode('coach1')).toBe('sub_coach');
    // We never read the head-coach count path
    expect(prisma.teamSubCoachAssignment.count).not.toHaveBeenCalled();
  });

  it('returns head_coach when sub_coach assignments exist as head_coach_id', async () => {
    const prisma = makePrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
    prisma.teamSubCoachAssignment.count.mockResolvedValue(2);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    expect(await svc.detectBriefMode('coach1')).toBe('head_coach');
  });

  it('returns solo_coach when no active TeamSubCoachAssignment exists in either direction', async () => {
    const prisma = makePrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
    prisma.teamSubCoachAssignment.count.mockResolvedValue(0);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    expect(await svc.detectBriefMode('coach1')).toBe('solo_coach');
  });

  it('sub_coach takes precedence over head_coach when both directions exist', async () => {
    const prisma = makePrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue({ id: 'a1' });
    prisma.teamSubCoachAssignment.count.mockResolvedValue(3);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    expect(await svc.detectBriefMode('coach1')).toBe('sub_coach');
  });
});

// ─── Sub-coach scoping ────────────────────────────────────────────────

describe('CoachBriefService.resolveClientScope', () => {
  it('returns full direct roster for solo_coach', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    const result = await svc.resolveClientScope('coach1', 'solo_coach');
    expect(result).toEqual(['c1', 'c2']);
    // We hit User.findMany, not the assignment table
    expect(prisma.clientWorkoutAssignment.findMany).not.toHaveBeenCalled();
  });

  it('returns full direct roster for head_coach', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValue([{ id: 'c1' }]);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    const result = await svc.resolveClientScope('coach1', 'head_coach');
    expect(result).toEqual(['c1']);
  });

  it('returns only assigned clients for sub_coach (derived from ClientWorkoutAssignment)', async () => {
    const prisma = makePrisma();
    prisma.clientWorkoutAssignment.findMany.mockResolvedValue([
      { client_id: 'c1' },
      { client_id: 'c2' },
    ]);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    const result = await svc.resolveClientScope('subCoach1', 'sub_coach');
    expect(result).toEqual(['c1', 'c2']);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('returns empty array for sub_coach with no assignments', async () => {
    const prisma = makePrisma();
    prisma.clientWorkoutAssignment.findMany.mockResolvedValue([]);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    expect(await svc.resolveClientScope('subCoach1', 'sub_coach')).toEqual([]);
  });
});

// ─── Idempotency / cached return ──────────────────────────────────────

describe('CoachBriefService.generateBrief idempotency', () => {
  it('returns cached row when status=generated exists', async () => {
    const prisma = makePrisma();
    const existing = {
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generated',
      generated_at: new Date('2026-05-25T07:00:00Z'),
      narrative: 'cached',
      brief_context: {
        brief_mode: 'solo_coach',
        date: '2026-05-25',
        checked_in_today: 1,
        missed_checkin: 0,
        workouts_pending_approval: 0,
        workouts_approved_today: 0,
        paid_today_count: 0,
        revenue_today_cents: 0,
        renewals_upcoming_7d: 0,
        dunning_in_progress: 0,
        weight_logs_flagged: 0,
        unread_messages: 0,
        coach_name: 'Sarah',
        coach_first_name: 'Sarah',
        roster_size: 1,
      },
      action_items: [],
      generated_by: 'ai',
      brief_mode: 'solo_coach',
      created_at: new Date('2026-05-25T00:00:00Z'),
    };
    prisma.coachBrief.findUnique.mockResolvedValue(existing);

    const svc = new CoachBriefService(prisma as any, makeConfig());
    const result = await svc.generateBrief(
      'coach1',
      'America/Los_Angeles',
      '2026-05-25',
    );

    expect(result.summary?.narrative).toBe('cached');
    expect(prisma.coachBrief.upsert).not.toHaveBeenCalled();
    expect(prisma.coachBrief.update).not.toHaveBeenCalled();
  });

  it('forces regeneration when opts.force is true', async () => {
    const prisma = makePrisma();
    prisma.coachBrief.findUnique.mockResolvedValue({
      id: 'b1',
      status: 'generated',
    });
    prisma.coachBrief.upsert.mockResolvedValue({});
    wireDefaultMocks(prisma, 'coach1', []);
    prisma.coachBrief.update.mockResolvedValue({
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generated',
      generated_at: new Date(),
      narrative: 'fresh',
      brief_context: makeContext({ brief_mode: 'solo_coach', roster_size: 0 }),
      action_items: [],
      generated_by: 'fallback',
      brief_mode: 'solo_coach',
      created_at: new Date(),
    });

    const svc = new CoachBriefService(prisma as any, makeConfig());
    const result = await svc.generateBrief(
      'coach1',
      'America/Los_Angeles',
      '2026-05-25',
      { force: true },
    );
    expect(result.summary?.narrative).toBe('fresh');
    expect(prisma.coachBrief.update).toHaveBeenCalled();
  });
});

// ─── Claude call + fallback ───────────────────────────────────────────

describe('CoachBriefService.callClaude', () => {
  it('returns ai narrative when Claude succeeds', async () => {
    const prisma = makePrisma();
    const anthropic = makeAnthropic(
      'Sarah, 5 clients checked in this morning. We flagged 1 workout for your eyes — Here is what needs your eyes:',
    );
    const svc = new CoachBriefService(prisma as any, makeConfig(), anthropic);

    const result = await svc.callClaude(
      makeContext({ workouts_pending_approval: 1, missed_checkin: 0 }),
    );

    expect(result.generated_by).toBe('ai');
    expect(result.narrative).toMatch(/Sarah/);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  it('falls back when Claude throws', async () => {
    const prisma = makePrisma();
    const anthropic = makeAnthropic(new Error('boom'));
    const svc = new CoachBriefService(prisma as any, makeConfig(), anthropic);

    const result = await svc.callClaude(
      makeContext({ workouts_pending_approval: 1 }),
    );
    expect(result.generated_by).toBe('fallback');
    expect(result.narrative).toMatch(/Sarah/);
  });

  it('falls back when Claude returns empty text', async () => {
    const prisma = makePrisma();
    const anthropic = makeAnthropic('   ');
    const svc = new CoachBriefService(prisma as any, makeConfig(), anthropic);

    const result = await svc.callClaude(
      makeContext({ workouts_pending_approval: 1 }),
    );
    expect(result.generated_by).toBe('fallback');
  });

  it('skips Claude entirely on the zero-action fast path', async () => {
    const prisma = makePrisma();
    const anthropic = makeAnthropic('should not be called');
    const svc = new CoachBriefService(prisma as any, makeConfig(), anthropic);

    const result = await svc.callClaude(
      makeContext({
        checked_in_today: 5,
        missed_checkin: 0,
        workouts_pending_approval: 0,
        weight_logs_flagged: 0,
        unread_messages: 0,
      }),
    );
    expect(result.generated_by).toBe('fallback');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('falls back when ANTHROPIC_API_KEY is missing', async () => {
    const prisma = makePrisma();
    // No injected client and no API key in config -> getAnthropicClient throws
    const svc = new CoachBriefService(prisma as any, makeConfig());

    const result = await svc.callClaude(
      makeContext({ workouts_pending_approval: 1 }),
    );
    expect(result.generated_by).toBe('fallback');
  });

  it('clamps narrative to BRIEF_MAX_NARRATIVE_CHARS', async () => {
    const prisma = makePrisma();
    const longText = 'a'.repeat(800);
    const anthropic = makeAnthropic(longText);
    const svc = new CoachBriefService(prisma as any, makeConfig(), anthropic);

    const result = await svc.callClaude(
      makeContext({ workouts_pending_approval: 1 }),
    );
    expect(result.narrative.length).toBeLessThanOrEqual(600);
  });

  it('uses head-coach system prompt when brief_mode=head_coach', async () => {
    const prisma = makePrisma();
    const anthropic = makeAnthropic('Marcus, your team collected $4,200 today.');
    const svc = new CoachBriefService(prisma as any, makeConfig(), anthropic);

    const ctx: BriefContextHeadCoach = {
      ...makeContext({
        workouts_pending_approval: 1,
        coach_name: 'Marcus Reed',
        coach_first_name: 'Marcus',
      }),
      brief_mode: 'head_coach',
      team_size: 2,
      team_clients_total: 50,
      total_revenue_today_cents: 420000,
      team_revenue_30d_cents: 2840000,
      mrr_projected_cents: 1280000,
      dunning_amount_cents: 38000,
      new_clients_last_24h: 2,
      sub_coach_highlights: [
        { coach_name: 'Coach Priya', new_clients_24h: 2, active_clients: 25 },
      ],
    };

    await svc.callClaude(ctx);

    const call = anthropic.messages.create.mock.calls[0][0];
    expect(call.system).toContain('runs a team');
    expect(call.messages[0].content).toContain('TEAM BUSINESS METRICS');
  });
});

// ─── Pure helpers ──────────────────────────────────────────────────────

describe('buildBriefPrompt', () => {
  it('includes the coach first name and numeric fields', () => {
    const out = buildBriefPrompt(makeContext({ coach_first_name: 'Sarah' }));
    expect(out).toContain('Coach first name: Sarah');
    expect(out).toContain('Roster size: 7');
    expect(out).toContain('Check-ins received today: 5');
  });

  it('does not include the head-coach business section in solo_coach mode', () => {
    const out = buildBriefPrompt(makeContext({ brief_mode: 'solo_coach' }));
    expect(out).not.toContain('TEAM BUSINESS METRICS');
  });

  it('includes team business section in head_coach mode', () => {
    const out = buildBriefPrompt({
      ...makeContext(),
      brief_mode: 'head_coach',
      team_size: 2,
      team_clients_total: 50,
      total_revenue_today_cents: 420000,
      team_revenue_30d_cents: 2840000,
      mrr_projected_cents: 1280000,
      dunning_amount_cents: 38000,
      new_clients_last_24h: 2,
      sub_coach_highlights: [
        { coach_name: 'Priya', new_clients_24h: 2, active_clients: 25 },
      ],
    } as BriefContextHeadCoach);
    expect(out).toContain('TEAM BUSINESS METRICS');
    expect(out).toContain('Team revenue today: $4200');
    expect(out).toContain('Priya: 25 clients');
  });
});

describe('buildFallbackNarrative', () => {
  it('returns all-clear when total action count is zero', () => {
    const out = buildFallbackNarrative(
      makeContext({
        checked_in_today: 3,
        missed_checkin: 0,
        workouts_pending_approval: 0,
        weight_logs_flagged: 0,
        unread_messages: 0,
      }),
    );
    expect(out).toMatch(/All clear/);
    expect(out).toMatch(/Sarah/);
  });

  it('mentions workouts pending approval when present', () => {
    const out = buildFallbackNarrative(
      makeContext({
        workouts_pending_approval: 2,
        missed_checkin: 0,
        weight_logs_flagged: 0,
        unread_messages: 0,
      }),
    );
    expect(out).toMatch(/2 workouts waiting on approval/);
  });

  it('uses singular plurals correctly', () => {
    const out = buildFallbackNarrative(
      makeContext({
        workouts_pending_approval: 1,
        missed_checkin: 0,
        weight_logs_flagged: 0,
        unread_messages: 0,
      }),
    );
    expect(out).toMatch(/1 workout waiting on approval/);
  });
});

describe('buildActionItems', () => {
  it('sorts by priority ASC then by type alphabetically', () => {
    const items = buildActionItems({
      pendingWorkouts: [
        { id: 'w1', client_id: 'c1', client_name: 'Alex', plan_name: 'Upper' },
      ],
      unreadThreads: [
        { client_id: 'c2', client_name: 'Bea', message_preview: 'hi' },
      ],
      flaggedWeightLogs: [
        { client_id: 'c3', client_name: 'Cy', delta_lbs: 5.2 },
      ],
      missingCheckinClients: [{ id: 'c4', name: 'Dan' }],
    });
    expect(items.map((i) => i.priority)).toEqual([1, 1, 2, 3]);
    // priority 1: message_unread < workout_approval alphabetically
    expect(items[0].type).toBe('message_unread');
    expect(items[1].type).toBe('workout_approval');
  });

  it('caps missing check-in items at 5', () => {
    const items = buildActionItems({
      pendingWorkouts: [],
      unreadThreads: [],
      flaggedWeightLogs: [],
      missingCheckinClients: Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        name: `Client ${i}`,
      })),
    });
    expect(items.filter((i) => i.type === 'checkin_missing')).toHaveLength(5);
  });

  it('returns an empty array when no inputs', () => {
    const items = buildActionItems({
      pendingWorkouts: [],
      unreadThreads: [],
      flaggedWeightLogs: [],
      missingCheckinClients: [],
    });
    expect(items).toEqual([]);
  });
});

describe('buildSoloCoachSystemPrompt / buildHeadCoachSystemPrompt', () => {
  it('solo prompt mentions warm voice + first-person plural', () => {
    const p = buildSoloCoachSystemPrompt();
    expect(p).toContain('first-person plural');
    expect(p).toContain('first name');
  });

  it('head-coach prompt mentions COO + revenue', () => {
    const p = buildHeadCoachSystemPrompt();
    expect(p).toContain('COO');
    expect(p).toContain('team');
  });
});

// ─── bucketDateLocal sanity ─────────────────────────────────────────────

describe('bucketDateLocal', () => {
  it('returns YYYY-MM-DD format', () => {
    const d = new Date('2026-05-25T08:00:00Z');
    expect(bucketDateLocal(d, 'America/Los_Angeles')).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('respects the supplied timezone (Sydney rolls over before UTC)', () => {
    // 23:00 UTC on May 24 = May 25 09:00 in Sydney
    const d = new Date('2026-05-24T23:00:00Z');
    expect(bucketDateLocal(d, 'Australia/Sydney')).toBe('2026-05-25');
    expect(bucketDateLocal(d, 'America/Los_Angeles')).toBe('2026-05-24');
  });
});

// ─── Scheduler ─────────────────────────────────────────────────────────

describe('CoachBriefScheduler.maybeDispatch', () => {
  it('skips coach when local time does not match notification_time', async () => {
    const prisma = makePrisma();
    const notifications = { pushToUser: jest.fn() };
    const briefService = {
      getOrGenerateTodaysBrief: jest.fn(),
    };
    const scheduler = new CoachBriefScheduler(
      prisma as any,
      briefService as any,
      notifications as any,
      makeConfig(),
    );

    // 12:00 UTC on May 25 == 05:00 PT — does not match 07:00 preference
    const now = new Date('2026-05-25T12:00:00Z');
    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'token' },
      },
      now,
    );
    expect(briefService.getOrGenerateTodaysBrief).not.toHaveBeenCalled();
    expect(notifications.pushToUser).not.toHaveBeenCalled();
  });

  it('skips coach with no expo_push_token even when time matches', async () => {
    const prisma = makePrisma();
    const notifications = { pushToUser: jest.fn() };
    const briefService = {
      getOrGenerateTodaysBrief: jest.fn(),
    };
    const scheduler = new CoachBriefScheduler(
      prisma as any,
      briefService as any,
      notifications as any,
      makeConfig(),
    );

    // 14:00 UTC == 07:00 PT
    const now = new Date('2026-05-25T14:00:00Z');
    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: null },
      },
      now,
    );
    expect(notifications.pushToUser).not.toHaveBeenCalled();
  });

  it('dispatches push when local time matches', async () => {
    const prisma = makePrisma();
    const notifications = { pushToUser: jest.fn().mockResolvedValue(undefined) };
    const briefService = {
      getOrGenerateTodaysBrief: jest.fn().mockResolvedValue({
        id: 'b1',
        coach_id: 'coach1',
        brief_date: '2026-05-25',
        status: 'generated',
        brief_mode: 'solo_coach',
        generated_at: new Date().toISOString(),
        summary: {
          date: '2026-05-25',
          brief_mode: 'solo_coach',
          narrative: 'Sarah, all clear today.',
          brief_context: makeContext(),
          action_items: [],
          generated_by: 'ai',
        },
        created_at: new Date().toISOString(),
      }),
    };
    const scheduler = new CoachBriefScheduler(
      prisma as any,
      briefService as any,
      notifications as any,
      makeConfig(),
    );

    const now = new Date('2026-05-25T14:00:00Z'); // 07:00 PT
    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      now,
    );
    expect(briefService.getOrGenerateTodaysBrief).toHaveBeenCalledWith('coach1');
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
    const [userId, title, body] = notifications.pushToUser.mock.calls[0];
    expect(userId).toBe('coach1');
    expect(title).toBe('Your daily brief is ready');
    expect(body).toMatch(/Sarah/);
  });

  it('respects COACH_BRIEF_NOTIFICATIONS_ENABLED=off (dispatchDailyBriefs no-op)', async () => {
    const prisma = makePrisma();
    prisma.coachBriefPreferences.findMany.mockResolvedValue([]);
    const scheduler = new CoachBriefScheduler(
      prisma as any,
      {} as any,
      {} as any,
      makeConfig({ COACH_BRIEF_NOTIFICATIONS_ENABLED: 'off' }),
    );
    await scheduler.dispatchDailyBriefs();
    expect(prisma.coachBriefPreferences.findMany).not.toHaveBeenCalled();
  });

  it('does not throw when one coach dispatch fails (Promise.allSettled isolation)', async () => {
    const prisma = makePrisma();
    prisma.coachBriefPreferences.findMany.mockResolvedValue([
      {
        coach_id: 'a',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'a', name: 'A', expo_push_token: null },
      },
      {
        coach_id: 'b',
        notification_time: 'bad',
        timezone: 'America/Los_Angeles',
        coach: { id: 'b', name: 'B', expo_push_token: null },
      },
    ]);
    const scheduler = new CoachBriefScheduler(
      prisma as any,
      { getOrGenerateTodaysBrief: jest.fn() } as any,
      { pushToUser: jest.fn() } as any,
      makeConfig(),
    );
    await expect(scheduler.dispatchDailyBriefs()).resolves.toBeUndefined();
  });
});

// ─── DailyLog + Preferences ─────────────────────────────────────────────

describe('CoachDailyLogService', () => {
  it('returns an empty stub when no log row exists', async () => {
    const prisma = makePrisma();
    prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);
    prisma.coachDailyLog.findUnique.mockResolvedValue(null);

    const svc = new CoachDailyLogService(prisma as any);
    const result = await svc.getTodaysLog('coach1');
    expect(result).toMatchObject({
      coach_id: 'coach1',
      content: '',
      exists: false,
    });
    expect(result.log_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('upserts and returns the persisted log row', async () => {
    const prisma = makePrisma();
    prisma.coachBriefPreferences.findUnique.mockResolvedValue({
      timezone: 'America/Los_Angeles',
    });
    const created = {
      id: 'l1',
      coach_id: 'coach1',
      log_date: '2026-05-25',
      content: 'good day',
      created_at: new Date(),
      updated_at: new Date(),
    };
    prisma.coachDailyLog.upsert.mockResolvedValue(created);

    const svc = new CoachDailyLogService(prisma as any);
    const result = await svc.upsertTodaysLog('coach1', 'good day');
    expect(result.content).toBe('good day');
    expect(prisma.coachDailyLog.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('CoachBriefPreferencesService', () => {
  it('returns defaults when no row exists, without writing', async () => {
    const prisma = makePrisma();
    prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);

    const svc = new CoachBriefPreferencesService(prisma as any);
    const result = await svc.getOrDefault('coach1');
    expect(result).toMatchObject({
      coach_id: 'coach1',
      notification_time: '07:00',
      timezone: 'America/Los_Angeles',
      enabled: true,
    });
    expect(prisma.coachBriefPreferences.upsert).not.toHaveBeenCalled();
  });

  it('upserts only the supplied fields', async () => {
    const prisma = makePrisma();
    prisma.coachBriefPreferences.upsert.mockResolvedValue({
      coach_id: 'coach1',
      notification_time: '09:30',
      timezone: 'America/Los_Angeles',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const svc = new CoachBriefPreferencesService(prisma as any);
    const result = await svc.upsert('coach1', { notification_time: '09:30' });
    expect(result.notification_time).toBe('09:30');
    expect(prisma.coachBriefPreferences.upsert).toHaveBeenCalledTimes(1);
  });
});
