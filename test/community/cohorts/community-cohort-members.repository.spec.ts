/**
 * Unit tests for CommunityCohortMembersRepository.findUserByEmail (R1-P2-002).
 *
 * Assign-by-email lowercases the lookup, but User.email is stored case-as-typed
 * (not normalized at write). A mixed-case stored email must still resolve from a
 * lowercase lookup. Prisma is mocked: we assert the query is issued with
 * `mode: 'insensitive'` (Postgres case-folding) and that a row stored mixed-case
 * is returned for a lowercase lookup.
 */
import { CommunityCohortMembersRepository } from '../../../src/community/cohorts/community-cohort-members.repository';
import type { PrismaService } from '../../../src/prisma.service';
import { stub } from '../../utils/trial-fakes';

describe('CommunityCohortMembersRepository.findUserByEmail', () => {
  let prisma: { user: { findFirst: jest.Mock } };
  let repo: CommunityCohortMembersRepository;

  beforeEach(() => {
    prisma = { user: { findFirst: jest.fn() } };
    repo = new CommunityCohortMembersRepository(prisma as never);
  });

  it('issues a case-insensitive equals predicate on email', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await repo.findUserByEmail('john.doe@example.com');
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'john.doe@example.com', mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
  });

  it('finds a user whose email was stored mixed-case via a lowercase lookup', async () => {
    // Simulate Postgres case-folding: the insensitive predicate matches the
    // mixed-case stored row for the lowercase lookup.
    prisma.user.findFirst.mockImplementation(async ({ where }) => {
      const wanted = where.email.equals.toLowerCase();
      const stored = 'John.Doe@example.com';
      return where.email.mode === 'insensitive' &&
        stored.toLowerCase() === wanted
        ? { id: 'user-1', name: 'John Doe', email: stored }
        : null;
    });

    const found = await repo.findUserByEmail('john.doe@example.com');
    expect(found).toEqual({
      id: 'user-1',
      name: 'John Doe',
      email: 'John.Doe@example.com',
    });
  });

  // B-AUTHZ-1: a scoped lookup only resolves the workspace coach's live
  // clients or the workspace's team (C6-BVIS: not an active client row).
  const SCOPE = { workspaceId: 'ws-1', coachId: 'coach-1' };
  const SCOPED_FILTER = {
    deleted_at: null,
    OR: [
      { coach_id: 'coach-1' },
      { community_memberships: { some: { workspace_id: 'ws-1', status: 'active', role: { not: 'student' } } } },
    ],
  };

  it('scopes an email lookup to the coach roster or the workspace team', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await repo.findUserByEmail('jane@example.com', SCOPE);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'jane@example.com', mode: 'insensitive' }, ...SCOPED_FILTER },
      select: { id: true, name: true, email: true },
    });
  });

  it('scopes a user_id lookup the same way', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await repo.findUserById('user-9', SCOPE);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user-9', ...SCOPED_FILTER },
      select: { id: true, name: true, email: true },
    });
  });
});

// FR-1168R2 B1 (LO-1168 B1, LS-1168R1, LO-1168R1): the member list (GET /community/cohorts/:cohortId/members)
// is the people of the space now. A person who left it (left_at on their row for that space) is not listed,
// for the coach or for members; once they join again (left_at cleared) they are listed again. The listed
// rule (a pending invitation counts, C6-BVIS) stays.
describe('CommunityCohortMembersRepository.people (FR-1168R2 B1: a person who left the space is not listed)', () => {
  const space = { id: 'space-1', workspace_id: 'ws-1' };
  const world = (leftIds: string[]) => {
    const prisma = {
      $queryRaw: jest.fn(async (..._args: unknown[]) => ['coach-1', 'stays-1', 'left-1'].map((id) => ({ id }))),
      communitySpaceRead: {
        findMany: jest.fn(async (args: { where: { cohort_id: string; user_id: { in: string[] } } }) =>
          leftIds
            .filter((id) => args.where.cohort_id === space.id && args.where.user_id.in.includes(id))
            .map((user_id) => ({ user_id }))),
      },
      user: {
        findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.map((id) => ({ id, name: `Person ${id}`, community_memberships: [] }))),
      },
    };
    return { prisma, repo: new CommunityCohortMembersRepository(stub<PrismaService>(prisma)) };
  };

  it('leaves out a person whose row for that space has left_at set', async () => {
    const { prisma, repo } = world(['left-1']);
    expect((await repo.people(space)).map((p) => p.id)).toEqual(['coach-1', 'stays-1']);
    expect(prisma.communitySpaceRead.findMany).toHaveBeenCalledWith({
      where: { cohort_id: 'space-1', user_id: { in: ['coach-1', 'stays-1', 'left-1'] }, left_at: { not: null } },
      select: { user_id: true },
    });
    expect(prisma.user.findMany.mock.calls[0][0].where.id.in).toEqual(['coach-1', 'stays-1']);
  });

  it('lists them again once they join again, and keeps the listed rule (a pending invitation counts)', async () => {
    const { prisma, repo } = world([]);
    expect((await repo.people(space)).map((p) => p.id)).toEqual(['coach-1', 'left-1', 'stays-1']);
    const values = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(values[values.length - 1]).toBe(true); // readersNow(..., listed = true), as before
  });
});
