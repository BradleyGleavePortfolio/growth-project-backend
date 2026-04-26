import { CommunityService } from '../src/community/community.service';

/**
 * N+1 characterization for round-2 fix. getLeaderboard currently fires
 * one workoutSession.count per student. Round-2 fix should batch via
 * groupBy or a single aggregation query.
 */
describe('CommunityService.getLeaderboard (N+1 characterization)', () => {
  let prismaMock: any;
  let service: CommunityService;
  let queryCount: number;

  beforeEach(() => {
    queryCount = 0;
    const bump = () => {
      queryCount++;
    };
    prismaMock = {
      user: {
        findUnique: jest.fn().mockImplementation(async () => {
          bump();
          return { id: 'coach-1', role: 'coach', coach_id: null };
        }),
        findMany: jest.fn().mockImplementation(async () => {
          bump();
          return [
            { id: 's1', name: 'Student One' },
            { id: 's2', name: 'Student Two' },
            { id: 's3', name: 'Student Three' },
          ];
        }),
      },
      workoutSession: {
        count: jest.fn().mockImplementation(async () => {
          bump();
          return 2;
        }),
        groupBy: jest.fn().mockImplementation(async () => {
          bump();
          return [];
        }),
      },
    };
    // BadgesService dependency — stub out all methods used by CommunityService
    const badgesMock: any = {
      checkAndAwardFirstWin: jest.fn().mockResolvedValue(undefined),
      checkAndAwardEncourager: jest.fn().mockResolvedValue(undefined),
      checkAndAwardInnerCircleBuilder: jest.fn().mockResolvedValue(undefined),
    };
    service = new CommunityService(prismaMock as any, badgesMock);
  });

  it('returns a leaderboard and records query count for 3 students', async () => {
    const lb = await service.getLeaderboard('coach-1', 'week');
    expect(Array.isArray(lb)).toBe(true);
    // Round-2 target: collapse to <=3 queries (findUnique + findMany + groupBy).
    // On `main`: findUnique + findMany + N counts → for N=3, totals 5.
    expect(queryCount).toBeLessThanOrEqual(5);
    expect(queryCount).toBeGreaterThanOrEqual(2);
  });
});
