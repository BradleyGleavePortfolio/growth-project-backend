// test/roman/roman-context-a2-fixes.spec.ts
//
// A2 (#665) FIX ROUND 1: B-665-1 one provider per wearable metric (the
// resolveBest policy), B-665-2 an incomplete sample read publishes no totals,
// B-665-3 assignment instants grouped by the client's local date,
// B-665-4 history caps never hide today's or the next session; Opus B-665-2
// the context route stays locked in a payment lockout; Opus B-665-3 rows from
// an open delegated sub-coach are the client's plan and thread.

import 'reflect-metadata';
import {
  RomanClientContextService,
  ROMAN_CONTEXT_MAX_QUERIES,
  ROMAN_CTX_LIMITS,
  localDayStart,
  summarizeWearables,
} from '../../src/roman/context/roman-client-context.service';
import {
  isAllowedWhileLocked,
  normalizePath,
} from '../../src/checkout/dunning-v2/dunning-lockout.guard';
import { makePersonaDb, FakeSafetyIntakeSource, NOW, P1 } from './fixtures/roman-personas';

type Row = Record<string, unknown>;
const caller = { id: P1, role: 'student' };
const TODAY = '2026-09-30'; // NOW is Wed 2026-09-30 17:30 in Los Angeles.

function setup() {
  const db = makePersonaDb();
  return { db, svc: new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource()) };
}

const night = (provider: string, value: number, recorded: string): Row => ({
  user_id: P1,
  provider,
  metric: 'SLEEP_TOTAL_MIN',
  value,
  start_at: new Date('2026-09-30T05:00:00Z'),
  end_at: new Date('2026-09-30T13:00:00Z'), // 06:00 PT 09-30: last night
  recorded_at: new Date(recorded),
  source_tz: 'America/Los_Angeles',
});
const steps = (provider: string, value: number, start: string, recorded = start): Row => ({
  user_id: P1,
  provider,
  metric: 'STEPS',
  value,
  start_at: new Date(start),
  end_at: new Date(Date.parse(start) + 3_600_000),
  recorded_at: new Date(recorded),
  source_tz: 'America/Los_Angeles',
});

describe('B-665-1 competing providers are never summed', () => {
  it('two providers reporting one night give one night (newest recorded provider wins)', async () => {
    const { db, svc } = setup();
    db.raw.wearableSamples.length = 0;
    db.raw.wearableSamples.push(
      night('OURA', 480, '2026-09-30T14:00:00Z'),
      night('APPLE_HEALTH', 468, '2026-09-30T13:30:00Z'),
      steps('OURA', 3000, '2026-09-30T16:00:00Z'),
      steps('APPLE_HEALTH', 3000, '2026-09-30T16:00:00Z'),
    );
    const { context } = await svc.build(caller, NOW);
    expect(context.wearables.last_night_sleep_hours).toBe(8);
    expect(context.wearables.avg_7d.sleep_hours).toBe(8);
    expect(context.wearables.days.find((d) => d.date === TODAY)?.steps).toBe(3000);
  });

  it("the client's preferred provider wins over the newest one, per metric", async () => {
    const { db, svc } = setup();
    db.raw.users = db.raw.users.map((u) =>
      u.id === P1
        ? {
            ...u,
            wearable_metric_preferences: [
              { metric: 'SLEEP_TOTAL_MIN', preferred_provider: 'APPLE_HEALTH' },
            ],
          }
        : u,
    );
    db.raw.wearableSamples.length = 0;
    db.raw.wearableSamples.push(
      night('OURA', 480, '2026-09-30T14:00:00Z'),
      night('APPLE_HEALTH', 468, '2026-09-30T13:30:00Z'),
    );
    const { context } = await svc.build(caller, NOW);
    expect(context.wearables.last_night_sleep_hours).toBe(7.8);
  });

  it('distinct sessions from the chosen provider still add up; a preference with no rows is unknown', () => {
    const conn = [{ provider: 'OURA', status: 'connected', last_synced_at: null }];
    const w = summarizeWearables(
      conn,
      [
        steps('OURA', 1000, '2026-09-30T15:00:00Z'),
        steps('OURA', 2500, '2026-09-30T18:00:00Z'),
        steps('APPLE_HEALTH', 9999, '2026-09-30T18:00:00Z', '2026-09-30T01:00:00Z'),
        night('OURA', 420, '2026-09-30T14:00:00Z'),
      ] as unknown as Parameters<typeof summarizeWearables>[1],
      TODAY,
      'America/Los_Angeles',
      { preferences: [{ metric: 'SLEEP_TOTAL_MIN', preferred_provider: 'WHOOP' }] },
    );
    expect(w.days.find((d) => d.date === TODAY)?.steps).toBe(3500);
    expect(w.last_night_sleep_hours).toBeNull();
  });
});

describe('B-665-2 an incomplete sample read is withheld, never published as a total', () => {
  it('1,000 one-step samples on one local day give exactly 1,000 steps', async () => {
    const { db, svc } = setup();
    db.raw.wearableSamples.length = 0;
    for (let i = 0; i < 1000; i++) {
      db.raw.wearableSamples.push(
        steps(
          'APPLE_HEALTH',
          1,
          new Date(Date.parse('2026-09-30T07:00:00Z') + i * 1000).toISOString(),
        ),
      );
    }
    const { context } = await svc.build(caller, NOW);
    expect(context.wearables.days.find((d) => d.date === TODAY)?.steps).toBe(1000);
    expect(context.data_quality.truncated).not.toContain('wearables.samples');
  });

  it('cap + 1 samples: no totals, no averages, no sleep, and truncated says why', async () => {
    const { db, svc } = setup();
    db.raw.wearableSamples.length = 0;
    db.raw.wearableSamples.push(night('OURA', 480, '2026-09-30T14:00:00Z'));
    for (let i = 0; i < ROMAN_CTX_LIMITS.wearable_samples; i++) {
      db.raw.wearableSamples.push(
        steps('OURA', 1, new Date(Date.parse('2026-09-30T15:00:00Z') + i * 1000).toISOString()),
      );
    }
    const { context } = await svc.build(caller, NOW);
    expect(context.data_quality.truncated).toContain('wearables.samples');
    expect(context.wearables.connected).toBe(true);
    expect(context.wearables.days).toEqual([]);
    expect(Object.values(context.wearables.avg_7d).every((v) => v === null)).toBe(true);
    expect(context.wearables.last_night_sleep_hours).toBeNull();
    expect(context.wearables.latest_sleep).toBeNull();
    const read = db.wheres.filter((w) => w.table === 'wearableSample');
    expect(read).toHaveLength(1);
    expect(db.prisma.wearableSample.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: ROMAN_CTX_LIMITS.wearable_samples + 1 }),
    );
  });
});

function p1Assignment(db: ReturnType<typeof makePersonaDb>, completed: boolean): Row {
  return db.raw.assignments.find(
    (a) =>
      a.client_id === P1 &&
      a.assigned_by_coach_id === 'coach-A' &&
      (a.completed_at !== null) === completed,
  )!;
}

describe('B-665-3 assignment instants use the client local date', () => {
  it('19:00 PT tonight (02:00Z tomorrow) is today; 00:00 PT tomorrow is next', async () => {
    const { db, svc } = setup();
    const open = p1Assignment(db, false);
    db.raw.assignments.length = 0;
    db.raw.assignments.push(
      { ...open, id: 'tonight', scheduled_for: new Date('2026-10-01T02:00:00Z') },
      { ...open, id: 'midnight', scheduled_for: new Date('2026-10-01T07:00:00Z') },
    );
    const { context } = await svc.build(caller, NOW);
    expect(context.plan?.today_session?.date).toBe(TODAY);
    expect(context.plan?.next_session?.date).toBe('2026-10-01');
  });

  it('a workout done 22:00 PT is dated that local day, and window bounds are local midnights', async () => {
    const { db, svc } = setup();
    const done = p1Assignment(db, true);
    db.raw.assignments.length = 0;
    db.raw.assignments.push({
      ...done,
      id: 'late',
      scheduled_for: new Date('2026-09-29T05:00:00Z'),
    });
    const { context } = await svc.build(caller, NOW);
    expect(context.plan?.recent_completions.map((c) => c.date)).toEqual(['2026-09-28']);
    const bounds = db.wheres
      .filter((w) => w.table === 'clientWorkoutAssignment')
      .map((w) => w.where?.scheduled_for);
    expect(bounds).toEqual([
      { gte: new Date('2026-09-16T07:00:00Z'), lt: new Date('2026-10-01T07:00:00Z') },
      { gte: new Date('2026-09-30T07:00:00Z'), lt: new Date('2026-10-15T07:00:00Z') },
    ]);
  });

  it('local midnight across DST and a half-hour zone', () => {
    expect(localDayStart('2026-11-01', 'America/Los_Angeles')).toEqual(
      new Date('2026-11-01T07:00:00Z'),
    );
    expect(localDayStart('2026-11-02', 'America/Los_Angeles')).toEqual(
      new Date('2026-11-02T08:00:00Z'),
    );
    expect(localDayStart('2026-03-08', 'America/New_York')).toEqual(
      new Date('2026-03-08T05:00:00Z'),
    );
    expect(localDayStart('2026-03-09', 'America/New_York')).toEqual(
      new Date('2026-03-09T04:00:00Z'),
    );
    expect(localDayStart('2026-10-01', 'Asia/Kolkata')).toEqual(new Date('2026-09-30T18:30:00Z'));
    expect(localDayStart('2026-10-01', 'UTC')).toEqual(new Date('2026-10-01T00:00:00Z'));
  });
});

describe('B-665-4 history caps never hide the next session', () => {
  it('forty past assignments plus one future one: the next session is found', async () => {
    const { db, svc } = setup();
    const open = p1Assignment(db, false);
    const done = p1Assignment(db, true);
    db.raw.assignments.length = 0;
    for (let i = 0; i < 40; i++) {
      db.raw.assignments.push({
        ...done,
        id: `d${i}`,
        scheduled_for: new Date(Date.parse('2026-09-25T14:00:00Z') + i * 60_000),
      });
    }
    db.raw.assignments.push({
      ...open,
      id: 'future',
      scheduled_for: new Date('2026-10-01T14:00:00Z'),
    });
    const { context } = await svc.build(caller, NOW);
    expect(context.plan?.next_session?.date).toBe('2026-10-01');
    expect(context.plan?.adherence_14d).toEqual({ completed: 40, scheduled: 40 });
    expect(context.data_quality.truncated).toEqual([]);
  });

  it('history cap + 1: adherence is unknown and disclosed; completions are the newest ten', async () => {
    const { db, svc } = setup();
    const open = p1Assignment(db, false);
    const done = p1Assignment(db, true);
    db.raw.assignments.length = 0;
    for (let i = 0; i <= ROMAN_CTX_LIMITS.plan_history; i++) {
      db.raw.assignments.push({
        ...done,
        id: `d${i}`,
        scheduled_for: new Date(Date.parse('2026-09-17T14:00:00Z') + i * 6 * 3_600_000),
      });
    }
    db.raw.assignments.push({
      ...open,
      id: 'future',
      scheduled_for: new Date('2026-10-02T14:00:00Z'),
    });
    const { context } = await svc.build(caller, NOW);
    expect(context.plan?.adherence_14d).toBeNull();
    expect(context.data_quality.truncated).toContain('plan.history');
    expect(context.plan?.next_session?.date).toBe('2026-10-02');
    expect(context.plan?.recent_completions).toHaveLength(10);
    expect(context.plan?.recent_completions[9].date).toBe('2026-09-27');
  });

  it('upcoming cap + 1 on one day: today is still exact, next and days/week unknown and disclosed', async () => {
    const { db, svc } = setup();
    const open = p1Assignment(db, false);
    db.raw.assignments.length = 0;
    for (let i = 0; i <= ROMAN_CTX_LIMITS.plan_upcoming; i++) {
      db.raw.assignments.push({
        ...open,
        id: `t${i}`,
        scheduled_for: new Date(Date.parse('2026-09-30T15:00:00Z') + i * 60_000),
      });
    }
    db.raw.assignments.push({
      ...open,
      id: 'future',
      scheduled_for: new Date('2026-10-02T14:00:00Z'),
    });
    const { context, query_count } = await svc.build(caller, NOW);
    expect(context.plan?.today_session?.date).toBe(TODAY);
    expect(context.plan?.next_session).toBeNull();
    expect(context.plan?.days_per_week).toBeNull();
    expect(context.data_quality.truncated).toContain('plan.upcoming');
    expect(query_count).toBeLessThanOrEqual(ROMAN_CONTEXT_MAX_QUERIES);
  });
});

describe('Opus B-665-2 the context route stays locked during a payment lockout', () => {
  it('GET /roman/context/me is locked; the Roman chat routes stay reachable', () => {
    expect(isAllowedWhileLocked(normalizePath('/api/roman/context/me'))).toBe(false);
    expect(isAllowedWhileLocked(normalizePath('/v1/roman/context'))).toBe(false);
    expect(isAllowedWhileLocked(normalizePath('/api/roman/sessions'))).toBe(true);
    expect(isAllowedWhileLocked(normalizePath('/api/roman/sessions/s1/messages'))).toBe(true);
  });
});

describe('Opus B-665-3 an open delegated sub-coach writes the plan and the thread', () => {
  const SUB = 'subcoach-S';
  function delegated(open: boolean, head = 'coach-A') {
    const db = makePersonaDb();
    db.raw.subCoachOverlays.push({
      client_id: P1,
      head_coach_id: head,
      sub_coach_id: SUB,
      assigned_at: new Date('2026-09-01T00:00:00Z'),
      unassigned_at: open ? null : new Date('2026-09-20T00:00:00Z'),
    });
    const open0 = p1Assignment(db, false);
    db.raw.assignments.length = 0;
    db.raw.assignments.push({
      ...open0,
      id: 'sub-today',
      assigned_by_coach_id: SUB,
      scheduled_for: new Date('2026-09-30T20:00:00Z'),
      snapshot: { plan_name: 'Sub plan', plan_type: 'strength', exercises_json: [] },
    });
    db.raw.mealAssignments = db.raw.mealAssignments.map((m) => ({
      ...m,
      assigned_by_coach_id: SUB,
    }));
    db.raw.coachMessages.push({
      coach_id: 'coach-A',
      client_id: P1,
      sender_id: SUB,
      body: 'Swap lunges for step-ups this week',
      created_at: new Date('2026-09-30T20:00:00Z'),
    });
    return { db, svc: new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource()) };
  }

  it("open delegation: the sub-coach plan, meal plan and message are the client's", async () => {
    const { svc } = delegated(true);
    const { context, query_count } = await svc.build(caller, NOW);
    expect(context.plan?.today_session?.name).toBe('Sub plan');
    expect(context.meal_plan).not.toBeNull();
    const msg = context.coach.recent_messages.find((m) => m.excerpt.includes('step-ups'));
    expect(msg?.from).toBe('coach');
    expect(context.data_quality.missing).not.toContain('plan');
    expect(query_count).toBeLessThanOrEqual(ROMAN_CONTEXT_MAX_QUERIES);
  });

  it('a closed delegation or one under another head coach adds nothing', async () => {
    for (const { svc } of [delegated(false), delegated(true, 'coach-B')]) {
      const { context } = await svc.build(caller, NOW);
      expect(context.plan).toBeNull();
      expect(context.meal_plan).toBeNull();
      expect(JSON.stringify(context.coach.recent_messages)).not.toContain('step-ups');
    }
  });
});
