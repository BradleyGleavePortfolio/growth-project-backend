/**
 * RegimeRevisionRetentionService unit tests (F2).
 *
 * Pins the rolling-history eviction contract with Prisma fully mocked (no DB):
 *  - a regime with 5 revisions and retention 3 keeps EXACTLY the latest 3;
 *  - a non-regime program is a no-op (raw programs keep their own retention);
 *  - eviction is idempotent: re-running on an already-pruned regime deletes 0;
 *  - retention is clamped to >= 1 so a misconfigured 0 never wipes history.
 *
 * Prisma is widened via the shared `asPrismaDouble` helper, which uses a
 * justified `@ts-expect-error` (the R0-sanctioned escape for partial
 * structural mocks) rather than the banned double-assertion the audit flagged.
 * The deleteMany double computes the real `revision_index < threshold`
 * predicate against an in-memory revision list so the assertions exercise the
 * actual arithmetic.
 */

import { RegimeRevisionRetentionService } from '../regime-revision-retention.service';
import type { PrismaService } from '../../prisma.service';
import { asPrismaDouble } from './prisma-test-double';

interface FakeProgram {
  id: string;
  is_regime: boolean;
  revision_retention_count: number;
}

function buildPrismaMock(args: {
  program: FakeProgram | null;
  revisionIndexes: number[];
}): { prisma: PrismaService; remaining: () => number[] } {
  let indexes = [...args.revisionIndexes].sort((a, b) => a - b);

  const prisma = asPrismaDouble({
    workoutProgram: {
      findUnique: jest.fn(async () => args.program),
    },
    workoutProgramRevision: {
      findFirst: jest.fn(async () => {
        if (indexes.length === 0) return null;
        return { revision_index: Math.max(...indexes) };
      }),
      deleteMany: jest.fn(
        async (q: { where: { revision_index: { lt: number } } }) => {
          const threshold = q.where.revision_index.lt;
          const before = indexes.length;
          indexes = indexes.filter((i) => i >= threshold);
          return { count: before - indexes.length };
        },
      ),
    },
  });

  return { prisma, remaining: () => indexes };
}

describe('RegimeRevisionRetentionService', () => {
  it('keeps exactly the latest 3 revisions when 5 exist (retention=3)', async () => {
    const { prisma, remaining } = buildPrismaMock({
      program: { id: 'reg-1', is_regime: true, revision_retention_count: 3 },
      revisionIndexes: [0, 1, 2, 3, 4],
    });
    const service = new RegimeRevisionRetentionService(prisma);

    const deleted = await service.evictForRegime('reg-1');

    expect(deleted).toBe(2);
    expect(remaining()).toEqual([2, 3, 4]);
  });

  it('is a no-op for a non-regime program', async () => {
    const { prisma, remaining } = buildPrismaMock({
      program: { id: 'prog-1', is_regime: false, revision_retention_count: 3 },
      revisionIndexes: [0, 1, 2, 3, 4],
    });
    const service = new RegimeRevisionRetentionService(prisma);

    const deleted = await service.evictForRegime('prog-1');

    expect(deleted).toBe(0);
    expect(remaining()).toEqual([0, 1, 2, 3, 4]);
  });

  it('is idempotent: re-running on an already-pruned regime deletes 0', async () => {
    const { prisma, remaining } = buildPrismaMock({
      program: { id: 'reg-1', is_regime: true, revision_retention_count: 3 },
      revisionIndexes: [2, 3, 4],
    });
    const service = new RegimeRevisionRetentionService(prisma);

    const deleted = await service.evictForRegime('reg-1');

    expect(deleted).toBe(0);
    expect(remaining()).toEqual([2, 3, 4]);
  });

  it('clamps retention < 1 to keep at least the newest revision', async () => {
    const { prisma, remaining } = buildPrismaMock({
      program: { id: 'reg-1', is_regime: true, revision_retention_count: 0 },
      revisionIndexes: [0, 1, 2],
    });
    const service = new RegimeRevisionRetentionService(prisma);

    const deleted = await service.evictForRegime('reg-1');

    expect(deleted).toBe(2);
    expect(remaining()).toEqual([2]);
  });
});
