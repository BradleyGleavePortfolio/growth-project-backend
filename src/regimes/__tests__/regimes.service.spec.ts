/**
 * RegimesService unit tests (F2).
 *
 * Pins the named-regime orchestration contract with Prisma + retention mocked:
 *  - listRegimes returns coach-scoped active regimes WITH package_attachments_count
 *    derived from grouped CoachPackageContent counts;
 *  - promoteFromProgram flips is_regime=true and is idempotent on retry;
 *  - archiveRegime sets archived_at and is idempotent (WHERE-guarded);
 *  - a foreign/missing regime 404s (no 403 existence oracle).
 */

import { NotFoundException } from '@nestjs/common';
import { RegimesService, REGIME_REVISIONS_HARD_CAP } from '../regimes.service';
import type { PrismaService } from '../../prisma.service';
import type { RegimeRevisionRetentionService } from '../regime-revision-retention.service';
import { asPrismaDouble } from './prisma-test-double';

function retentionDouble(): RegimeRevisionRetentionService {
  const stub: Pick<RegimeRevisionRetentionService, 'evictForRegime'> = {
    evictForRegime: jest.fn(async () => 0),
  };
  return stub as RegimeRevisionRetentionService;
}

const COACH = { role: 'coach' as const };

describe('RegimesService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('listRegimes', () => {
    it('returns active regimes annotated with package_attachments_count', async () => {
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        workoutProgram: {
          findMany: jest.fn(async () => [
            {
              id: 'reg-1',
              name: 'Base',
              regime_display_name: '12-week hypertrophy',
              weeks: 12,
              days_per_week: 4,
              head_revision_id: 'rev-9',
              archived_at: null,
            },
            {
              id: 'reg-2',
              name: 'Cut',
              regime_display_name: null,
              weeks: 8,
              days_per_week: 5,
              head_revision_id: null,
              archived_at: null,
            },
          ]),
        },
        coachPackageContent: {
          groupBy: jest.fn(async () => [
            { asset_id: 'reg-1', _count: { _all: 3 } },
          ]),
        },
      });
      const service = new RegimesService(prisma, retentionDouble());

      const list = await service.listRegimes('coach-1');

      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        id: 'reg-1',
        regime_display_name: '12-week hypertrophy',
        package_attachments_count: 3,
      });
      // reg-2 has no grouped row → count falls back to 0.
      expect(list[1].package_attachments_count).toBe(0);
    });

    it('short-circuits to [] when the coach owns no regimes', async () => {
      const groupBy = jest.fn();
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        workoutProgram: { findMany: jest.fn(async () => []) },
        coachPackageContent: { groupBy },
      });
      const service = new RegimesService(prisma, retentionDouble());

      const list = await service.listRegimes('coach-1');

      expect(list).toEqual([]);
      expect(groupBy).not.toHaveBeenCalled();
    });
  });

  describe('promoteFromProgram', () => {
    it('flips is_regime=true and is idempotent on retry', async () => {
      const updateMany = jest.fn(async () => ({ count: 1 }));
      const ownedRegimeRow = {
        id: 'prog-1',
        name: 'Base',
        regime_display_name: 'Named',
        weeks: 10,
        days_per_week: 3,
        head_revision_id: null,
        archived_at: null,
        owner_user_id: 'coach-1',
      };
      // findFirst is called twice: once to confirm ownership (program), once
      // inside requireOwnedRegime to read back the now-regime row.
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce({ id: 'prog-1' })
        .mockResolvedValueOnce(ownedRegimeRow);
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        workoutProgram: { findFirst, updateMany },
        coachPackageContent: { count: jest.fn(async () => 0) },
      });
      const service = new RegimesService(prisma, retentionDouble());

      const result = await service.promoteFromProgram(
        'coach-1',
        'prog-1',
        'Named',
      );

      expect(result.id).toBe('prog-1');
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_regime: true,
            regime_display_name: 'Named',
          }),
        }),
      );
    });

    it('404s when the program is not owned by the coach', async () => {
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        workoutProgram: { findFirst: jest.fn(async () => null) },
      });
      const service = new RegimesService(prisma, retentionDouble());

      await expect(
        service.promoteFromProgram('coach-1', 'prog-x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('archiveRegime', () => {
    it('sets archived_at and returns it', async () => {
      const updateMany = jest.fn(async () => ({ count: 1 }));
      const archivedAt = new Date('2026-01-01T00:00:00Z');
      const findFirst = jest
        .fn()
        // requireOwnedRegime lookup
        .mockResolvedValueOnce({
          id: 'reg-1',
          name: 'Base',
          regime_display_name: null,
          weeks: 12,
          days_per_week: 4,
          head_revision_id: null,
          archived_at: null,
          owner_user_id: 'coach-1',
        })
        // read-back of archived_at
        .mockResolvedValueOnce({ archived_at: archivedAt });
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        workoutProgram: { findFirst, updateMany },
      });
      const service = new RegimesService(prisma, retentionDouble());

      const result = await service.archiveRegime('coach-1', 'reg-1');

      expect(result.archived_at).toEqual(archivedAt);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'reg-1',
            is_regime: true,
            archived_at: null,
          }),
        }),
      );
    });
  });

  describe('updateRegime', () => {
    const ownedRegimeRow = {
      id: 'reg-1',
      name: 'Base',
      regime_display_name: 'Old',
      weeks: 12,
      days_per_week: 4,
      head_revision_id: null,
      archived_at: null,
      owner_user_id: 'coach-1',
    };

    function updateHarness(opts: {
      lockedRows?: Array<{ id: string }>;
      headRevisionIndex: number | null;
    }) {
      const queryRaw = jest.fn(
        async (
          _strings: TemplateStringsArray,
          ..._values: unknown[]
        ): Promise<Array<{ id: string }>> => opts.lockedRows ?? [{ id: 'reg-1' }],
      );
      const updateMany = jest.fn(async () => ({ count: 1 }));
      const revisionCreate = jest.fn(async () => ({ id: 'rev-new' }));
      const revisionFindFirst = jest.fn(async () =>
        opts.headRevisionIndex === null
          ? null
          : { revision_index: opts.headRevisionIndex },
      );
      const evictForRegime = jest.fn(async () => 0);
      const retention: Pick<
        RegimeRevisionRetentionService,
        'evictForRegime'
      > = { evictForRegime };

      const txClient = {
        $queryRaw: queryRaw,
        workoutProgram: { updateMany },
        workoutProgramRevision: {
          findFirst: revisionFindFirst,
          create: revisionCreate,
        },
      };
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        workoutProgram: { findFirst: jest.fn(async () => ownedRegimeRow) },
        coachPackageContent: { count: jest.fn(async () => 0) },
        $transaction: jest.fn(async (cb: (tx: typeof txClient) => unknown) =>
          cb(txClient),
        ),
      });
      const service = new RegimesService(
        prisma,
        retention as RegimeRevisionRetentionService,
      );
      return {
        service,
        queryRaw,
        updateMany,
        revisionCreate,
        revisionFindFirst,
        evictForRegime,
      };
    }

    it('locks the program row FOR UPDATE before allocating the next revision_index', async () => {
      const { service, queryRaw, revisionCreate } = updateHarness({
        headRevisionIndex: 4,
      });

      const result = await service.updateRegime('coach-1', 'reg-1', 'New name');

      expect(result.regime_display_name).toBe('New name');
      // The row lock is taken (the sanctioned SELECT … FOR UPDATE pattern) so
      // concurrent edits serialise instead of racing the unique
      // (program_id, revision_index) allocation into a 500.
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const rawArg = queryRaw.mock.calls[0][0];
      expect(rawArg.join('')).toMatch(/FOR UPDATE/);
      // Next index = current head (4) + 1.
      expect(revisionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revision_index: 5 }),
        }),
      );
    });

    it('allocates revision_index 0 for the first revision', async () => {
      const { service, revisionCreate } = updateHarness({
        headRevisionIndex: null,
      });

      await service.updateRegime('coach-1', 'reg-1', 'New name');

      expect(revisionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revision_index: 0 }),
        }),
      );
    });

    it('404s inside the tx when the locked program row has vanished', async () => {
      const { service, updateMany, revisionCreate } = updateHarness({
        lockedRows: [],
        headRevisionIndex: 4,
      });

      await expect(
        service.updateRegime('coach-1', 'reg-1', 'New name'),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The row never existed under the lock → no write, no revision append.
      expect(updateMany).not.toHaveBeenCalled();
      expect(revisionCreate).not.toHaveBeenCalled();
    });
  });

  describe('getRegimeRevisions', () => {
    const ownedRegimeRow = {
      id: 'reg-1',
      name: 'Base',
      regime_display_name: null,
      weeks: 12,
      days_per_week: 4,
      head_revision_id: null,
      archived_at: null,
      owner_user_id: 'coach-1',
    };

    it('caps the findMany at the hard cap, newest first (R81 F5)', async () => {
      const findMany = jest.fn(async () => [
        { revision_index: 9, created_at: new Date('2026-03-01'), cause: 'edit' },
        { revision_index: 8, created_at: new Date('2026-02-01'), cause: 'edit' },
      ]);
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        // requireOwnedRegime lookup
        workoutProgram: { findFirst: jest.fn(async () => ownedRegimeRow) },
        workoutProgramRevision: { findMany },
      });
      const service = new RegimesService(prisma, retentionDouble());

      const revisions = await service.getRegimeRevisions('coach-1', 'reg-1');

      expect(revisions).toHaveLength(2);
      // Query-level take cap is present and equal to the exported constant so an
      // operator-configured high-retention regime can never return an unbounded
      // result set.
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { program_id: 'reg-1' },
          orderBy: { revision_index: 'desc' },
          take: REGIME_REVISIONS_HARD_CAP,
        }),
      );
    });

    it('404s when the regime is not owned by the coach', async () => {
      const findMany = jest.fn();
      const prisma = asPrismaDouble({
        user: { findUnique: jest.fn(async () => COACH) },
        workoutProgram: { findFirst: jest.fn(async () => null) },
        workoutProgramRevision: { findMany },
      });
      const service = new RegimesService(prisma, retentionDouble());

      await expect(
        service.getRegimeRevisions('coach-1', 'reg-x'),
      ).rejects.toBeInstanceOf(NotFoundException);
      // No row read attempted once ownership fails.
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
