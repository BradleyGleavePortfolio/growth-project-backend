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

describe('CommandCenterController — guard stack metadata (SC-1)', () => {
  it('class-level guard stack is [JwtAuthGuard, CoachGuard] — NoActiveSubCoachGuard removed', () => {
    // SC-1: NoActiveSubCoachGuard was previously applied at CLASS level,
    // which blocked active sub-coaches from EVERY Command Center surface
    // (overview/at-risk/win-streaks/inbox/action-queue), all of which are
    // operational (non-financial). The guard belongs only on financial/
    // owner-only surfaces (the separate LtvMetricsController). After the
    // fix, the class stack must be exactly [JwtAuthGuard, CoachGuard] and
    // must NOT contain NoActiveSubCoachGuard, so a sub-coach regains the
    // operational surfaces.
    const guards: Function[] =
      Reflect.getMetadata('__guards__', CommandCenterController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, CoachGuard]);
    expect(guards).not.toContain(NoActiveSubCoachGuard);
  });

  it('SC-1: an active sub-coach reaches an operational route (no class-level block)', async () => {
    // With the class-level guard removed, an active sub-coach hitting an
    // operational route is NOT short-circuited: the handler runs and
    // delegates to the service (which applies roster scoping via SC-2).
    const overview = {
      roster_size: 3,
      active_today: 1,
      check_in_rate_7day: 0.1,
      open_alerts: 0,
      at_risk_count: 0,
      win_streak_count: 0,
      unread_messages: 0,
      pending_actions: 0,
    };
    const commandCenterSvc = { getOverview: jest.fn(async () => overview) } as any;
    const churnSvc = {} as any;
    const controller = new CommandCenterController(commandCenterSvc, churnSvc);

    const req: any = { user: { id: 'sub-1', role: 'coach' } };
    const out = await controller.getOverview(req);
    expect(commandCenterSvc.getOverview).toHaveBeenCalledWith('sub-1');
    expect(out).toBe(overview);
  });
});
