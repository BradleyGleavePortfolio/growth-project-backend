import { CoachService } from '../src/coach/coach.service';

/**
 * N+1 characterization for round-2 fix. On `main`, getAlerts loops over
 * clients and issues per-client weightLog + workoutSession queries. The
 * round-2 fix should batch these into O(1) queries (or use SQL aggregation).
 *
 * The spy test records the current query count; once round-2 merges and
 * reduces to <=3 queries regardless of client count, flip the expectation.
 */
describe('CoachService.getAlerts (N+1 characterization)', () => {
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
      },
    };
    service = new CoachService(prismaMock as any);
  });

  it('produces alerts and records query count for 3 clients', async () => {
    const alerts = await service.getAlerts('coach-1');
    expect(Array.isArray(alerts)).toBe(true);
    // With round-2 N+1 fix merged, this should collapse to <= 3 total queries
    // regardless of client count. Today on `main` it scales linearly:
    //   1 (users.findMany) + N (weightLog per client) + N (workoutSession per client)
    // For N=3 → 7. We pin the current value so the number moves only intentionally.
    expect(queryCount).toBeLessThanOrEqual(7);
    expect(queryCount).toBeGreaterThan(0);
  });
});
