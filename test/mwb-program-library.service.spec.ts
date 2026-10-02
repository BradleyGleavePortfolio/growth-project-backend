/**
 * S-MWB Programs — ProgramLibraryService + ProgramLibraryFeatureGuard.
 * Unit level with jest mocks: access rules, typed error codes, bulk-assign
 * per-client results (assigned / already_assigned / failed), idempotent
 * replay, and the package guards on archive / clear-day.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  ProgramLibraryService,
  startDateToInstant,
} from '../src/workout-builder/program-library.service';
import { ProgramLibraryFeatureGuard } from '../src/workout-builder/program-library.controller';

/** Test seam: hand a hand-rolled fake to a constructor/method param of type T. */
function fake<T>(value: unknown): T {
  return value as T;
}

const COACH = { id: 'coach-1', role: 'coach', coach_id: null };
const MASTER = {
  id: 'master-1',
  coach_id: 'coach-1',
  owner_user_id: 'coach-1',
  visibility: 'owner_only',
  name: 'Intro package',
  description: null,
  goal_tag: 'intro',
  weeks: 4,
  days_per_week: 3,
  is_template: true,
  is_regime: false,
  regime_display_name: null,
  version: 3,
  archived_at: null as Date | null,
  updated_at: new Date('2026-10-01T00:00:00Z'),
};

// Loosely typed async mock: tests override return values per case.
function mk(value: unknown): jest.Mock<Promise<unknown>, unknown[]> {
  return jest.fn<Promise<unknown>, unknown[]>(async () => value);
}

function makePrisma(over: Record<string, unknown> = {}) {
  const tx = {
    $executeRaw: mk(1),
    workoutProgram: {
      findFirst: mk({ ...MASTER }),
      findUnique: mk(null),
      findUniqueOrThrow: mk({ ...MASTER }),
      update: mk({}),
      updateMany: mk({ count: 1 }),
      findMany: mk([]),
    },
    workoutPlan: {
      count: mk(2),
      findFirst: mk(null),
      findMany: mk([]),
      update: mk({}),
      create: mk({}),
    },
    workoutPlanExercise: { createMany: mk({ count: 0 }) },
    workoutPlanRevision: { create: mk({}) },
    workoutProgramRevision: { findFirst: mk({ revision_index: 4 }), create: mk({}) },
    coachPackageContent: { count: mk(0) },
    clientWorkoutAssignment: { deleteMany: mk({ count: 0 }), count: mk(0) },
  };
  const prisma = {
    user: { findUnique: mk(COACH), findMany: mk([]) },
    workoutProgram: {
      findFirst: mk({ ...MASTER }),
      findUniqueOrThrow: mk({ ...MASTER }),
      findMany: mk([]),
      updateMany: mk({ count: 1 }),
    },
    workoutPlan: {
      count: mk(2),
      groupBy: mk([]),
      findMany: mk([]),
    },
    coachPackageContent: { groupBy: mk([]), findMany: mk([]) },
    $queryRaw: mk([]),
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    ...over,
  };
  return { prisma, tx };
}

function makeService(
  prisma: unknown,
  opts: { access?: (clientId: string) => void; deliver?: jest.Mock } = {},
) {
  const workoutBuilder = {
    withIdempotency: jest.fn(async (_u: string, _r: string, _k: string, op: () => unknown) => op()),
    assertCanAccessClient: jest.fn(async (_coach: string, clientId: string) =>
      opts.access?.(clientId),
    ),
  };
  const delivery = {
    deliverInTx:
      opts.deliver ??
      jest.fn(async (_tx: unknown, input: { clientId: string }) => ({
        program_id: `copy-${input.clientId}`,
        assignment_ids: ['a1', 'a2', 'a3'],
        first_assignment_id: 'a1',
        first_plan_id: 'p1',
        first_scheduled_for: '2026-10-05T12:00:00.000Z',
        last_scheduled_for: '2026-10-26T12:00:00.000Z',
        replayed: false,
      })),
  };
  const notifications = { createNotification: jest.fn(async () => null) };
  const svc = new ProgramLibraryService(
    fake(prisma),
    fake(workoutBuilder),
    fake(delivery),
    fake(notifications),
  );
  return { svc, workoutBuilder, delivery, notifications };
}

describe('startDateToInstant', () => {
  it('anchors a calendar date at 12:00 UTC', () => {
    expect(startDateToInstant('2026-10-05').toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });
  it('rejects an impossible date with invalid_start_date', () => {
    expect(() => startDateToInstant('2026-02-30')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'invalid_start_date' }),
      }),
    );
  });
});

describe('ProgramLibraryFeatureGuard', () => {
  const prev = process.env.FEATURE_MWB_TEMPLATES;
  afterEach(() => {
    if (prev === undefined) delete process.env.FEATURE_MWB_TEMPLATES;
    else process.env.FEATURE_MWB_TEMPLATES = prev;
  });
  it('404s with programs_unavailable while FEATURE_MWB_TEMPLATES is off', () => {
    delete process.env.FEATURE_MWB_TEMPLATES;
    expect(() => new ProgramLibraryFeatureGuard().canActivate()).toThrow(NotFoundException);
    try {
      new ProgramLibraryFeatureGuard().canActivate();
    } catch (e) {
      expect((e as NotFoundException).getResponse()).toMatchObject({
        code: 'programs_unavailable',
      });
    }
  });
  it('passes when the flag is exactly true', () => {
    process.env.FEATURE_MWB_TEMPLATES = 'true';
    expect(new ProgramLibraryFeatureGuard().canActivate()).toBe(true);
  });
});

describe('ProgramLibraryService access', () => {
  it('refuses a client-role caller with coach_role_required', async () => {
    const { prisma } = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u', role: 'student', coach_id: 'coach-1' });
    const { svc } = makeService(prisma);
    await expect(svc.getProgram('u', 'master-1')).rejects.toMatchObject({
      response: { code: 'coach_role_required' },
    });
  });

  it('a program outside the readable set is program_not_found (never leaks existence)', async () => {
    const { prisma } = makePrisma();
    prisma.workoutProgram.findFirst.mockResolvedValueOnce(null);
    const { svc } = makeService(prisma);
    await expect(svc.getProgram('coach-1', 'other')).rejects.toMatchObject({
      response: { code: 'program_not_found' },
    });
    const where = fake<[{ where: Record<string, unknown> }]>(
      prisma.workoutProgram.findFirst.mock.calls[0],
    )[0].where;
    expect(where).toMatchObject({ id: 'other', coach_id: 'coach-1', is_template: true });
  });
});

describe('ProgramLibraryService edits', () => {
  it('updateProgram: stale expected_version is program_version_conflict', async () => {
    const { prisma } = makePrisma();
    const { svc } = makeService(prisma);
    await expect(
      svc.updateProgram('coach-1', 'master-1', { expected_version: 2, name: 'x' }, 'k'),
    ).rejects.toMatchObject({ response: { code: 'program_version_conflict' } });
  });

  it('updateProgram: shortening below a filled week is program_days_out_of_range', async () => {
    const { prisma, tx } = makePrisma();
    tx.workoutPlan.count.mockResolvedValueOnce(2);
    const { svc } = makeService(prisma);
    await expect(
      svc.updateProgram('coach-1', 'master-1', { expected_version: 3, weeks: 2 }, 'k'),
    ).rejects.toMatchObject({ response: { code: 'program_days_out_of_range' } });
  });

  it("updateProgram: a team member cannot edit someone else's program (program_read_only)", async () => {
    const { prisma, tx } = makePrisma();
    tx.workoutProgram.findFirst.mockResolvedValueOnce({
      ...MASTER,
      owner_user_id: 'head-coach',
      visibility: 'tenant_shared',
    });
    const { svc } = makeService(prisma);
    await expect(
      svc.updateProgram('coach-1', 'master-1', { expected_version: 3 }, 'k'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('setDay: an occupied slot is program_day_filled', async () => {
    const { prisma, tx } = makePrisma();
    tx.workoutPlan.findFirst.mockResolvedValueOnce({ id: 'plan-x' });
    const { svc } = makeService(prisma);
    await expect(
      svc.setDay('coach-1', 'master-1', 0, 0, { source: 'blank' }, 'k'),
    ).rejects.toMatchObject({
      response: { code: 'program_day_filled' },
    });
  });

  it('setDay: a week outside the program is program_day_out_of_range', async () => {
    const { prisma } = makePrisma();
    const { svc } = makeService(prisma);
    await expect(
      svc.setDay('coach-1', 'master-1', 4, 0, { source: 'blank' }, 'k'),
    ).rejects.toMatchObject({
      response: { code: 'program_day_out_of_range' },
    });
  });

  it('setDay blank: writes the day plan (tenant coach_id, slot) + revision and bumps the program revision', async () => {
    const { prisma, tx } = makePrisma();
    const { svc } = makeService(prisma);
    await svc.setDay('coach-1', 'master-1', 1, 3, { source: 'blank', type: 'mobility' }, 'k');
    expect(tx.workoutPlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coach_id: 'coach-1',
        program_id: 'master-1',
        week_index: 1,
        day_index: 3,
        is_template: true,
        type: 'mobility',
        name: 'Week 2, Day 4',
      }),
    });
    expect(tx.workoutPlanRevision.create).toHaveBeenCalled();
    expect(tx.workoutProgramRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ revision_index: 5, cause: 'manual_edit' }),
    });
    expect(tx.workoutProgram.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: { increment: 1 } }) }),
    );
  });

  it('clearDay: the last workout of a program a package delivers cannot be cleared', async () => {
    const { prisma, tx } = makePrisma();
    tx.workoutPlan.findFirst.mockResolvedValueOnce({ id: 'plan-1' });
    tx.workoutPlan.count.mockResolvedValueOnce(1);
    tx.coachPackageContent.count.mockResolvedValueOnce(1);
    const { svc } = makeService(prisma);
    await expect(svc.clearDay('coach-1', 'master-1', 0, 0)).rejects.toMatchObject({
      response: { code: 'program_in_package_needs_a_day' },
    });
    expect(tx.workoutPlan.update).not.toHaveBeenCalled();
  });

  it('archiveProgram: refused while a live package delivers it, naming the package', async () => {
    const { prisma } = makePrisma();
    prisma.coachPackageContent.findMany.mockResolvedValueOnce([
      { package: { name: 'Clinic intro' } },
    ]);
    const { svc } = makeService(prisma);
    await expect(svc.archiveProgram('coach-1', 'master-1')).rejects.toMatchObject({
      response: { code: 'program_in_package', message: expect.stringContaining('Clinic intro') },
    });
    expect(prisma.workoutProgram.updateMany).not.toHaveBeenCalled();
  });
});

describe('ProgramLibraryService.bulkAssign', () => {
  const dto = { client_ids: ['c-ok', 'c-foreign', 'c-busy'], start_date: '2026-10-05' };

  it('returns one result per client: assigned, not_your_client, already_assigned', async () => {
    const { prisma, tx } = makePrisma();
    // c-busy already has a live copy with unfinished workouts.
    tx.workoutProgram.findFirst.mockImplementation(async (...args: unknown[]) => {
      const where = (args[0] as { where: { OR?: Array<{ client_id?: string }> } }).where;
      const ids = (where.OR ?? []).map((o) => o.client_id);
      return ids.includes('c-busy') ? { id: 'copy-busy' } : null;
    });
    const { svc, delivery, notifications } = makeService(prisma, {
      access: (clientId) => {
        if (clientId === 'c-foreign')
          throw new ForbiddenException('Client does not belong to this coach');
      },
    });
    const res = await svc.bulkAssign(
      'coach-1',
      'master-1',
      dto,
      '11111111-1111-4111-8111-111111111111',
    );
    expect(res.results.map((r) => [r.client_id, r.status, r.code])).toEqual([
      ['c-ok', 'assigned', undefined],
      ['c-foreign', 'failed', 'not_your_client'],
      ['c-busy', 'already_assigned', 'program_already_assigned'],
    ]);
    expect(res.summary).toEqual({ total: 3, assigned: 1, already_assigned: 1, failed: 1 });
    expect(delivery.deliverInTx).toHaveBeenCalledTimes(1);
    const call = fake<[unknown, Record<string, unknown>]>(delivery.deliverInTx.mock.calls[0])[1];
    expect(call).toMatchObject({
      masterProgramId: 'master-1',
      tenantCoachId: 'coach-1',
      clientId: 'c-ok',
      deliveryKey: 'bulk:coach-1:11111111-1111-4111-8111-111111111111:c-ok',
      source: 'bulk_assign',
    });
    expect((call.startAt as Date).toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
  });

  it('a replay of the same key reports assigned (replayed) and sends no second push', async () => {
    const { prisma, tx } = makePrisma();
    tx.workoutProgram.findUnique.mockResolvedValue({ id: 'copy-c-ok' });
    const deliver = jest.fn(async () => ({
      program_id: 'copy-c-ok',
      assignment_ids: ['a1'],
      first_assignment_id: 'a1',
      first_plan_id: 'p1',
      first_scheduled_for: 'x',
      last_scheduled_for: 'y',
      replayed: true,
    }));
    const { svc, notifications } = makeService(prisma, { deliver });
    const res = await svc.bulkAssign(
      'coach-1',
      'master-1',
      { client_ids: ['c-ok'], start_date: '2026-10-05' },
      'k',
    );
    expect(res.results[0]).toMatchObject({ status: 'assigned', replayed: true });
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('an unexpected per-client error is isolated, reported with a support reference, and the batch continues', async () => {
    const { prisma, tx } = makePrisma();
    tx.workoutProgram.findFirst.mockResolvedValue(null); // no client has an active copy
    const deliver = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({
        program_id: 'copy-2',
        assignment_ids: ['a'],
        first_assignment_id: 'a',
        first_plan_id: 'p',
        first_scheduled_for: 'x',
        last_scheduled_for: 'y',
        replayed: false,
      });
    const { svc } = makeService(prisma, { deliver });
    const res = await svc.bulkAssign(
      'coach-1',
      'master-1',
      { client_ids: ['c1', 'c2'], start_date: '2026-10-05' },
      'k',
    );
    expect(res.results[0]).toMatchObject({ status: 'failed', code: 'assign_failed' });
    expect(res.results[0].message).toMatch(/reference [0-9a-f-]{36}/);
    expect(res.results[1]).toMatchObject({ status: 'assigned' });
  });

  it('refuses an archived or empty program before touching any client', async () => {
    const { prisma } = makePrisma();
    prisma.workoutProgram.findFirst.mockResolvedValueOnce({ ...MASTER, archived_at: new Date() });
    const { svc, delivery } = makeService(prisma);
    await expect(svc.bulkAssign('coach-1', 'master-1', dto, 'k')).rejects.toMatchObject({
      response: { code: 'program_archived' },
    });
    prisma.workoutPlan.count.mockResolvedValueOnce(0);
    await expect(svc.bulkAssign('coach-1', 'master-1', dto, 'k')).rejects.toMatchObject({
      response: { code: 'program_empty' },
    });
    expect(delivery.deliverInTx).not.toHaveBeenCalled();
  });
});
