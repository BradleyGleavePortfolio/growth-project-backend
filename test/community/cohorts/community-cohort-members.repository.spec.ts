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
});
