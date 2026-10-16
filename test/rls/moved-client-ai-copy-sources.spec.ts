/**
 * MOVEPROG (owner 4, LS-1051R OWN-PR-B1): the AI paths that name a day or a
 * program by id follow the move rule too (`planStaysInTenantWhere` /
 * `programStaysInTenantWhere` in tenant-clients.ts, the service twin of
 * app.workout_program_stays_in_tenant): an AI create seeded from a day, an AI
 * create into an existing program, an AI assign of a day, and the partial
 * approval check of an AI edit. One row per path, each with a fresh client C
 * of coach A: the call works before C moves (the control), then A gets the
 * path's existing refusal with nothing written and the draft still pending;
 * A's staying client D is unchanged. A sub-coach reaches a client only while
 * the delegation is open. Real services on the superuser connection
 * (service_role, as the API runs), so the service rule decides; the row half
 * reads C's copy as the signed-in API role (non-bypass), a control of 1
 * before each 0.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { ASSIGN_WORKOUT_CAPABILITY, AssignWorkoutMaterializer } from '../../src/ai/gateway/materialisers/assign-workout.materialiser';
import {
  CREATE_WORKOUT_PLAN_CAPABILITY,
  CreateWorkoutPlanMaterializer,
} from '../../src/ai/gateway/materialisers/create-workout-plan.materialiser';
import { EDIT_WORKOUT_PLAN_CAPABILITY } from '../../src/ai/gateway/materialisers/edit-workout-plan.materialiser';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-client-ai-copy-sources: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("A moved client's program copy leaves the AI paths", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  /** Only what each path reaches. */
  const stub = <T>(part: Partial<T>) => part as T;
  const create = new CreateWorkoutPlanMaterializer(
    prisma, new SubCoachScopeService(prisma), stub<AnalyticsService>({ capture: () => undefined }),
  );
  // The push is fire-and-forget after the write; a refused one only logs.
  const assign = new AssignWorkoutMaterializer(
    prisma, stub<NotificationsService>({ createNotification: () => Promise.reject(new Error('push not under test')) }),
  );
  const approvals = new AiApprovalService(prisma, stub<AuditService>({ write: async () => undefined }));
  // Fictional people, fresh ids per run. Coaches a and b; s: a sub-coach on a's team; d: a's client who stays.
  const [a, b, s, d] = Array.from({ length: 4 }, () => randomUUID());
  const role: Record<string, 'coach' | 'student'> = { [a]: 'coach', [b]: 'coach', [s]: 'coach' };
  let stay = { program: '', day: '' };

  const person = (id: string, kind: 'coach' | 'student', coach_id: string | null) => {
    role[id] = kind;
    return prisma.user.create({
      data: { id, supabase_id: id, email: `moveprog-${id}`, name: 'Live person', role: kind, coach_id },
    });
  };
  /** `coach`'s program copy for `client`: day 1 with a head revision, one exercise, assigned to the client. */
  const copy = async (coach: string, client: string) => {
    const program = await prisma.workoutProgram.create({
      data: { id: randomUUID(), name: 'Block', weeks: 1, days_per_week: 1, is_template: false, coach_id: coach, owner_user_id: coach, client_id: client },
    });
    const day = await prisma.workoutPlan.create({
      data: { id: randomUUID(), coach_id: coach, name: 'Day 1', type: 'strength', program_id: program.id, week_index: 0, day_index: 0 },
    });
    const rev = await prisma.workoutPlanRevision.create({
      data: {
        workout_plan_id: day.id, revision_index: 0, exercises_json: [], plan_meta_json: {},
        author_id: coach, author_kind: 'coach', cause: 'create',
      },
    });
    await prisma.workoutPlan.update({ where: { id: day.id }, data: { head_revision_id: rev.id } });
    await prisma.workoutPlanExercise.create({
      data: { workout_plan_id: day.id, exercise_external_id: 'seed:squat-001', order: 0, sets: 3, reps_or_duration_seconds: 10 },
    });
    await prisma.clientWorkoutAssignment.create({
      data: { workout_plan_id: day.id, client_id: client, assigned_by_coach_id: coach, scheduled_for: new Date() },
    });
    return { program: program.id, day: day.id };
  };
  /** A stored pending draft, so each path runs its own claim and checks. */
  const drafts: string[] = [];
  const stored = async (capability: string, tenant: string, requester: string | null, payload: Prisma.InputJsonObject) => {
    const row = await prisma.aiActionDraft.create({
      data: { id: randomUUID(), capability, tenant_coach_id: tenant, requester_id: requester, payload: { capability, ...payload } },
    });
    drafts.push(row.id);
    return row;
  };
  const add = [{ kind: 'add_exercise', client_ref: 'x1', exercise_external_id: 'seed:squat-001', sets: 3, reps_or_duration_seconds: 10 }];
  /** Every row these paths could write. */
  const rows = async () => [
    await prisma.workoutProgram.count(),
    await prisma.workoutPlan.count(),
    await prisma.workoutPlanRevision.count(),
    await prisma.workoutPlanExercise.count(),
    await prisma.clientWorkoutAssignment.count(),
  ];
  /** [program, day, exercise] of a copy as the signed-in API role (row security applies). */
  const seen = (reader: string, c: { program: string; day: string }) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[reader]);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: reader }));
      return [
        await tx.workoutProgram.count({ where: { id: c.program } }),
        await tx.workoutPlan.count({ where: { id: c.day } }),
        await tx.workoutPlanExercise.count({ where: { workout_plan_id: c.day } }),
      ];
    });
  /** 'ok', or the path's existing refusal code. */
  type Refusal = { code?: string; getResponse?: () => { code?: string; error?: string } };
  const outcome = (call: Promise<unknown>) =>
    call.then(
      () => 'ok',
      (e: Refusal) => e.getResponse?.()?.code ?? e.getResponse?.()?.error ?? e.code ?? String(e),
    );

  // [path, call as coach a on copy `c` for client `client`, the refusal after the move]
  type Copy = { program: string; day: string };
  const paths: Array<[string, (c: Copy, client: string) => Promise<unknown>, string]> = [
    [
      'AI create seeded from a day of the copy',
      async (c, client) => create.materialize(await stored(CREATE_WORKOUT_PLAN_CAPABILITY, a, a, {
        target_client_id: client, template_seed: { source_template_plan_id: c.day }, diff: add,
      })),
      'AI_LIVE_CREATE_SEED_NOT_FOUND',
    ],
    [
      'AI create into the copy',
      async (c, client) => create.materialize(await stored(CREATE_WORKOUT_PLAN_CAPABILITY, a, a, {
        target_client_id: client, target_program_id: c.program, diff: add,
      })),
      'AI_LIVE_CREATE_PROGRAM_NOT_FOUND',
    ],
    [
      'AI assign of a day of the copy',
      async (c, client) => assign.materialize(await stored(ASSIGN_WORKOUT_CAPABILITY, a, a, {
        workoutPlanId: c.day, clientId: client, scheduledFor: new Date().toISOString(),
      })),
      'AI_DRAFT_WORKOUT_PLAN_NOT_FOUND',
    ],
    [
      'partial approval of an AI edit of a day of the copy',
      async (c) => {
        const draft = await stored(EDIT_WORKOUT_PLAN_CAPABILITY, a, null, {
          target_plan_id: c.day, base_revision_index: 0,
          diff: [{ kind: 'update_exercise', client_ref: 'a', sets: 5 }, { kind: 'update_exercise', client_ref: 'b', sets: 4 }],
        });
        return approvals.decide({ draftId: draft.id, decider: { id: a, role: 'coach' }, decision: 'approved', acceptedChangeIds: ['c0'] });
      },
      'REVISION_STALE',
    ],
  ];

  beforeAll(async () => {
    for (const coach of [a, b]) await person(coach, 'coach', null);
    await person(s, 'coach', a);
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: a, sub_coach_id: s } });
    await person(d, 'student', a);
    stay = await copy(a, d);
    process.env.FEATURE_MWB_AI_LIVE_CREATE = 'true';
  });
  afterAll(() => prisma.$disconnect());

  it.each(paths)('%s: after the move, the existing refusal and no write', async (_path, call, refused) => {
    const c = randomUUID();
    await person(c, 'student', a);
    const mine = await copy(a, c);
    expect([await outcome(call(mine, d)), await seen(a, mine)]).toEqual(['ok', [1, 1, 1]]);

    await prisma.user.update({ where: { id: c }, data: { coach_id: b } });
    const before = await rows();
    expect([await outcome(call(mine, d)), await seen(a, mine)]).toEqual([refused, [0, 0, 0]]);
    expect(await rows()).toEqual(before);
    const last = drafts[drafts.length - 1];
    expect(await prisma.aiActionDraft.findUniqueOrThrow({ where: { id: last } })).toMatchObject({
      status: 'pending', materialised_at: null, materialised_ref: null,
    });

    // A's staying client: unchanged.
    expect([await outcome(call(stay, d)), await seen(a, stay)]).toEqual(['ok', [1, 1, 1]]);
  });

  it('the copy as each reader sees it: current coach yes, former coach no, client their own, sub-coach only while delegated', async () => {
    const c = randomUUID();
    await person(c, 'student', a);
    const mine = await copy(a, c);
    const delegation = await prisma.subCoachAssignment.create({ data: { head_coach_id: a, sub_coach_id: s, client_id: c } });
    const subCreate = async () => outcome(create.materialize(await stored(CREATE_WORKOUT_PLAN_CAPABILITY, a, s, {
      target_client_id: c, diff: add,
    })));
    // [reader, [program, day, exercise] of c's copy before the move, after it]
    const readers: Array<[string, number[], number[]]> = [
      [a, [1, 1, 1], [0, 0, 0]], // current coach, then former coach
      [b, [0, 0, 0], [0, 0, 0]], // new coach: the copy stays its writer's
      [c, [1, 1, 1], [1, 1, 1]], // the client reads their own
      // The row layer admits no sub-coach to the head coach's copy; the API serves a delegated one (subCreate).
      [s, [0, 0, 0], [0, 0, 0]],
    ];
    const read = async () => {
      const out: number[][] = [];
      for (const [r] of readers) out.push(await seen(r, mine));
      return out;
    };
    expect(await read()).toEqual(readers.map((r) => r[1]));
    expect(await subCreate()).toBe('ok');

    await prisma.user.update({ where: { id: c }, data: { coach_id: b } });
    expect(await read()).toEqual(readers.map((r) => r[2]));
    expect(await subCreate()).toBe('AI_LIVE_CREATE_CLIENT_SCOPE_FORBIDDEN');

    // A delegation closed with the client still at a: the sub-coach is refused too.
    const e = randomUUID();
    await person(e, 'student', a);
    await prisma.subCoachAssignment.update({ where: { id: delegation.id }, data: { unassigned_at: new Date() } });
    const open = await prisma.subCoachAssignment.create({ data: { head_coach_id: a, sub_coach_id: s, client_id: e } });
    const forE = async () => outcome(create.materialize(await stored(CREATE_WORKOUT_PLAN_CAPABILITY, a, s, {
      target_client_id: e, diff: add,
    })));
    expect(await forE()).toBe('ok');
    await prisma.subCoachAssignment.update({ where: { id: open.id }, data: { unassigned_at: new Date() } });
    expect(await forE()).toBe('AI_LIVE_CREATE_CLIENT_SCOPE_FORBIDDEN');
  });
});
