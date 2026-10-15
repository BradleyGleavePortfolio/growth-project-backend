/**
 * MOVEGAPS (owner 4, 139-13): four more routes that read a day of a client's
 * program copy by id follow the move rule (`planStaysInTenantWhere`): the
 * broadcast workout card, attaching a plan to a package, the AI workout
 * builder (propose, and applying an edit) and community plan tags (resolve
 * and send). One row per route, each with a fresh client C of coach A: the
 * call works before C moves (the control), then A gets the route's existing
 * refusal with nothing written; A's staying client and C's new coach B are
 * unchanged. Real services on the superuser connection (service_role, as the
 * API runs), so the service rule decides; each row also reads the same day as
 * the signed-in API role (non-bypass), a control of 1 before each 0.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { AiActionDraft, CoachPackage, User } from '@prisma/client';
import type { AiGatewayConfig, ResolvedAiConfig } from '../../src/ai/gateway/ai-gateway.config';
import type { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import {
  EDIT_WORKOUT_PLAN_CAPABILITY,
  EditWorkoutPlanMaterializer,
} from '../../src/ai/gateway/materialisers/edit-workout-plan.materialiser';
import { WorkoutBuilderAiService } from '../../src/ai/gateway/workout-builder/workout-builder-ai.service';
import type { WorkoutBuilderStatusService } from '../../src/ai/gateway/workout-builder/workout-builder-status.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { AuditService } from '../../src/audit/audit.service';
import { CardsService } from '../../src/broadcasts/cards.service';
import { PlanContextRepository } from '../../src/community/plan-context/plan-context.repository';
import { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import type { ExerciseLibraryService } from '../../src/exercise-library/exercise-library.service';
import { PackageContentsService } from '../../src/packages/package-contents.service';
import type { PackagesService } from '../../src/packages/packages.service';
import { PrismaService } from '../../src/prisma.service';
import type { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-client-more-routes: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("A moved client's copy day leaves four more routes", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  /** Only what each route reaches before its move check and its control answer. */
  const stub = <T>(part: Partial<T>) => part as T;
  const noTeam = stub<SubCoachScopeService>({ getHeadCoachIdForSubCoach: async () => null });
  const cards = new CardsService(prisma);
  const packages = stub<PackagesService>({ requireOwnedPackage: async () => stub<CoachPackage>({}) });
  const contents = new PackageContentsService(prisma, packages, noTeam, stub<AuditService>({}));
  const paused = stub<AiGatewayConfig>({ resolve: () => stub<ResolvedAiConfig>({ capabilityAllowed: false }) });
  const ai = new WorkoutBuilderAiService(
    prisma, stub<AiGatewayService>({}), paused, noTeam,
    stub<WorkoutBuilderStatusService>({}), stub<ExerciseLibraryService>({}),
  );
  const edit = new EditWorkoutPlanMaterializer(prisma, noTeam, stub<AnalyticsService>({}));
  const tags = new PlanContextService(new PlanContextRepository(prisma));
  // Fictional people, fresh ids per run. Coaches a and b; d: a's client who stays.
  const [a, b, d] = Array.from({ length: 3 }, () => randomUUID());
  const pkg: Record<string, string> = {};
  let stay = '';

  const person = (id: string, role: 'coach' | 'student', coach_id: string | null) =>
    prisma.user.create({
      data: { id, supabase_id: id, email: `movegaps-${id}`, name: 'Live person', role, coach_id },
    });
  /** Day 1 of `coach`'s program copy for `client`, with a head revision. */
  const copyDay = async (coach: string, client: string) => {
    const shape = { name: 'Block', weeks: 1, days_per_week: 1, is_template: false };
    const p = await prisma.workoutProgram.create({
      data: { ...shape, coach_id: coach, owner_user_id: coach, client_id: client },
    });
    const day = { coach_id: coach, name: 'Day 1', type: 'strength' as const, week_index: 0, day_index: 0 };
    const plan = await prisma.workoutPlan.create({ data: { ...day, program_id: p.id } });
    const rev = await prisma.workoutPlanRevision.create({
      data: {
        workout_plan_id: plan.id, revision_index: 0, exercises_json: [], plan_meta_json: {},
        author_id: coach, author_kind: 'coach', cause: 'create',
      },
    });
    await prisma.workoutPlan.update({ where: { id: plan.id }, data: { head_revision_id: rev.id } });
    return plan.id;
  };
  /** Every row these routes could write. */
  const rows = async () => [
    await prisma.coachPackageContent.count(),
    await prisma.aiActionDraft.count(),
    await prisma.workoutPlan.count(),
    await prisma.workoutPlanRevision.count(),
    await prisma.workoutPlanExercise.count(),
  ];
  /** The day as the signed-in API role (row security applies). */
  const seen = (coach: string, id: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, coach);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'coach', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: coach }));
      return tx.workoutPlan.count({ where: { id } });
    });
  /** 'ok', or the route's existing refusal code. */
  type Refusal = { code?: string; getResponse?: () => { code?: string; error?: string } };
  const outcome = (call: Promise<unknown>) =>
    call.then(
      () => 'ok',
      (e: Refusal) => e.getResponse?.()?.code ?? e.getResponse?.()?.error ?? e.code ?? String(e),
    );
  const draft = (coach: string, day: string) => stub<AiActionDraft>({
    id: randomUUID(), status: 'pending', materialised_at: null, materialised_ref: null,
    tenant_coach_id: coach, requester_id: coach,
    payload: {
      capability: EDIT_WORKOUT_PLAN_CAPABILITY, target_plan_id: day, base_revision_index: 0,
      diff: [{ kind: 'update_exercise', client_ref: 'a', sets: 5 }],
    },
  });

  // [route, call as `coach` on `day`, the control before the move, the refusal after it]
  const routes: Array<[string, (coach: string, day: string) => Promise<unknown>, string, string]> = [
    [
      'broadcast workout card',
      (co, day) =>
        cards.resolve({ actorId: co, tenantId: co, clientIds: [] }, { type: 'workout', ref_id: day }, 'group'),
      'ok',
      'card.ref_not_found',
    ],
    [
      'attach a plan to a package',
      (co, day) =>
        contents.attach(co, co, pkg[co], {
          asset_type: 'workout_plan', asset_id: day, cadence_kind: 'immediate', cadence_payload: {},
        }),
      'ok',
      'ASSET_NOT_FOUND',
    ],
    [
      'AI workout builder propose',
      (co, day) => ai.propose({ id: co, role: 'coach' }, { mode: 'edit', plan_id: day, instruction: 'Add a set' }),
      'AI_NOT_CONFIGURED', // read the day and its head, then the paused capability answers
      'plan_not_found',
    ],
    [
      'AI workout builder apply an edit',
      (co, day) => edit.materialize(draft(co, day)),
      'mwb_materialise_conflict', // past the scope gate; no stored draft to claim
      'AI_LIVE_CREATE_PLAN_NOT_FOUND',
    ],
    [
      'community plan tag resolve',
      (co, day) => tags.resolve({ id: co } as User, { type: 'workout', id: day }),
      'ok',
      'community.plan_context.not_found',
    ],
    [
      'community plan tag send',
      (co, day) => tags.validate({ id: co } as User, { type: 'workout', workout_plan_id: day }),
      'ok',
      'community.plan_context.invalid_reference',
    ],
  ];

  beforeAll(async () => {
    for (const coach of [a, b]) {
      await person(coach, 'coach', null);
      const data = { coach_id: coach, name: 'Block', amount_cents: 4900 };
      pkg[coach] = (await prisma.coachPackage.create({ data })).id;
    }
    await person(d, 'student', a);
    stay = await copyDay(a, d);
    process.env.FEATURE_MWB_AI_LIVE_CREATE = 'true';
  });
  afterAll(() => prisma.$disconnect());

  it.each(routes)('%s: after the move, the existing refusal and no write', async (_route, call, ok, refused) => {
    const c = randomUUID();
    await person(c, 'student', a);
    const [copy, copyB] = [await copyDay(a, c), await copyDay(b, c)];
    expect([await outcome(call(a, copy)), await seen(a, copy)]).toEqual([ok, 1]);

    await prisma.user.update({ where: { id: c }, data: { coach_id: b } });
    const day = () => prisma.workoutPlan.findUniqueOrThrow({ where: { id: copy } });
    const before = [await rows(), await day()];
    expect([await outcome(call(a, copy)), await seen(a, copy)]).toEqual([refused, 0]);
    expect([await rows(), await day()]).toEqual(before);

    // A's staying client and C's new coach: unchanged.
    expect([await outcome(call(a, stay)), await seen(a, stay)]).toEqual([ok, 1]);
    expect([await outcome(call(b, copyB)), await seen(b, copyB)]).toEqual([ok, 1]);
  });
});
