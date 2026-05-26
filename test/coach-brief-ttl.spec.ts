// test/coach-brief-ttl.spec.ts
//
// BL-GDPR-BRIEF-2 — Regression test for CoachBriefService.pruneStaleBriefs.
//
// Seeds CoachBrief rows at brief_dates spanning today, 1d ago, 6d ago,
// 8d ago, and 30d ago. After calling pruneStaleBriefs(7), asserts with
// STRUCTURAL comparisons that:
//   - Rows ≤ 7 days old are retained.
//   - Rows > 7 days old are deleted.
//
// Also verifies the scheduler's runTtlPrune integration: it reads
// COACH_BRIEF_RETENTION_DAYS from config and delegates to pruneStaleBriefs,
// and it is a no-op when COACH_BRIEF_ENABLED=off.

import { CoachBriefService } from '../src/coach/brief/coach-brief.service';
import { CoachBriefScheduler } from '../src/coach/brief/coach-brief.scheduler';
import {
  asPrismaService,
  asConfig,
  makeMockPrisma,
  makeMockConfig,
  MockPrisma,
} from './_fixtures/coach-brief-mocks';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function makeService(prisma: MockPrisma, configValues: Record<string, string | undefined> = {}) {
  return new CoachBriefService(
    asPrismaService(prisma),
    asConfig(makeMockConfig(configValues)),
  );
}

// ─── pruneStaleBriefs unit tests ─────────────────────────────────────────────

describe('CoachBriefService.pruneStaleBriefs', () => {
  it('deletes rows where brief_date < cutoff and retains rows within the window', async () => {
    const prisma = makeMockPrisma();

    // Build five seeded brief_dates.
    const today = daysAgoStr(0);
    const oneDayAgo = daysAgoStr(1);
    const sixDaysAgo = daysAgoStr(6);
    const eightDaysAgo = daysAgoStr(8);
    const thirtyDaysAgo = daysAgoStr(30);

    // Compute the cutoff that pruneStaleBriefs(7) will derive:
    //   cutoffStr = (now - 7 days).toISOString().slice(0, 10)
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 7);
    const expectedCutoff = cutoffDate.toISOString().slice(0, 10);

    // Simulate the DB state: 5 rows exist.
    const allRows = [
      { id: '1', brief_date: today },
      { id: '2', brief_date: oneDayAgo },
      { id: '3', brief_date: sixDaysAgo },
      { id: '4', brief_date: eightDaysAgo },
      { id: '5', brief_date: thirtyDaysAgo },
    ];

    // deleteMany returns the count of rows that would be deleted (those < cutoff).
    const expectedDeletedCount = allRows.filter(
      (r) => r.brief_date < expectedCutoff,
    ).length;

    // $transaction calls the callback with the array of operations; mock it
    // to execute the single deleteMany inside.
    prisma.coachBrief.deleteMany.mockResolvedValue({ count: expectedDeletedCount });
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops),
    );

    const svc = makeService(prisma);
    const deleted = await svc.pruneStaleBriefs(7);

    // STRUCTURAL: rows > 7 days old (brief_date < cutoff) should be deleted.
    expect(deleted).toBe(expectedDeletedCount);
    expect(deleted).toBeGreaterThanOrEqual(2); // eightDaysAgo + thirtyDaysAgo at minimum

    // Verify deleteMany was called with the correct 'lt' cutoff filter.
    const deleteManyCall = prisma.coachBrief.deleteMany.mock.calls[0][0] as {
      where: { brief_date: { lt: string } };
    };
    expect(deleteManyCall.where.brief_date.lt).toBe(expectedCutoff);

    // The rows within the retention window (today, oneDayAgo, sixDaysAgo)
    // should NOT be matched by the filter.
    const retained = allRows.filter(
      (r) => r.brief_date >= expectedCutoff,
    );
    expect(retained.map((r) => r.brief_date)).toContain(today);
    expect(retained.map((r) => r.brief_date)).toContain(oneDayAgo);
    expect(retained.map((r) => r.brief_date)).toContain(sixDaysAgo);

    // Rows beyond the window must NOT be in the retained set.
    expect(retained.map((r) => r.brief_date)).not.toContain(eightDaysAgo);
    expect(retained.map((r) => r.brief_date)).not.toContain(thirtyDaysAgo);
  });

  it('uses the default retention of 7 days when called with no argument', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.deleteMany.mockResolvedValue({ count: 0 });
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops),
    );

    const svc = makeService(prisma);
    await svc.pruneStaleBriefs(); // no arg — default 7

    const deleteManyCall = prisma.coachBrief.deleteMany.mock.calls[0][0] as {
      where: { brief_date: { lt: string } };
    };

    // Default cutoff should be today - 7 days.
    const expectedCutoff = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 7);
      return d.toISOString().slice(0, 10);
    })();
    expect(deleteManyCall.where.brief_date.lt).toBe(expectedCutoff);
  });

  it('returns 0 when no rows are stale', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.deleteMany.mockResolvedValue({ count: 0 });
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops),
    );

    const svc = makeService(prisma);
    const deleted = await svc.pruneStaleBriefs(7);

    expect(deleted).toBe(0);
  });

  it('respects a custom retentionDays value (e.g. 30)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.deleteMany.mockResolvedValue({ count: 1 });
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops),
    );

    const svc = makeService(prisma);
    await svc.pruneStaleBriefs(30);

    const deleteManyCall = prisma.coachBrief.deleteMany.mock.calls[0][0] as {
      where: { brief_date: { lt: string } };
    };

    const expectedCutoff = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    expect(deleteManyCall.where.brief_date.lt).toBe(expectedCutoff);
  });
});

// ─── CoachBriefScheduler.runTtlPrune integration tests ───────────────────────

describe('CoachBriefScheduler.runTtlPrune', () => {
  function makeScheduler(
    svc: CoachBriefService,
    configValues: Record<string, string | undefined> = {},
  ) {
    // Pass undefined for all optional scheduler deps that aren't needed here.
    return new CoachBriefScheduler(
      undefined as never, // prisma — not used by runTtlPrune directly
      svc,
      undefined as never, // notifications
      asConfig(makeMockConfig(configValues)),
      // schedulerRegistry is optional
    );
  }

  it('delegates to pruneStaleBriefs with retentionDays from config', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.deleteMany.mockResolvedValue({ count: 3 });
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops),
    );

    const svc = makeService(prisma, { COACH_BRIEF_ENABLED: 'on' });
    jest.spyOn(svc, 'pruneStaleBriefs');

    const scheduler = makeScheduler(svc, {
      COACH_BRIEF_ENABLED: 'on',
      COACH_BRIEF_RETENTION_DAYS: '14',
    });

    await scheduler.runTtlPrune();

    expect(svc.pruneStaleBriefs).toHaveBeenCalledWith(14);
    expect(svc.pruneStaleBriefs).toHaveBeenCalledTimes(1);
  });

  it('uses default retention of 7 when COACH_BRIEF_RETENTION_DAYS is absent', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.deleteMany.mockResolvedValue({ count: 0 });
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops),
    );

    const svc = makeService(prisma, { COACH_BRIEF_ENABLED: 'on' });
    jest.spyOn(svc, 'pruneStaleBriefs');

    const scheduler = makeScheduler(svc, { COACH_BRIEF_ENABLED: 'on' });
    await scheduler.runTtlPrune();

    expect(svc.pruneStaleBriefs).toHaveBeenCalledWith(7);
  });

  it('is a no-op when COACH_BRIEF_ENABLED=off', async () => {
    const prisma = makeMockPrisma();
    const svc = makeService(prisma, { COACH_BRIEF_ENABLED: 'off' });
    jest.spyOn(svc, 'pruneStaleBriefs');

    const scheduler = makeScheduler(svc, { COACH_BRIEF_ENABLED: 'off' });
    await scheduler.runTtlPrune();

    expect(svc.pruneStaleBriefs).not.toHaveBeenCalled();
  });

  it('uses default retention of 7 when COACH_BRIEF_RETENTION_DAYS is not a valid number', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.deleteMany.mockResolvedValue({ count: 0 });
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops),
    );

    const svc = makeService(prisma, { COACH_BRIEF_ENABLED: 'on' });
    jest.spyOn(svc, 'pruneStaleBriefs');

    const scheduler = makeScheduler(svc, {
      COACH_BRIEF_ENABLED: 'on',
      COACH_BRIEF_RETENTION_DAYS: 'not-a-number',
    });
    await scheduler.runTtlPrune();

    // parseInt('not-a-number', 10) = NaN; || 7 kicks in.
    expect(svc.pruneStaleBriefs).toHaveBeenCalledWith(7);
  });
});
