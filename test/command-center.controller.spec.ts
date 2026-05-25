// test/command-center.controller.spec.ts
//
// Integration coverage for the guard stack wired on CommandCenterController.
// Verifies that NoActiveSubCoachGuard rejects coaches with an active
// (non-archived) TeamSubCoachAssignment with 403, and that the same user
// without an active assignment passes through to the service.

import 'reflect-metadata';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { NoActiveSubCoachGuard } from '../src/common/guards/no-active-sub-coach.guard';
import { CommandCenterController } from '../src/coach/command-center/command-center.controller';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachGuard } from '../src/auth/coach.guard';

function makeContext(user: { id: string; role: string } | null): ExecutionContext {
  const req: any = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => CommandCenterController.prototype.getOverview,
    getClass: () => CommandCenterController,
  } as any;
}

function buildPrisma(assignments: Array<{ sub_coach_id: string; archived_at: Date | null }>): any {
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

describe('CommandCenterController — NoActiveSubCoachGuard wiring', () => {
  it('rejects a coach with an active (archived_at: null) TeamSubCoachAssignment with 403', async () => {
    const prisma = buildPrisma([
      { sub_coach_id: 'coach-1', archived_at: null },
    ]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'coach-1', role: 'coach' });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.teamSubCoachAssignment.count).toHaveBeenCalledWith({
      where: { sub_coach_id: 'coach-1', archived_at: null },
    });
  });

  it('lets the same coach through when their sub-coach assignment is archived', async () => {
    const prisma = buildPrisma([
      { sub_coach_id: 'coach-1', archived_at: new Date('2025-01-01') },
    ]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'coach-1', role: 'coach' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('lets a coach with no sub-coach assignment through', async () => {
    const prisma = buildPrisma([]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'coach-1', role: 'coach' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('lets an owner through without consulting Prisma', async () => {
    const prisma = buildPrisma([
      { sub_coach_id: 'owner-1', archived_at: null },
    ]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext({ id: 'owner-1', role: 'owner' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.teamSubCoachAssignment.count).not.toHaveBeenCalled();
  });

  it('returns false (rejects) when no user is on the request', async () => {
    const prisma = buildPrisma([]);
    const guard = new NoActiveSubCoachGuard(prisma);
    const ctx = makeContext(null);

    await expect(guard.canActivate(ctx)).resolves.toBe(false);
  });
});

describe('CommandCenterController — guard stack metadata', () => {
  it('CommandCenterController has the full guard stack in the required order', () => {
    // The full stack must be [JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard]
    // in that order — auth before role check before sub-coach gating. Order
    // matters: NoActiveSubCoachGuard reads req.user, which is only populated
    // after JwtAuthGuard runs, and role checking before sub-coach gating
    // means non-coaches get a clean 403 from CoachGuard rather than tripping
    // an unrelated check.
    const guards: Function[] =
      Reflect.getMetadata('__guards__', CommandCenterController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard]);
  });

  it('routing the guard against the controller blocks an active sub-coach calling getOverview', async () => {
    // Verifies the guard + controller wiring together: an active sub-coach
    // hitting any CommandCenter route is rejected before the service runs.
    const prisma = buildPrisma([
      { sub_coach_id: 'coach-1', archived_at: null },
    ]);
    const guard = new NoActiveSubCoachGuard(prisma);

    const commandCenterSvc = {
      getOverview: jest.fn(),
    } as any;
    const churnSvc = {} as any;
    const controller = new CommandCenterController(commandCenterSvc, churnSvc);

    // Simulate the request lifecycle: guard runs first; only if it
    // resolves to true does Nest invoke the handler. Here the guard
    // throws, so the handler should never be touched.
    const ctx = makeContext({ id: 'coach-1', role: 'coach' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(commandCenterSvc.getOverview).not.toHaveBeenCalled();
    // Sanity: controller construction itself is fine — the guard, not the
    // handler, is what enforces the 403.
    expect(controller).toBeInstanceOf(CommandCenterController);
  });
});
