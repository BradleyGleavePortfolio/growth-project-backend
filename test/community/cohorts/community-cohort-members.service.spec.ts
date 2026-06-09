/**
 * Unit tests for CommunityCohortMembersService (v1-6 coach cohort admin).
 *
 * Mocks CommunityAccessService + CommunityCohortMembersRepository (no DB).
 * Covers: coach-vs-member roster views (sanitization), idempotent assign,
 * email/user_id XOR, OWNER-coach removal protection, cross-cohort 403, and the
 * non-member 404 (non-leak) on read.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { CommunityCohortMembersService } from '../../../src/community/cohorts/community-cohort-members.service';
import type { MembershipWithUser } from '../../../src/community/cohorts/community-cohort-members.repository';

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const COHORT_A = '33333333-3333-3333-3333-333333333333';

const coachA = { id: 'cccccccc-0000-0000-0000-00000000000a', role: 'coach' } as unknown as User;
const coachB = { id: 'cccccccc-0000-0000-0000-00000000000b', role: 'coach' } as unknown as User;
const student = { id: 'aaaaaaaa-0000-0000-0000-000000000001', role: 'student' } as unknown as User;

function membership(over: Partial<MembershipWithUser> = {}): MembershipWithUser {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'dddddddd-0000-0000-0000-000000000001',
    workspace_id: WS_A,
    cohort_id: COHORT_A,
    user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    role: 'student',
    status: 'active',
    dm_enabled: null,
    notify_level: 'digest',
    joined_at: now,
    last_read_message_at: null,
    created_at: now,
    updated_at: now,
    removed_at: null,
    user: { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Jane Client', email: 'jane@example.com' },
    ...over,
  } as MembershipWithUser;
}

describe('CommunityCohortMembersService', () => {
  let access: {
    findCohort: jest.Mock;
    isWorkspaceCoach: jest.Mock;
    membershipInCohort: jest.Mock;
  };
  let repo: {
    listMembers: jest.Mock;
    findMembership: jest.Mock;
    findUserByEmail: jest.Mock;
    findUserById: jest.Mock;
    upsertMembership: jest.Mock;
    removeMembership: jest.Mock;
  };
  let service: CommunityCohortMembersService;

  beforeEach(() => {
    access = {
      findCohort: jest.fn(),
      isWorkspaceCoach: jest.fn(),
      membershipInCohort: jest.fn(),
    };
    repo = {
      listMembers: jest.fn(),
      findMembership: jest.fn(),
      findUserByEmail: jest.fn(),
      findUserById: jest.fn(),
      upsertMembership: jest.fn(),
      removeMembership: jest.fn(),
    };
    service = new CommunityCohortMembersService(access as never, repo as never);
  });

  describe('list (roster)', () => {
    it('gives a coach the full member rows including status + email', async () => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.listMembers.mockResolvedValue([membership()]);

      const res = await service.list(coachA, COHORT_A, {} as never);
      expect(res.members).toHaveLength(1);
      expect(res.members[0].status).toBe('active');
      expect(res.members[0].email).toBe('jane@example.com');
      expect(res.members[0].role).toBe('student');
    });

    it('sanitizes the roster for a non-coach active member (no PII/status)', async () => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(false);
      access.membershipInCohort.mockResolvedValue({ status: 'active' });
      repo.listMembers.mockResolvedValue([membership()]);

      const res = await service.list(student, COHORT_A, {} as never);
      expect(res.members[0].display_name).toBe('Jane Client');
      expect(res.members[0].status).toBeNull();
      expect(res.members[0].email).toBeNull();
      expect(res.members[0].joined_at).toBeNull();
    });

    it('404s a non-member reader (non-leak)', async () => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(false);
      access.membershipInCohort.mockResolvedValue(null);
      await expect(
        service.list(student, COHORT_A, {} as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s an unknown cohort', async () => {
      access.findCohort.mockResolvedValue(null);
      await expect(
        service.list(coachA, COHORT_A, {} as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('emits a next_cursor when a full page is returned', async () => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
      const page = Array.from({ length: 2 }, (_, i) =>
        membership({
          id: `dddddddd-0000-0000-0000-00000000000${i}`,
          user_id: `eeeeeeee-0000-0000-0000-00000000000${i}`,
        }),
      );
      repo.listMembers.mockResolvedValue(page);
      const res = await service.list(coachA, COHORT_A, {
        limit: '2',
      } as never);
      expect(res.next_cursor).not.toBeNull();
    });
  });

  describe('assign', () => {
    beforeEach(() => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
    });

    it('assigns a known user_id as an active student (idempotent upsert)', async () => {
      repo.findUserById.mockResolvedValue({
        id: 'aaaaaaaa-0000-0000-0000-000000000001',
        name: 'Jane Client',
        email: 'jane@example.com',
      });
      repo.upsertMembership.mockResolvedValue(membership());
      const res = await service.assign(coachA, COHORT_A, {
        user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
        role: 'student',
      } as never);
      expect(res.member.user_id).toBe('aaaaaaaa-0000-0000-0000-000000000001');
      expect(repo.upsertMembership).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active', role: 'student' }),
      );
    });

    it('maps co_coach to the assistant Prisma role', async () => {
      repo.findUserById.mockResolvedValue({
        id: 'eeeeeeee-0000-0000-0000-0000000000f2',
        name: 'Asst',
        email: 'a@x.com',
      });
      repo.upsertMembership.mockResolvedValue(
        membership({ role: 'assistant', user_id: 'eeeeeeee-0000-0000-0000-0000000000f2' }),
      );
      const res = await service.assign(coachA, COHORT_A, {
        user_id: 'eeeeeeee-0000-0000-0000-0000000000f2',
        role: 'co_coach',
      } as never);
      expect(repo.upsertMembership).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'assistant' }),
      );
      expect(res.member.role).toBe('co_coach');
    });

    it('creates a pending invite (status=invited) for an existing user by email', async () => {
      repo.findUserByEmail.mockResolvedValue({
        id: 'aaaaaaaa-0000-0000-0000-000000000001',
        name: 'Jane Client',
        email: 'jane@example.com',
      });
      repo.upsertMembership.mockResolvedValue(
        membership({ status: 'invited', joined_at: null }),
      );
      await service.assign(coachA, COHORT_A, {
        email: 'jane@example.com',
        role: 'student',
      } as never);
      expect(repo.upsertMembership).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'invited', joinedAt: null }),
      );
    });

    it('400s when neither user_id nor email is supplied', async () => {
      await expect(
        service.assign(coachA, COHORT_A, { role: 'student' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400s when BOTH user_id and email are supplied (XOR)', async () => {
      await expect(
        service.assign(coachA, COHORT_A, {
          user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
          email: 'jane@example.com',
          role: 'student',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s when the email maps to no platform user', async () => {
      repo.findUserByEmail.mockResolvedValue(null);
      await expect(
        service.assign(coachA, COHORT_A, {
          email: 'ghost@example.com',
          role: 'student',
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s a coach assigning into a cohort they do not own (cross-cohort)', async () => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_B });
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.assign(coachB, COHORT_A, {
          user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
          role: 'student',
        } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_A });
      access.isWorkspaceCoach.mockResolvedValue(true);
    });

    it('soft-removes a student member', async () => {
      repo.findMembership.mockResolvedValue(membership());
      repo.removeMembership.mockResolvedValue(
        membership({ status: 'removed', removed_at: new Date() }),
      );
      const res = await service.remove(coachA, COHORT_A, 'aaaaaaaa-0000-0000-0000-000000000001');
      expect(res.member.status).toBe('removed');
    });

    it('403s removing the owning coach role (protect owner)', async () => {
      repo.findMembership.mockResolvedValue(
        membership({ role: 'coach', user_id: 'cccccccc-0000-0000-0000-00000000000a' }),
      );
      await expect(
        service.remove(coachA, COHORT_A, 'cccccccc-0000-0000-0000-00000000000a'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.removeMembership).not.toHaveBeenCalled();
    });

    it('is idempotent when the member is already removed', async () => {
      repo.findMembership.mockResolvedValue(membership({ status: 'removed' }));
      const res = await service.remove(coachA, COHORT_A, 'aaaaaaaa-0000-0000-0000-000000000001');
      expect(res.member.status).toBe('removed');
      expect(repo.removeMembership).not.toHaveBeenCalled();
    });

    it('404s an unknown membership', async () => {
      repo.findMembership.mockResolvedValue(null);
      await expect(
        service.remove(coachA, COHORT_A, 'nobody'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s a coach removing from a cohort they do not own (cross-cohort)', async () => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_B });
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.remove(coachB, COHORT_A, 'aaaaaaaa-0000-0000-0000-000000000001'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
