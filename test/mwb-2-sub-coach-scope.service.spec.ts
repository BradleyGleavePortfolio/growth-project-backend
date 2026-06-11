/**
 * MWB-2 (§7.2) — SubCoachScopeService.canAccessClient authorization matrix.
 *
 * cloneProgramToClient (and every template / clone access) calls
 * canAccessClient(coachId, clientId) as its authorization gate. The brief
 * pins the exact 4-way matrix:
 *
 *   - head coach who owns the client            -> true
 *   - sub-coach with an OPEN assignment          -> true
 *   - sub-coach with NO / a different assignment -> false (out of scope)
 *   - a coach from another business (foreign)    -> false
 *
 * PrismaService is mocked; the test exercises the real detection rule
 * (sub-coach iff role='coach' AND coach_id is non-null) and the real overlay
 * resolution (open SubCoachAssignment rows joined to live student rows).
 */

import { PrismaService } from '../src/prisma.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

const HEAD_COACH = 'head-coach-1';
const SUB_COACH = 'sub-coach-1';
const FOREIGN_COACH = 'foreign-coach-1';
const CLIENT_IN_SCOPE = 'client-in-scope';
const CLIENT_OUT_OF_SCOPE = 'client-out-of-scope';

interface PrismaMock {
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  subCoachAssignment: { findMany: jest.Mock };
}

describe('SubCoachScopeService.canAccessClient (MWB-2 §7.2 matrix)', () => {
  let prisma: PrismaMock;
  let svc: SubCoachScopeService;

  // User-row directory the mock resolves findUnique against.
  const users: Record<string, { role: string; coach_id: string | null }> = {
    [HEAD_COACH]: { role: 'coach', coach_id: null },
    [SUB_COACH]: { role: 'coach', coach_id: HEAD_COACH },
    [FOREIGN_COACH]: { role: 'coach', coach_id: null },
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(users[where.id] ?? null),
        ),
        // Head-coach roster + sub-coach live-student filter both go through
        // findMany; default returns the in-scope client as a live student.
        findMany: jest.fn(),
      },
      subCoachAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new SubCoachScopeService(prisma as unknown as PrismaService);
  });

  it('head coach who owns the client -> true', async () => {
    // Head-coach path: roster query returns the client.
    prisma.user.findMany.mockResolvedValue([{ id: CLIENT_IN_SCOPE }]);

    expect(await svc.canAccessClient(HEAD_COACH, CLIENT_IN_SCOPE)).toBe(true);
    // Resolved via the direct roster (no assignment overlay for a head coach).
    expect(prisma.subCoachAssignment.findMany).not.toHaveBeenCalled();
  });

  it('head coach -> false for a client not on their roster', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: CLIENT_IN_SCOPE }]);
    expect(await svc.canAccessClient(HEAD_COACH, CLIENT_OUT_OF_SCOPE)).toBe(
      false,
    );
  });

  it('sub-coach with an OPEN assignment to the client -> true', async () => {
    prisma.subCoachAssignment.findMany.mockResolvedValue([
      { client_id: CLIENT_IN_SCOPE },
    ]);
    // Live-student filter keeps the assigned client.
    prisma.user.findMany.mockResolvedValue([{ id: CLIENT_IN_SCOPE }]);

    expect(await svc.canAccessClient(SUB_COACH, CLIENT_IN_SCOPE)).toBe(true);
    expect(prisma.subCoachAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sub_coach_id: SUB_COACH, unassigned_at: null },
      }),
    );
  });

  it('sub-coach with no / a different assignment -> false (out of scope)', async () => {
    // Sub-coach is only assigned the in-scope client, not the out-of-scope one.
    prisma.subCoachAssignment.findMany.mockResolvedValue([
      { client_id: CLIENT_IN_SCOPE },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: CLIENT_IN_SCOPE }]);

    expect(await svc.canAccessClient(SUB_COACH, CLIENT_OUT_OF_SCOPE)).toBe(
      false,
    );
  });

  it('sub-coach with zero open assignments -> false', async () => {
    prisma.subCoachAssignment.findMany.mockResolvedValue([]);
    expect(await svc.canAccessClient(SUB_COACH, CLIENT_IN_SCOPE)).toBe(false);
  });

  it('foreign coach (different business) -> false', async () => {
    // The foreign coach is a head coach in their OWN business; the client is
    // not on their roster, so the roster query returns empty for them.
    prisma.user.findMany.mockResolvedValue([]);
    expect(await svc.canAccessClient(FOREIGN_COACH, CLIENT_IN_SCOPE)).toBe(
      false,
    );
  });

  it('a non-coach user -> false (never authorized as a coach)', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'student',
      coach_id: HEAD_COACH,
    });
    expect(await svc.canAccessClient('some-student', CLIENT_IN_SCOPE)).toBe(
      false,
    );
  });
});
