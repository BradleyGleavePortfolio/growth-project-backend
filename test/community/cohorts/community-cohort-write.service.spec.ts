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
import type { User } from '@prisma/client';
import type { CohortWithPackages, SpaceAccessInput } from '../../../src/community/cohorts/community-cohort-write.repository';
import { CommunityCohortWriteService } from '../../../src/community/cohorts/community-cohort-write.service';
import type { CreateCohortDto, SpaceVisibility, UpdateCohortDto } from '../../../src/community/cohorts/community-cohort.dto';

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
  coachPackageCount: jest.Mock;
};

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const COHORT_A = '33333333-3333-3333-3333-333333333333';

const coachA = { id: 'coach-a', role: 'coach' } as unknown as User;
const coachB = { id: 'coach-b', role: 'coach' } as unknown as User;
const owner = { id: 'platform-owner', role: 'owner' } as unknown as User;

function cohort(over: Partial<CohortWithPackages> = {}): CohortWithPackages {
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
    kind: 'chat',
    posting_policy: 'all',
    visibility: 'members',
    packages: [],
    created_at: now,
    updated_at: now,
    archived_at: null,
    ...over,
  };
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
      coachPackageCount: jest.fn(async (_coach: string, ids: string[]) => ids.filter((i) => i.startsWith('own')).length),
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

    it.each([
      [undefined, 'chat', 'all'],
      ['chat', 'chat', 'all'],
      ['announcement', 'announcement', 'coach'],
      ['section', 'section', 'all'],
    ] as const)('C6-B1: kind %s makes a %s space that %s may post in', async (kind, made, policy) => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.nameTakenInWorkspace.mockResolvedValue(false);
      repo.create.mockResolvedValue(cohort({ kind: made, posting_policy: policy }));

      const res = await service.create(coachA, WS_A, { name: 'News', kind });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: made, postingPolicy: policy }),
      );
      expect(res.cohort).toMatchObject({ kind: made, posting_policy: policy });
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

  // C6-BVIS (#COMMUNITY-ACCESS): the coach picks who a space opens to. A package space takes one or
  // more of the coach's own packages ('own-*' here); any other takes none. Every miss is one 400.
  describe('who a space opens to', () => {
    const OK = (visibility: SpaceVisibility, packageIds: string[]): SpaceAccessInput => ({ visibility, packageIds });
    const links = (ids: string[]) => ids.map((package_id) => ({ package_id }));
    beforeEach(() => {
      access.findWorkspace.mockResolvedValue({ id: WS_A, coach_id: coachA.id });
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.nameTakenInWorkspace.mockResolvedValue(false);
      repo.create.mockImplementation(async (i) => cohort({ visibility: i.access.visibility, packages: links(i.access.packageIds) }));
      repo.update.mockImplementation(async (_id, i) => cohort(i.access ? { visibility: i.access.visibility } : {}));
    });

    const CREATE: Array<[Partial<CreateCohortDto>, SpaceAccessInput | null]> = [
      [{}, OK('members', [])],
      [{ visibility: 'public' }, OK('public', [])],
      [{ visibility: 'clients' }, OK('clients', [])],
      [{ visibility: 'package', package_ids: ['own-1', 'own-2', 'own-1'] }, OK('package', ['own-1', 'own-2'])],
      [{ visibility: 'package' }, null],
      [{ visibility: 'package', package_ids: ['own-1', 'other-coach'] }, null],
      [{ visibility: 'clients', package_ids: ['own-1'] }, null],
    ];
    it.each(CREATE)('create %j -> %j', async (body, want) => {
      const made = service.create(coachA, WS_A, { name: 'Space', ...body });
      if (!want) {
        await expect(made).rejects.toMatchObject({ response: { code: 'community.cohort.invalid_packages' } });
        expect(repo.create).not.toHaveBeenCalled();
        return;
      }
      expect((await made).cohort).toMatchObject({ visibility: want.visibility, package_ids: want.packageIds });
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ access: want }));
    });

    const UPDATE: Array<[UpdateCohortDto, SpaceAccessInput | null | undefined]> = [
      [{ name: 'Renamed' }, undefined],
      [{ visibility: 'clients' }, OK('clients', [])],
      [{ package_ids: ['own-2'] }, OK('package', ['own-2'])],
      [{ visibility: 'package' }, OK('package', ['own-1'])],
      [{ package_ids: [] }, null],
      [{ visibility: 'members', package_ids: ['own-1'] }, null],
    ];
    it.each(UPDATE)('update a package space %j -> %j', async (body, want) => {
      repo.findById.mockResolvedValue(cohort({ visibility: 'package', packages: links(['own-1']) }));
      const done = service.update(coachA, COHORT_A, body);
      if (want === null) {
        await expect(done).rejects.toMatchObject({ response: { code: 'community.cohort.invalid_packages' } });
        expect(repo.update).not.toHaveBeenCalled();
        return;
      }
      await done;
      expect(repo.update).toHaveBeenCalledWith(COHORT_A, expect.objectContaining({ access: want }));
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

    it('C6-B1: the coach sets who may post in a space', async () => {
      repo.findById.mockResolvedValue(cohort());
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.update.mockResolvedValue(cohort({ posting_policy: 'coach' }));

      const res = await service.update(coachA, COHORT_A, { posting_policy: 'coach' });
      expect(repo.update).toHaveBeenCalledWith(
        COHORT_A,
        expect.objectContaining({ postingPolicy: 'coach' }),
      );
      expect(res.cohort.posting_policy).toBe('coach');
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
