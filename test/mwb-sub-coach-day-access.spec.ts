/**
 * S-MWB-2 — a team sub-coach can open the day workouts of a library program
 * they own or one shared with the team (GET /workout-plans/:id). Program day
 * plans carry the tenant (head coach) id, so before this fix the bare
 * `plan.coach_id === caller` check 403'd even the program's own author.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';

/** Test seam: hand a hand-rolled fake to a constructor/method param of type T. */
function fake<T>(value: unknown): T {
  return value as T;
}

const DAY_PLAN = {
  id: 'plan-day',
  coach_id: 'head-1',
  program_id: 'master-1',
  exercises: [],
};

function build(opts: {
  headCoachId: string | null;
  program: { is_template: boolean; owner_user_id: string; visibility: string } | null;
  plan?: Record<string, unknown>;
}) {
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ role: 'coach' })) },
    workoutPlan: { findUnique: jest.fn(async () => opts.plan ?? DAY_PLAN) },
    workoutProgram: { findUnique: jest.fn(async () => opts.program) },
  };
  const subCoachScope = {
    getHeadCoachIdForSubCoach: jest.fn(async () => opts.headCoachId),
  };
  const svc = new WorkoutBuilderService(fake(prisma), undefined, fake(subCoachScope));
  return { svc, prisma, subCoachScope };
}

describe('WorkoutBuilderService.getPlan: team program days', () => {
  it('a sub-coach opens a day of a program they authored', async () => {
    const { svc } = build({
      headCoachId: 'head-1',
      program: { is_template: true, owner_user_id: 'sub-1', visibility: 'owner_only' },
    });
    await expect(svc.getPlan('sub-1', 'plan-day')).resolves.toMatchObject({ id: 'plan-day' });
  });

  it('a sub-coach opens a day of a program shared with the team', async () => {
    const { svc } = build({
      headCoachId: 'head-1',
      program: { is_template: true, owner_user_id: 'head-1', visibility: 'tenant_shared' },
    });
    await expect(svc.getPlan('sub-1', 'plan-day')).resolves.toMatchObject({ id: 'plan-day' });
  });

  it("the head coach's private program stays closed to a sub-coach", async () => {
    const { svc } = build({
      headCoachId: 'head-1',
      program: { is_template: true, owner_user_id: 'head-1', visibility: 'owner_only' },
    });
    await expect(svc.getPlan('sub-1', 'plan-day')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a coach outside the team (or a bare coach_id without membership) is refused', async () => {
    const { svc } = build({
      headCoachId: null,
      program: { is_template: true, owner_user_id: 'head-1', visibility: 'tenant_shared' },
    });
    await expect(svc.getPlan('sub-1', 'plan-day')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a standalone plan (no program) or a client's copy keeps the strict owner check", async () => {
    const standalone = build({
      headCoachId: 'head-1',
      program: null,
      plan: { ...DAY_PLAN, program_id: null },
    });
    await expect(standalone.svc.getPlan('sub-1', 'plan-day')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const copy = build({
      headCoachId: 'head-1',
      program: { is_template: false, owner_user_id: 'sub-1', visibility: 'owner_only' },
    });
    await expect(copy.svc.getPlan('sub-1', 'plan-day')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('WorkoutBuilderService.assertCanAccessClient: deleted accounts (B-640-3)', () => {
  it('a tombstoned client is not found, even for their own head coach', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({
          id: 'client-1',
          coach_id: 'coach-1',
          deleted_at: new Date('2026-10-01T00:00:00Z'),
        })),
      },
    };
    const svc = new WorkoutBuilderService(fake(prisma));
    await expect(svc.assertCanAccessClient('coach-1', 'client-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a live client of the head coach still passes', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({
          id: 'client-1',
          coach_id: 'coach-1',
          deleted_at: null,
        })),
      },
    };
    const svc = new WorkoutBuilderService(fake(prisma));
    await expect(svc.assertCanAccessClient('coach-1', 'client-1')).resolves.toBeUndefined();
  });
});

describe('WorkoutBuilderService.archivePlan: packaged programs keep a day (C-640-5)', () => {
  function build(others: number, inPackage: number) {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      workoutPlan: {
        count: jest.fn(async () => others),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      coachPackageContent: { count: jest.fn(async () => inPackage) },
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ role: 'coach' })) },
      workoutPlan: {
        findUnique: jest.fn(async () => ({
          id: 'plan-day',
          coach_id: 'coach-1',
          program_id: 'master-1',
          archived_at: null,
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { svc: new WorkoutBuilderService(fake(prisma)), prisma, tx };
  }

  it('refuses the last day of a program a package delivers, with the typed code', async () => {
    const { svc, tx, prisma } = build(0, 1);
    await expect(svc.archivePlan('coach-1', 'plan-day')).rejects.toMatchObject({
      response: { code: 'program_in_package_needs_a_day' },
    });
    expect(tx.workoutPlan.updateMany).not.toHaveBeenCalled();
    expect(prisma.workoutPlan.updateMany).not.toHaveBeenCalled();
    const lockSql = fake<string[]>(fake<unknown[][]>(tx.$executeRaw.mock.calls)[0][0]).join('?');
    expect(lockSql).toMatch(/pg_advisory_xact_lock/);
  });

  it('archives a day when other days remain, inside the locked transaction', async () => {
    const { svc, tx } = build(2, 1);
    await svc.archivePlan('coach-1', 'plan-day');
    expect(tx.workoutPlan.updateMany).toHaveBeenCalledWith({
      where: { id: 'plan-day', coach_id: 'coach-1', archived_at: null },
      data: { archived_at: expect.any(Date) },
    });
  });
});
