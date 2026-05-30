// test/ltv-metrics.controller.spec.ts
//
// P0 (CC+SC re-audit): the financial LTV route
// (GET /coach/command-center/ltv-metrics) must be protected by
// NoActiveSubCoachGuard so an ACTIVE sub-coach cannot read the head coach's
// revenue. SC-1 removed the guard from the OPERATIONAL CommandCenterController
// precisely because it belongs on THIS financial controller. These tests
// pin two things:
//   1. The class-level guard stack is exactly
//      [JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard].
//   2. NoActiveSubCoachGuard actually DENIES an active sub-coach (a coach
//      with an open, non-archived TeamSubCoachAssignment) with 403, while
//      letting head coaches and owners through.

import 'reflect-metadata';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { NoActiveSubCoachGuard } from '../src/common/guards/no-active-sub-coach.guard';
import { LtvMetricsController } from '../src/coach/command-center/ltv-metrics.controller';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachGuard } from '../src/auth/coach.guard';

function makeContext(user: { id: string; role: string } | null): ExecutionContext {
  const req: any = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => LtvMetricsController.prototype.getLtvMetrics,
    getClass: () => LtvMetricsController,
  } as any;
}

function buildPrisma(
  assignments: Array<{ sub_coach_id: string; archived_at: Date | null }>,
): any {
  return {
    teamSubCoachAssignment: {
      count: jest.fn(async ({ where }: any) => {
        return assignments.filter((a) => {
          if (where.sub_coach_id && a.sub_coach_id !== where.sub_coach_id) return false;
          if (where.archived_at === null && a.archived_at !== null) return false;
          return true;
        }).length;
      }),
    },
  };
}

describe('LtvMetricsController — financial guard stack (P0)', () => {
  it('class-level guard stack is [JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard]', () => {
    const guards: Array<new (...args: any[]) => unknown> =
      Reflect.getMetadata('__guards__', LtvMetricsController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard]);
    // The financial surface MUST carry the sub-coach fence.
    expect(guards).toContain(NoActiveSubCoachGuard);
  });
});

describe('LtvMetricsController — NoActiveSubCoachGuard denies active sub-coaches', () => {
  it('DENIES an active sub-coach (open TeamSubCoachAssignment) with 403', async () => {
    const prisma = buildPrisma([{ sub_coach_id: 'sub-1', archived_at: null }]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'sub-1', role: 'coach' });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.teamSubCoachAssignment.count).toHaveBeenCalledWith({
      where: { sub_coach_id: 'sub-1', archived_at: null },
    });
  });

  it('lets a head coach (no active sub-coach assignment) read LTV metrics', async () => {
    const prisma = buildPrisma([]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'head-1', role: 'coach' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('lets a coach through once their sub-coach assignment is archived', async () => {
    const prisma = buildPrisma([
      { sub_coach_id: 'coach-1', archived_at: new Date('2025-01-01') },
    ]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'coach-1', role: 'coach' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('lets an owner through without consulting Prisma', async () => {
    const prisma = buildPrisma([{ sub_coach_id: 'owner-1', archived_at: null }]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'owner-1', role: 'owner' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.teamSubCoachAssignment.count).not.toHaveBeenCalled();
  });
});
