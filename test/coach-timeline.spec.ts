import { CoachService } from '../src/coach/coach.service';

// Pins Tier-2 timeline integration: check-ins appear in the merged `events`
// stream as `type: 'check_in'`, sorted with the other event types by date
// descending. Also pins the backwards-compat contract — the per-type arrays
// (meals/workouts/weights/checkIns) remain on the response shape so existing
// consumers aren't broken.
function makePrisma(fixtures: {
  meals?: Array<{ id: string; logged_at: Date }>;
  workouts?: Array<{ id: string; created_at: Date }>;
  weights?: Array<{ id: string; date: Date }>;
  checkIns?: Array<{ id: string; date: Date }>;
}) {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'client-1',
        coach_id: 'coach-A',
        name: 'Client One',
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

describe('CoachService.getClientTimeline (Tier-2 check-in integration)', () => {
  it('returns per-type arrays AND a merged `events` stream', async () => {
    const svc = new CoachService(
      makePrisma({
        meals: [{ id: 'm1', logged_at: new Date('2026-04-22T10:00:00Z') }],
        workouts: [{ id: 'w1', created_at: new Date('2026-04-23T10:00:00Z') }],
        weights: [{ id: 'wt1', date: new Date('2026-04-21T00:00:00Z') }],
        checkIns: [{ id: 'c1', date: new Date('2026-04-24T00:00:00Z') }],
      }),
    );
    const r = (await svc.getClientTimeline('coach-A', 'client-1')) as any;
    // Backwards-compat: per-type arrays still present
    expect(r.meals).toHaveLength(1);
    expect(r.workouts).toHaveLength(1);
    expect(r.weights).toHaveLength(1);
    expect(r.checkIns).toHaveLength(1);
    // New merged events stream
    expect(r.events).toHaveLength(4);
    expect(r.events.map((e: any) => e.type)).toEqual([
      'check_in', // 2026-04-24 (newest)
      'workout',  // 2026-04-23
      'meal',     // 2026-04-22
      'weight',   // 2026-04-21 (oldest)
    ]);
  });

  it('each event carries a type, date, and ref back to the row', async () => {
    const svc = new CoachService(
      makePrisma({
        checkIns: [
          {
            id: 'c1',
            date: new Date('2026-04-24T00:00:00Z'),
            // extra fields should round-trip through `ref`
            mood: 4,
            energy: 3,
          } as any,
        ],
      }),
    );
    const r = (await svc.getClientTimeline('coach-A', 'client-1')) as any;
    expect(r.events).toHaveLength(1);
    expect(r.events[0].type).toBe('check_in');
    expect((r.events[0].ref as any).id).toBe('c1');
    expect((r.events[0].ref as any).mood).toBe(4);
  });

  it('returns empty events when client has no activity', async () => {
    const svc = new CoachService(makePrisma({}));
    const r = (await svc.getClientTimeline('coach-A', 'client-1')) as any;
    expect(r.events).toEqual([]);
    expect(r.meals).toEqual([]);
    expect(r.checkIns).toEqual([]);
  });
});
