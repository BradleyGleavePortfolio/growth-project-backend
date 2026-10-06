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
  // clients or people already active in the workspace.
  const SCOPE = { workspaceId: 'ws-1', coachId: 'coach-1' };
  const SCOPED_FILTER = {
    deleted_at: null,
    OR: [
      { coach_id: 'coach-1' },
      { community_memberships: { some: { workspace_id: 'ws-1', status: 'active' } } },
    ],
  };

  it('scopes an email lookup to the coach roster or active workspace members', async () => {
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
