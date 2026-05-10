import { CoachService } from '../src/coach/coach.service';

/**
 * Round-2 fix: getAlerts was 1 + 2N queries (per-client weightLog + workoutSession
 * checks). Round-2 collapsed this to 3 queries total — regardless of client count.
 * This spec pins that behavior.
 */
describe('CoachService.getAlerts (round-2 batched queries)', () => {
  let prismaMock: any;
  let service: CoachService;
  let queryCount: number;

  beforeEach(() => {
    queryCount = 0;
    const bump = () => {
      queryCount++;
    };
    prismaMock = {
      user: {
        findMany: jest.fn().mockImplementation(async () => {
          bump();
          return [
            { id: 'c1', name: 'Client One' },
            { id: 'c2', name: 'Client Two' },
            { id: 'c3', name: 'Client Three' },
          ];
        }),
      },
      weightLog: {
        findMany: jest.fn().mockImplementation(async () => {
          bump();
          return [];
        }),
      },
      workoutSession: {
        findFirst: jest.fn().mockImplementation(async () => {
          bump();
          return null;
        }),
        groupBy: jest.fn().mockImplementation(async () => {
          bump();
          return [];
        }),
      },
    };
    service = new CoachService(prismaMock as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any);
  });

  it('produces alerts with a bounded number of queries for 3 clients', async () => {
    const alerts = await service.getAlerts('coach-1');
    expect(Array.isArray(alerts)).toBe(true);
    // Post round-2: 1 user.findMany + 1 weightLog.findMany + 1 workoutSession.groupBy = 3.
    // Cap at 4 to leave a small headroom for future additions without hiding
    // regressions back to N+1.
    expect(queryCount).toBeGreaterThan(0);
    expect(queryCount).toBeLessThanOrEqual(4);
  });

  it('returns empty alerts when coach has no clients', async () => {
    prismaMock.user.findMany = jest.fn().mockResolvedValue([]);
    const alerts = await service.getAlerts('coach-solo');
    expect(alerts).toEqual([]);
  });
});

/**
 * Audit-1 Fix #6: getDashboard must use $queryRaw to aggregate food totals in
 * Postgres rather than fetching every LoggedFoodEntry row and summing in JS.
 * These tests verify:
 *   1. $queryRaw is called (not loggedFoodEntry.findMany)
 *   2. logs_today equals the number of distinct clients with rows returned
 *   3. total_kcal is the sum across all returned rows
 *   4. Clients with no entries (zero rows in $queryRaw result) default to zeros
 */
describe('CoachService.getDashboard (audit-1-fix-6: SQL aggregation)', () => {
  function makeService(queryRawResult: Array<{ user_id: string; total_kcal: number; total_protein_g: number; total_carbs_g: number; total_fat_g: number }>, clientRows: Array<{ id: string }>) {
    const prismaMock: any = {
      user: {
        findMany: jest.fn().mockResolvedValue(clientRows),
      },
      $queryRaw: jest.fn().mockResolvedValue(queryRawResult),
    };
    const svc = new CoachService(
      prismaMock as any,
      { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
    );
    return { svc, prismaMock };
  }

  it('returns zeros when there are no clients', async () => {
    const { svc } = makeService([], []);
    const result = await svc.getDashboard('coach-1');
    expect(result).toEqual({ logs_today: 0, total_kcal: 0, logging_rate: 0 });
  });

  it('calls $queryRaw (not loggedFoodEntry.findMany) for aggregation', async () => {
    const { svc, prismaMock } = makeService(
      [{ user_id: 'c1', total_kcal: 500, total_protein_g: 30, total_carbs_g: 50, total_fat_g: 10 }],
      [{ id: 'c1' }, { id: 'c2' }],
    );
    await svc.getDashboard('coach-1');
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    // loggedFoodEntry.findMany should NOT be called
    expect(prismaMock.loggedFoodEntry).toBeUndefined();
  });

  it('logs_today equals number of clients who have at least one entry', async () => {
    // 3 clients, 2 have entries today
    const { svc } = makeService(
      [
        { user_id: 'c1', total_kcal: 1200, total_protein_g: 80, total_carbs_g: 100, total_fat_g: 40 },
        { user_id: 'c2', total_kcal: 800,  total_protein_g: 60, total_carbs_g: 70,  total_fat_g: 20 },
      ],
      [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    );
    const result = await svc.getDashboard('coach-1');
    expect(result.logs_today).toBe(2);
  });

  it('total_kcal is the sum across all client rows', async () => {
    const { svc } = makeService(
      [
        { user_id: 'c1', total_kcal: 1200, total_protein_g: 80, total_carbs_g: 100, total_fat_g: 40 },
        { user_id: 'c2', total_kcal: 800,  total_protein_g: 60, total_carbs_g: 70,  total_fat_g: 20 },
      ],
      [{ id: 'c1' }, { id: 'c2' }],
    );
    const result = await svc.getDashboard('coach-1');
    expect(result.total_kcal).toBe(2000);
  });

  it('logging_rate is logs_today / total_clients, rounded to 2dp', async () => {
    // 2 out of 3 clients logged
    const { svc } = makeService(
      [
        { user_id: 'c1', total_kcal: 500, total_protein_g: 30, total_carbs_g: 50, total_fat_g: 10 },
        { user_id: 'c2', total_kcal: 700, total_protein_g: 40, total_carbs_g: 60, total_fat_g: 15 },
      ],
      [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    );
    const result = await svc.getDashboard('coach-1');
    expect(result.logging_rate).toBeCloseTo(0.67, 2);
  });

  it('returns zeros for kcal/logging when no clients logged today', async () => {
    // Clients exist but none have entries (empty $queryRaw result)
    const { svc } = makeService(
      [],
      [{ id: 'c1' }, { id: 'c2' }],
    );
    const result = await svc.getDashboard('coach-1');
    expect(result.logs_today).toBe(0);
    expect(result.total_kcal).toBe(0);
    expect(result.logging_rate).toBe(0);
  });
});
