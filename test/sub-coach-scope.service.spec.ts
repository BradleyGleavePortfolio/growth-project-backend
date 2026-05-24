import { Test, TestingModule } from '@nestjs/testing';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { PrismaService } from '../src/prisma.service';

const HEAD_COACH = 'head-1';
const SUB_COACH = 'sub-1';
const OTHER_SUB = 'sub-2';
const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';
const CLIENT_C = 'client-c';

/**
 * Builds a Prisma mock that simulates two clients on the head coach's
 * roster, of which one (CLIENT_A) is delegated to SUB_COACH. CLIENT_B
 * is on the head coach's roster but unassigned. CLIENT_C belongs to a
 * different team entirely.
 */
function buildPrismaMock(opts: {
  callerRole: 'coach' | 'student';
  callerCoachId: string | null;
  assignedToSub: string[];
}) {
  const userFindUnique = jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
    if (where.id === SUB_COACH) {
      return Promise.resolve({ role: opts.callerRole, coach_id: opts.callerCoachId });
    }
    if (where.id === HEAD_COACH) {
      return Promise.resolve({ role: 'coach', coach_id: null });
    }
    return Promise.resolve(null);
  });

  const userFindMany = jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    // Sub-coach branch: filtering by id-in
    if ('id' in where && (where.id as { in?: string[] }).in) {
      const ids = (where.id as { in: string[] }).in;
      const live = ids.filter((id) => [CLIENT_A, CLIENT_B, CLIENT_C].includes(id));
      return Promise.resolve(live.map((id) => ({ id })));
    }
    // Head coach branch: coach_id filter
    if ('coach_id' in where) {
      if (where.coach_id === HEAD_COACH) {
        return Promise.resolve([{ id: CLIENT_A }, { id: CLIENT_B }]);
      }
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });

  const subCoachAssignmentFindMany = jest.fn().mockImplementation(
    ({ where }: { where: { sub_coach_id: string } }) => {
      if (where.sub_coach_id === SUB_COACH) {
        return Promise.resolve(opts.assignedToSub.map((cid) => ({ client_id: cid })));
      }
      return Promise.resolve([]);
    },
  );

  return {
    user: { findUnique: userFindUnique, findMany: userFindMany },
    subCoachAssignment: { findMany: subCoachAssignmentFindMany },
  } as unknown as PrismaService;
}

describe('SubCoachScopeService', () => {
  async function build(prisma: PrismaService) {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachScopeService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    return mod.get(SubCoachScopeService);
  }

  it('head coach sees all of their roster', async () => {
    const prisma = buildPrismaMock({
      callerRole: 'coach',
      callerCoachId: null,
      assignedToSub: [],
    });
    const svc = await build(prisma);
    // For head coach, the prisma mock falls through to the head coach
    // findUnique returning role='coach', coach_id=null. The user.findMany
    // returns [CLIENT_A, CLIENT_B] for coach_id=HEAD_COACH.
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      role: 'coach',
      coach_id: null,
    });
    const ids = await svc.getAuthorizedClientIds(HEAD_COACH);
    expect(ids.sort()).toEqual([CLIENT_A, CLIENT_B]);
  });

  it('sub-coach sees only assigned clients', async () => {
    const prisma = buildPrismaMock({
      callerRole: 'coach',
      callerCoachId: HEAD_COACH,
      assignedToSub: [CLIENT_A],
    });
    const svc = await build(prisma);
    const ids = await svc.getAuthorizedClientIds(SUB_COACH);
    expect(ids).toEqual([CLIENT_A]);
  });

  it('sub-coach with no assignments sees nothing', async () => {
    const prisma = buildPrismaMock({
      callerRole: 'coach',
      callerCoachId: HEAD_COACH,
      assignedToSub: [],
    });
    const svc = await build(prisma);
    const ids = await svc.getAuthorizedClientIds(SUB_COACH);
    expect(ids).toEqual([]);
  });

  it('sub-coach cannot access a client assigned to a different sub-coach', async () => {
    const prisma = buildPrismaMock({
      callerRole: 'coach',
      callerCoachId: HEAD_COACH,
      assignedToSub: [CLIENT_A],
    });
    const svc = await build(prisma);
    expect(await svc.canAccessClient(SUB_COACH, CLIENT_B)).toBe(false);
    expect(await svc.canAccessClient(SUB_COACH, CLIENT_A)).toBe(true);
  });

  it('isSubCoach correctly identifies sub-coach vs head coach', async () => {
    const prisma = buildPrismaMock({
      callerRole: 'coach',
      callerCoachId: HEAD_COACH,
      assignedToSub: [],
    });
    const svc = await build(prisma);
    expect(await svc.isSubCoach(SUB_COACH)).toBe(true);

    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      role: 'coach',
      coach_id: null,
    });
    expect(await svc.isSubCoach(HEAD_COACH)).toBe(false);

    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      role: 'student',
      coach_id: HEAD_COACH,
    });
    expect(await svc.isSubCoach('anyone')).toBe(false);
  });

  it('getHeadCoachIdForSubCoach returns head coach id for sub-coaches and null otherwise', async () => {
    const prisma = buildPrismaMock({
      callerRole: 'coach',
      callerCoachId: HEAD_COACH,
      assignedToSub: [],
    });
    const svc = await build(prisma);
    expect(await svc.getHeadCoachIdForSubCoach(SUB_COACH)).toBe(HEAD_COACH);

    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
      role: 'coach',
      coach_id: null,
    });
    expect(await svc.getHeadCoachIdForSubCoach(HEAD_COACH)).toBeNull();
  });

  // Verifies the OTHER_SUB scenario: a sub-coach cannot see another sub-
  // coach's clients. We do this by reusing the mock with a different
  // sub-coach id calling getAuthorizedClientIds; the assignment lookup
  // returns [] because the mock only returns rows for `SUB_COACH`.
  it('other sub-coaches see nothing for clients assigned to a different sub-coach', async () => {
    const prisma = buildPrismaMock({
      callerRole: 'coach',
      callerCoachId: HEAD_COACH,
      assignedToSub: [CLIENT_A], // assigned to SUB_COACH, not OTHER_SUB
    });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: 'coach',
      coach_id: HEAD_COACH,
    });
    const svc = await build(prisma);
    const ids = await svc.getAuthorizedClientIds(OTHER_SUB);
    expect(ids).toEqual([]);
  });
});
