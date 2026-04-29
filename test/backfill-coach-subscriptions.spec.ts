import {
  backfillCoachSubscriptions,
  BackfillResult,
} from '../scripts/backfill-coach-subscriptions';

interface FakeCoach {
  id: string;
  email: string;
  coach_subscription: { id: string } | null;
}

interface CreatedRow {
  coach_id: string;
  status: string;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  billing_email: string;
}

function makePrisma(coaches: FakeCoach[]) {
  const created: CreatedRow[] = [];
  return {
    prisma: {
      user: {
        findMany: jest.fn(async () => coaches),
      },
      coachSubscription: {
        create: jest.fn(async ({ data }: { data: CreatedRow }) => {
          created.push(data);
          return { id: `cs-${created.length}`, ...data };
        }),
      },
    },
    created,
  };
}

describe('backfillCoachSubscriptions', () => {
  it('creates one grandfathered row per coach without a subscription and skips coaches that already have one', async () => {
    const { prisma, created } = makePrisma([
      { id: 'coach-1', email: 'c1@example.com', coach_subscription: null },
      { id: 'coach-2', email: 'c2@example.com', coach_subscription: null },
      { id: 'coach-3', email: 'c3@example.com', coach_subscription: null },
      { id: 'coach-4', email: 'c4@example.com', coach_subscription: { id: 'cs-existing' } },
    ]);

    const result: BackfillResult = await backfillCoachSubscriptions(
      // The backfill only touches the two narrowly-typed Prisma surfaces above,
      // so the wider PrismaClient type is unnecessary in the test harness.
      prisma as unknown as Parameters<typeof backfillCoachSubscriptions>[0],
    );

    expect(result.scanned).toBe(4);
    expect(result.backfilled).toBe(3);
    expect(result.alreadyHadSubscription).toBe(1);
    expect(prisma.coachSubscription.create).toHaveBeenCalledTimes(3);

    const coachIds = created.map((row) => row.coach_id).sort();
    expect(coachIds).toEqual(['coach-1', 'coach-2', 'coach-3']);

    for (const row of created) {
      expect(row.status).toBe('grandfathered');
      expect(row.cancel_at_period_end).toBe(false);
      expect(row.current_period_end.getUTCFullYear()).toBe(2099);
    }
  });

  it('treats a P2002 unique-constraint race as already-had rather than failing', async () => {
    const { prisma } = makePrisma([
      { id: 'coach-1', email: 'c1@example.com', coach_subscription: null },
      { id: 'coach-2', email: 'c2@example.com', coach_subscription: null },
    ]);
    let callCount = 0;
    prisma.coachSubscription.create = jest.fn(async ({ data }: { data: CreatedRow }) => {
      callCount++;
      if (callCount === 2) {
        const err = new Error('Unique constraint failed') as Error & { code?: string };
        err.code = 'P2002';
        throw err;
      }
      return { id: `cs-${callCount}`, ...data };
    });

    const result = await backfillCoachSubscriptions(
      prisma as unknown as Parameters<typeof backfillCoachSubscriptions>[0],
    );

    expect(result.scanned).toBe(2);
    expect(result.backfilled).toBe(1);
    expect(result.alreadyHadSubscription).toBe(1);
  });

  it('rethrows non-P2002 prisma errors so the runbook step fails loud', async () => {
    const { prisma } = makePrisma([
      { id: 'coach-1', email: 'c1@example.com', coach_subscription: null },
    ]);
    prisma.coachSubscription.create = jest.fn(async (_args: { data: CreatedRow }) => {
      throw new Error('database is on fire');
    });

    await expect(
      backfillCoachSubscriptions(
        prisma as unknown as Parameters<typeof backfillCoachSubscriptions>[0],
      ),
    ).rejects.toThrow('database is on fire');
  });
});
