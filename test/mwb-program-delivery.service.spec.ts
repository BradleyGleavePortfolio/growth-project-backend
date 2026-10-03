/**
 * S-MWB Programs — ProgramDeliveryService (copy a master onto one client,
 * exactly once). Unit level: a recording fake transaction client.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ProgramDeliveryService,
  ProgramEmptyError,
  type DeliverProgramInput,
} from '../src/workout-builder/program-delivery.service';

/** Test seam: hand a hand-rolled fake to a constructor/method param of type T. */
function fake<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;

function masterPlans() {
  return [
    {
      id: 'mp-0-0',
      name: 'Day A',
      type: 'strength',
      duration_estimate_minutes: 45,
      week_index: 0,
      day_index: 0,
      exercises: [
        {
          exercise_external_id: 'ex-1',
          order: 1,
          sets: 3,
          reps_or_duration_seconds: 10,
          weight_lbs: 50,
          rest_seconds: 60,
          superset_group_id: 'g1',
          notes: null,
        },
        {
          exercise_external_id: 'ex-2',
          order: 2,
          sets: 3,
          reps_or_duration_seconds: 12,
          weight_lbs: null,
          rest_seconds: null,
          superset_group_id: 'g1',
          notes: 'slow',
        },
      ],
    },
    {
      id: 'mp-1-2',
      name: 'Day B',
      type: 'cardio',
      duration_estimate_minutes: null,
      week_index: 1,
      day_index: 2,
      exercises: [],
    },
  ];
}

function makeTx(
  opts: {
    existingKey?: string | null;
    master?: Row | null;
    plans?: unknown[];
    createThrows?: unknown;
  } = {},
) {
  const writes: Record<string, Row[]> = {};
  const record = (model: string) =>
    jest.fn(async (args: { data: Row | Row[] }) => {
      const rows = Array.isArray(args.data) ? args.data : [args.data];
      writes[model] = [...(writes[model] ?? []), ...rows];
      return Array.isArray(args.data) ? { count: rows.length } : args.data;
    });
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    workoutProgram: {
      findUnique: jest.fn(async () => (opts.existingKey ? { id: opts.existingKey } : null)),
      findFirst: jest.fn(async () =>
        opts.master === undefined
          ? {
              id: 'master-1',
              name: 'Intro',
              description: 'd',
              weeks: 2,
              days_per_week: 3,
              goal_tag: 'intro',
              coach_id: 'coach-1',
            }
          : opts.master,
      ),
      create: opts.createThrows
        ? jest.fn(async () => {
            throw opts.createThrows;
          })
        : record('workoutProgram'),
    },
    workoutPlan: {
      findMany: jest.fn(async () => opts.plans ?? masterPlans()),
      createMany: record('workoutPlan'),
    },
    workoutPlanExercise: { createMany: record('workoutPlanExercise') },
    workoutPlanRevision: { createMany: record('workoutPlanRevision') },
    workoutProgramRevision: { create: record('workoutProgramRevision') },
    clientWorkoutAssignment: {
      createMany: record('clientWorkoutAssignment'),
      findMany: jest.fn(async () => [
        { id: 'a-1', workout_plan_id: 'p-1', scheduled_for: new Date('2026-10-05T12:00:00Z') },
        { id: 'a-2', workout_plan_id: 'p-2', scheduled_for: new Date('2026-10-14T12:00:00Z') },
      ]),
    },
    clientWorkoutAssignmentSnapshot: { createMany: record('clientWorkoutAssignmentSnapshot') },
  };
  return { tx, writes };
}

const input: DeliverProgramInput = {
  masterProgramId: 'master-1',
  tenantCoachId: 'coach-1',
  actingUserId: 'coach-1',
  authorKind: 'coach',
  clientId: 'client-1',
  startAt: new Date('2026-10-05T12:00:00.000Z'),
  deliveryKey: 'bulk:coach-1:key-1:client-1',
  source: 'bulk_assign',
};

function service() {
  return new ProgramDeliveryService(fake({}));
}

describe('ProgramDeliveryService.deliverInTx', () => {
  it('copies every master day by value onto the client and schedules week*7+day from the start', async () => {
    const { tx, writes } = makeTx();
    const out = await service().deliverInTx(fake(tx), input);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // advisory lock first
    const program = writes.workoutProgram[0];
    expect(program).toMatchObject({
      coach_id: 'coach-1',
      owner_user_id: 'coach-1',
      is_template: false,
      cloned_from_id: 'master-1',
      client_id: 'client-1',
      delivery_key: 'bulk:coach-1:key-1:client-1',
      name: 'Intro',
      weeks: 2,
      days_per_week: 3,
    });
    expect(writes.workoutPlan).toHaveLength(2);
    expect(
      writes.workoutPlan.every((p) => p.program_id === program.id && p.is_template === false),
    ).toBe(true);
    // superset groups are re-keyed into the new plan's namespace, shared within the plan
    const ex = writes.workoutPlanExercise;
    expect(ex).toHaveLength(2);
    expect(ex[0].superset_group_id).toBe(ex[1].superset_group_id);
    expect(ex[0].superset_group_id).not.toBe('g1');
    // head pointers reference the revision rows written in the same tx
    const revIds = writes.workoutPlanRevision.map((r) => r.id);
    expect(writes.workoutPlan.map((p) => p.head_revision_id)).toEqual(revIds);
    expect(program.head_revision_id).toBe(writes.workoutProgramRevision[0].id);

    const scheduled = writes.clientWorkoutAssignment.map((a) =>
      (a.scheduled_for as Date).toISOString(),
    );
    expect(scheduled).toEqual(['2026-10-05T12:00:00.000Z', '2026-10-14T12:00:00.000Z']); // +0 and +(7+2)
    expect(
      writes.clientWorkoutAssignment.every(
        (a) => a.client_id === 'client-1' && a.assigned_by_coach_id === 'coach-1',
      ),
    ).toBe(true);
    // one immutable snapshot per assignment
    expect(writes.clientWorkoutAssignmentSnapshot.map((s) => s.assignment_id)).toEqual(
      writes.clientWorkoutAssignment.map((a) => a.id),
    );
    expect(out).toMatchObject({
      program_id: program.id,
      replayed: false,
      first_scheduled_for: '2026-10-05T12:00:00.000Z',
      last_scheduled_for: '2026-10-14T12:00:00.000Z',
    });
    expect(out.assignment_ids).toHaveLength(2);
    expect(out.first_assignment_id).toBe(writes.clientWorkoutAssignment[0].id);
  });

  it('replays an already-delivered key without writing anything', async () => {
    const { tx, writes } = makeTx({ existingKey: 'copy-9' });
    const out = await service().deliverInTx(fake(tx), input);
    expect(out).toMatchObject({ program_id: 'copy-9', replayed: true, first_assignment_id: 'a-1' });
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it('refuses a master outside the tenant with program_not_found', async () => {
    const { tx } = makeTx({ master: null });
    await expect(service().deliverInTx(fake(tx), input)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an empty master (nothing to deliver)', async () => {
    const { tx, writes } = makeTx({ plans: [] });
    await expect(service().deliverInTx(fake(tx), input)).rejects.toBeInstanceOf(ProgramEmptyError);
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it('maps a delivery_key unique violation to a typed retryable 409, never a second copy', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    const { tx, writes } = makeTx({ createThrows: p2002 });
    const run = service().deliverInTx(fake(tx), input);
    await expect(run).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service().deliverInTx(fake(makeTx({ createThrows: p2002 }).tx), input),
    ).rejects.toMatchObject({
      response: { code: 'program_delivery_in_progress' },
    });
    expect(writes.workoutPlan).toBeUndefined();
  });
});
