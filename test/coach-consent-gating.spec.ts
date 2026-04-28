import { CoachService } from '../src/coach/coach.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';

// Pins the consent-layer-v1 gating contract on coach reads:
//   - When a client has not granted a fitness scope, the matching slice
//     of `getClientTimeline` / `getClientSummary` is empty.
//   - When the caller role is `owner`, the consent check is bypassed.
//   - The response now carries a `consent` block so the coach UI can
//     render a "client revoked access" affordance per scope.

function makePrisma(fixtures: {
  meals?: any[];
  workouts?: any[];
  weights?: any[];
  checkIns?: any[];
}) {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'client-1',
        coach_id: 'coach-A',
        name: 'Client One',
        profile: { id: 'p1' },
      }),
    },
    loggedFoodEntry: {
      findMany: jest.fn().mockResolvedValue(fixtures.meals ?? []),
    },
    workoutSession: {
      findMany: jest.fn().mockResolvedValue(fixtures.workouts ?? []),
    },
    weightLog: {
      findMany: jest.fn().mockResolvedValue(fixtures.weights ?? []),
    },
    checkIn: {
      findMany: jest.fn().mockResolvedValue(fixtures.checkIns ?? []),
    },
  } as any;
}

const audit = () =>
  ({ write: jest.fn(async () => {}), list: jest.fn(async () => []) }) as any;

// Tiny ConsentService stub that returns whatever boolean map the test
// passes in. Lets us test both "all granted" and "selectively granted"
// states without standing up a real Prisma.
function fakeConsent(grants: Partial<Record<string, boolean>>): ConsentService {
  return {
    coachCanAccess: jest.fn(
      async (_coachId: string, _clientId: string, scope: string) => !!grants[scope],
    ),
  } as any;
}

describe('CoachService consent gating', () => {
  it('omits per-scope data when consent is not granted; includes consent block', async () => {
    const prisma = makePrisma({
      meals: [{ id: 'm1', logged_at: new Date('2026-04-22T10:00:00Z') }],
      workouts: [{ id: 'w1', created_at: new Date('2026-04-23T10:00:00Z') }],
      weights: [{ id: 'wt1', date: new Date('2026-04-21T00:00:00Z') }],
      checkIns: [{ id: 'c1', date: new Date('2026-04-24T00:00:00Z') }],
    });
    // Grant only food + workouts; deny body metrics + habits/progress.
    const consent = fakeConsent({
      [ConsentScope.FITNESS_WORKOUTS]: true,
      [ConsentScope.FITNESS_FOOD_MACROS]: true,
      [ConsentScope.FITNESS_BODY_METRICS]: false,
      [ConsentScope.FITNESS_HABITS_PROGRESS]: false,
    });
    const svc = new CoachService(prisma, audit(), consent);
    const r = (await svc.getClientTimeline('coach-A', 'client-1', 90, 'coach')) as any;

    expect(r.workouts).toHaveLength(1);
    expect(r.meals).toHaveLength(1);
    expect(r.weights).toEqual([]);
    expect(r.checkIns).toEqual([]);
    // Workout & meal queries ran; body-metrics / check-in queries were skipped.
    expect(prisma.weightLog.findMany).not.toHaveBeenCalled();
    expect(prisma.checkIn.findMany).not.toHaveBeenCalled();
    // Response advertises which scopes are granted.
    expect(r.consent).toEqual({
      workouts: true,
      food_macros: true,
      body_metrics: false,
      habits_progress: false,
    });
    // Merged event stream only contains rows from granted scopes.
    expect(r.events.map((e: any) => e.type).sort()).toEqual(['meal', 'workout']);
  });

  it('owner bypasses consent and sees everything', async () => {
    const prisma = makePrisma({
      workouts: [{ id: 'w1', created_at: new Date('2026-04-23T10:00:00Z') }],
      weights: [{ id: 'wt1', date: new Date('2026-04-21T00:00:00Z') }],
    });
    // ConsentService.coachCanAccess should never be called for owners,
    // but if it were it would return false (we pass empty grants).
    const consent = fakeConsent({});
    const svc = new CoachService(prisma, audit(), consent);
    const r = (await svc.getClientTimeline('owner-1', 'client-1', 90, 'owner')) as any;
    expect(r.workouts).toHaveLength(1);
    expect(r.weights).toHaveLength(1);
    expect(consent.coachCanAccess).not.toHaveBeenCalled();
    expect(r.consent.workouts).toBe(true);
    expect(r.consent.body_metrics).toBe(true);
  });

  it('getClientSummary respects food + workouts consent', async () => {
    const prisma = makePrisma({
      meals: [{ id: 'm1', logged_at: new Date('2026-04-22T10:00:00Z'), quantity_multiplier: 1, food_item: { calories: 100 } }],
      workouts: [{ id: 'w1', created_at: new Date('2026-04-23T10:00:00Z') }],
      weights: [{ id: 'wt1', date: new Date('2026-04-21T00:00:00Z') }],
    });
    const consent = fakeConsent({
      [ConsentScope.FITNESS_WORKOUTS]: false,
      [ConsentScope.FITNESS_FOOD_MACROS]: true,
      [ConsentScope.FITNESS_BODY_METRICS]: true,
      [ConsentScope.FITNESS_HABITS_PROGRESS]: false,
    });
    const svc = new CoachService(prisma, audit(), consent);
    const r = (await svc.getClientSummary('coach-A', 'client-1', undefined, 'coach')) as any;
    expect(r.today.entries).toHaveLength(1);
    expect(r.recent_workouts).toEqual([]);
    expect(r.weight_logs).toHaveLength(1);
    expect(r.consent).toEqual({
      workouts: false,
      food_macros: true,
      body_metrics: true,
      habits_progress: false,
    });
    // Workout findMany is short-circuited; body-metrics + food queries ran.
    expect(prisma.workoutSession.findMany).not.toHaveBeenCalled();
    expect(prisma.loggedFoodEntry.findMany).toHaveBeenCalled();
  });
});
