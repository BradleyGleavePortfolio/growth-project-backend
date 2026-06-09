/**
 * Unit tests for CommunityCohortWriteService (v1-6 coach cohort admin).
 *
 * Mocks CommunityAccessService + CommunityCohortWriteRepository so these run
 * with no DB. Covers the auth doctrine (owner bypass, workspace-coach gate,
 * cross-workspace/cross-cohort 403), name-conflict 409, date-range 400, and
 * archive idempotency.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityCohort, User } from '@prisma/client';
import { CommunityCohortWriteService } from '../../../src/community/cohorts/community-cohort-write.service';

type AccessMock = {
  findWorkspace: jest.Mock;
  findCohort: jest.Mock;
  isWorkspaceCoach: jest.Mock;
};
type RepoMock = {
  create: jest.Mock;
  findById: jest.Mock;
  nameTakenInWorkspace: jest.Mock;
  update: jest.Mock;
  archive: jest.Mock;
};

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const COHORT_A = '33333333-3333-3333-3333-333333333333';

const coachA = { id: 'coach-a', role: 'coach' } as unknown as User;
const coachB = { id: 'coach-b', role: 'coach' } as unknown as User;
const owner = { id: 'platform-owner', role: 'owner' } as unknown as User;

function cohort(over: Partial<CommunityCohort> = {}): CommunityCohort {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: COHORT_A,
    workspace_id: WS_A,
    name: 'Spring Cohort',
    description: null,
    status: 'active',
    starts_at: null,
    ends_at: null,
    capacity: null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
    archived_at: null,
    ...over,
  } as CommunityCohort;
}

describe('CommunityCohortWriteService', () => {
  let access: AccessMock;
  let repo: RepoMock;
  let service: CommunityCohortWriteService;

  beforeEach(() => {
    access = {
      findWorkspace: jest.fn(),
      findCohort: jest.fn(),
      isWorkspaceCoach: jest.fn(),
    };
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      nameTakenInWorkspace: jest.fn(),
      update: jest.fn(),
      archive: jest.fn(),
    };
    service = new CommunityCohortWriteService(
      access as never,
      repo as never,
    );
  });

  describe('create', () => {
    it('creates a cohort for the owning coach', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.nameTakenInWorkspace.mockResolvedValue(false);
      repo.create.mockResolvedValue(cohort());

      const res = await service.create(coachA, WS_A, {
        name: 'Spring Cohort',
      } as never);
      expect(res.cohort.id).toBe(COHORT_A);
      expect(res.cohort.workspace_id).toBe(WS_A);
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('lets the platform owner create without workspace ownership', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      repo.nameTakenInWorkspace.mockResolvedValue(false);
      repo.create.mockResolvedValue(cohort());

      await service.create(owner, WS_A, { name: 'Spring Cohort' } as never);
      // Owner bypass: workspace-coach check is never consulted.
      expect(access.isWorkspaceCoach).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalled();
    });

    it('404s a non-existent workspace before any write', async () => {
      access.findWorkspace.mockResolvedValue(null);
      await expect(
        service.create(coachA, WS_A, { name: 'X1' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('403s a coach who does not own the target workspace (cross-workspace)', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_B });
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.create(coachB, WS_B, { name: 'Intruder' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('409s a duplicate cohort name in the workspace', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.nameTakenInWorkspace.mockResolvedValue(true);
      await expect(
        service.create(coachA, WS_A, { name: 'Dup' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('400s when ends_at precedes starts_at', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
      await expect(
        service.create(coachA, WS_A, {
          name: 'Range',
          starts_at: '2026-06-01T00:00:00.000Z',
          ends_at: '2026-05-01T00:00:00.000Z',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('updates a cohort for its owning coach', async () => {
      repo.findById.mockResolvedValue(cohort());
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.nameTakenInWorkspace.mockResolvedValue(false);
      repo.update.mockResolvedValue(cohort({ name: 'Renamed' }));

      const res = await service.update(coachA, COHORT_A, {
        name: 'Renamed',
      } as never);
      expect(res.cohort.name).toBe('Renamed');
    });

    it('404s an unknown cohort', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.update(coachA, COHORT_A, { name: 'X' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s a coach updating a cohort in a workspace they do not own (cross-cohort)', async () => {
      repo.findById.mockResolvedValue(cohort({ workspace_id: WS_B }));
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.update(coachB, COHORT_A, { name: 'Hijack' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('409s a rename onto an existing cohort name', async () => {
      repo.findById.mockResolvedValue(cohort({ name: 'Old' }));
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.nameTakenInWorkspace.mockResolvedValue(true);
      await expect(
        service.update(coachA, COHORT_A, { name: 'Taken' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows a no-op rename to the same name (no conflict check trip)', async () => {
      repo.findById.mockResolvedValue(cohort({ name: 'Same' }));
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.update.mockResolvedValue(cohort({ name: 'Same' }));
      await service.update(coachA, COHORT_A, { name: 'Same' } as never);
      expect(repo.nameTakenInWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    it('archives an active cohort for its owning coach', async () => {
      repo.findById.mockResolvedValue(cohort({ status: 'active' }));
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.archive.mockResolvedValue(
        cohort({ status: 'archived', archived_at: new Date() }),
      );
      const res = await service.archive(coachA, COHORT_A);
      expect(res.cohort.status).toBe('archived');
      expect(repo.archive).toHaveBeenCalledWith(COHORT_A);
    });

    it('is idempotent for an already-archived cohort (no second write)', async () => {
      repo.findById.mockResolvedValue(
        cohort({ status: 'archived', archived_at: new Date() }),
      );
      access.isWorkspaceCoach.mockResolvedValue(true);
      const res = await service.archive(coachA, COHORT_A);
      expect(res.cohort.status).toBe('archived');
      expect(repo.archive).not.toHaveBeenCalled();
    });

    it('403s a non-owning coach (cross-workspace archive attempt)', async () => {
      repo.findById.mockResolvedValue(cohort({ workspace_id: WS_B }));
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.archive(coachB, COHORT_A),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.archive).not.toHaveBeenCalled();
    });
  });
});
