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
    service = new CoachService(prismaMock as any);
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
