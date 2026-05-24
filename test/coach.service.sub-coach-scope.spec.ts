import { Test, TestingModule } from '@nestjs/testing';
import { CoachService } from '../src/coach/coach.service';
import { PrismaService } from '../src/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ConsentService } from '../src/consent/consent.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

/**
 * Regression test for Audit #2 P1-3:
 *   - Head coach calls into CoachService → sees all of their roster
 *     (existing behavior unchanged).
 *   - Sub-coach calls into CoachService → sees only their assigned
 *     clients via SubCoachAssignment overlay.
 */
describe('CoachService — sub-coach scoping', () => {
  let prisma: { user: { findMany: jest.Mock; findFirst: jest.Mock } };
  let scope: { isSubCoach: jest.Mock; getAuthorizedClientIds: jest.Mock };
  let service: CoachService;

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    scope = {
      isSubCoach: jest.fn(),
      getAuthorizedClientIds: jest.fn(),
    };

    const consentStub = {
      coachCanAccess: jest.fn().mockResolvedValue(true),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CoachService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: ConsentService, useValue: consentStub },
        { provide: SubCoachScopeService, useValue: scope },
      ],
    }).compile();
    service = mod.get(CoachService);
  });

  it('head coach: getClients uses coach_id filter (unchanged behavior)', async () => {
    scope.isSubCoach.mockResolvedValue(false);
    prisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await service.getClients('head-1', 'active', 'coach');
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ coach_id: 'head-1' }),
      }),
    );
  });

  it('sub-coach: getClients filters by SubCoachAssignment-derived ids', async () => {
    scope.isSubCoach.mockResolvedValue(true);
    scope.getAuthorizedClientIds.mockResolvedValue(['c1', 'c2']);
    prisma.user.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

    await service.getClients('sub-1', 'active', 'coach');
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['c1', 'c2'] } }),
      }),
    );
  });

  it('sub-coach with no assignments: getClients returns no rows via impossible filter', async () => {
    scope.isSubCoach.mockResolvedValue(true);
    scope.getAuthorizedClientIds.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);

    await service.getClients('sub-1', 'active', 'coach');
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [] } }),
      }),
    );
  });

  it('owner: getClients has no coach scoping', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await service.getClients('owner-1', 'active', 'owner');
    const callArgs = prisma.user.findMany.mock.calls[0][0];
    expect(callArgs.where.coach_id).toBeUndefined();
    expect(callArgs.where.id).toBeUndefined();
  });

  it('sub-coach: archiveClient fails when client is not in their assigned list', async () => {
    scope.isSubCoach.mockResolvedValue(true);
    scope.getAuthorizedClientIds.mockResolvedValue(['only-mine']);
    prisma.user.findFirst.mockResolvedValue(null); // findFirst returns null for 'someone-elses'

    await expect(
      service.archiveClient('sub-1', 'someone-elses', 'coach'),
    ).rejects.toThrow('Client not found');
  });
});
