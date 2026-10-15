/**
 * MEALPLAN-RETIRE (owner #K5-PLANS, 10-15): the readers that left the retired
 * free-form MealPlan for today's day plans (MEAL:DAY) keep the move rule. One
 * row per moved path, each with a fresh client X of coach A who moves to B:
 * current coach 1, former coach 0, other coach 0, each 0 after a control 1.
 * The move freezes X's plan into an archived copy A still owns, as
 * freezeForMovedClients does (#961). Real services on the superuser
 * connection (service_role, as the API runs), so the service rule decides;
 * each row also reads the same plan as the signed-in API role (non-bypass).
 * The client's AI context names only today's plan from the current coach.
 * MEALTAG (LO1033): a free-form plan A wrote about X no longer resolves as a
 * community meal tag, so the former coach's tag read of it is gone.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { User } from '@prisma/client';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import type { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { CardsService } from '../../src/broadcasts/cards.service';
import { PlanContextRepository } from '../../src/community/plan-context/plan-context.repository';
import { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import { PrismaService } from '../../src/prisma.service';
import type { PlaybookSignalsService } from '../../src/roman/playbook/playbook-signals.service';
import { PlaybookSourceCollector } from '../../src/roman/playbook/playbook-sources';
import type { PlaybookSignals } from '../../src/roman/playbook/playbook-signals.types';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('meal-plan-retire-routes: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('Meal plan readers on MEAL:DAY keep the move rule', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  const cards = new CardsService(prisma);
  const tags = new PlanContextService(new PlanContextRepository(prisma));
  const playbook = new PlaybookSourceCollector(
    prisma,
    stub<CoachAIBudgetService>({ resolveHeadCoachId: async (id: string) => id }),
    stub<AiEgressService>({ consentedClients: async () => new Set<string>() }),
    stub<PlaybookSignalsService>({ compute: async () => stub<PlaybookSignals>({}) }),
  );
  const context = new ClientAIContextService(prisma);
  // Fictional people, fresh ids per run. a: former coach, b: current, c: another coach.
  const [a, b, c] = Array.from({ length: 3 }, () => randomUUID());

  const person = (id: string, role: 'coach' | 'student', coach_id: string | null) =>
    prisma.user.create({
      data: { id, supabase_id: id, email: `mealretire-${id}`, name: 'Live person', role, coach_id },
    });
  const plan = async (coach_id: string, name: string, archived = false) =>
    (await prisma.dailyMealPlan.create({ data: { coach_id, name, archived_at: archived ? new Date() : null } })).id;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const assign = (daily_meal_plan_id: string, client_id: string, coach: string, ago: number) =>
    prisma.dailyMealPlanAssignment.create({
      data: { daily_meal_plan_id, client_id, assigned_by_coach_id: coach, starts_on: daysAgo(ago) },
    });
  /** The plan as the signed-in API role (row security applies). */
  const seen = (coach: string, id: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, coach);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'coach', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: coach }));
      return tx.dailyMealPlan.count({ where: { id } });
    });
  type Refusal = { code?: string; getResponse?: () => { code?: string; error?: string } };
  const outcome = (call: Promise<unknown>) =>
    call.then(
      () => 'ok',
      (e: Refusal) => e.getResponse?.()?.code ?? e.getResponse?.()?.error ?? e.code ?? String(e),
    );
  const coach = (id: string) => ({ id }) as User;
  const NOT_FOUND = 'community.plan_context.not_found';

  // [path, call as `co` on plan `id`, refusal for the former coach, refusal for another coach]
  const paths: Array<[string, (co: string, id: string) => Promise<unknown>, string, string]> = [
    [
      'broadcast meal plan card',
      (co, id) => cards.resolve({ actorId: co, tenantId: co, clientIds: [] }, { type: 'meal_plan', ref_id: id }),
      'card.ref_not_found',
      'card.ref_not_found',
    ],
    ['community meal tag resolve', (co, id) => tags.resolve(coach(co), { type: 'meal', id }), NOT_FOUND, NOT_FOUND],
    [
      'community meal tag send',
      (co, id) => tags.validate(coach(co), { type: 'meal', meal_plan_id: id }),
      'community.plan_context.invalid_reference',
      'community.plan_context.foreign_owner',
    ],
    [
      'Roman playbook sources',
      (co, id) =>
        playbook.collect(co).then((out) => {
          if (!out.items.some((i) => i.kind === 'meal_plan' && i.id === id)) {
            throw Object.assign(new Error('not read'), { code: 'not_read' });
          }
        }),
      'not_read',
      'not_read',
    ],
  ];

  beforeAll(async () => {
    for (const id of [a, b, c]) await person(id, 'coach', null);
  });
  afterAll(() => prisma.$disconnect());

  it.each(paths)('%s: current coach 1, former coach 0, other coach 0', async (_path, call, former, other) => {
    const x = randomUUID();
    await person(x, 'student', a);
    const held = await plan(a, 'Lean day');
    await assign(held, x, a, 5);
    expect([await outcome(call(a, held)), await seen(a, held)]).toEqual(['ok', 1]);

    // X moves to B; A's plan for X is frozen into an archived copy A still owns.
    await prisma.user.update({ where: { id: x }, data: { coach_id: b } });
    const frozen = await plan(a, 'Lean day', true);
    await prisma.dailyMealPlanAssignment.updateMany({ where: { client_id: x }, data: { daily_meal_plan_id: frozen } });
    const current = await plan(b, 'Build day');
    await assign(current, x, b, 1);

    expect([await outcome(call(b, current)), await seen(b, current)]).toEqual(['ok', 1]);
    expect([await outcome(call(a, held)), await seen(a, held)]).toEqual(['ok', 1]); // A's live library: control
    expect([await outcome(call(a, frozen)), await seen(a, frozen)]).toEqual([former, 0]);
    const own = await plan(c, 'Other day');
    expect([await outcome(call(c, own)), await seen(c, own)]).toEqual(['ok', 1]); // control
    expect([await outcome(call(c, current)), await seen(c, current)]).toEqual([other, 0]);
  });

  it("the client's AI context names today's plan from the current coach only", async () => {
    const x = randomUUID();
    await person(x, 'student', a);
    const title = async () => (await context.buildFresh(x)).current_meal_plan?.title ?? null;
    const held = await plan(a, 'Lean day');
    await assign(held, x, a, 5);
    expect(await title()).toBe('Lean day'); // control: A's client, A's plan

    await prisma.user.update({ where: { id: x }, data: { coach_id: b } });
    const frozen = await plan(a, 'Lean day', true);
    await prisma.dailyMealPlanAssignment.updateMany({
      where: { client_id: x },
      data: { daily_meal_plan_id: frozen, starts_on: daysAgo(1) },
    });
    await assign(await plan(c, 'Other day'), x, c, 1);
    expect(await title()).toBeNull(); // former coach 0, other coach 0

    await assign(await plan(b, 'Build day'), x, b, 3);
    expect(await title()).toBe('Build day'); // current coach 1, under newer plans of A and C
  });

  it('MEALTAG: a free-form plan the former coach wrote no longer resolves as a meal tag', async () => {
    const x = randomUUID();
    await person(x, 'student', a);
    const legacy = await prisma.mealPlan.create({
      data: { coach_id: a, client_id: x, title: 'Free-form week', items: [] },
    });
    const live = await plan(a, 'Lean day');
    await prisma.user.update({ where: { id: x }, data: { coach_id: b } });

    expect(await outcome(tags.resolve(coach(a), { type: 'meal', id: live }))).toBe('ok'); // control
    expect(await outcome(tags.resolve(coach(a), { type: 'meal', id: legacy.id }))).toBe(NOT_FOUND);
    expect(await outcome(tags.validate(coach(a), { type: 'meal', meal_plan_id: legacy.id }))).toBe(
      'community.plan_context.invalid_reference',
    );
    expect(await outcome(tags.resolve(coach(b), { type: 'meal', id: legacy.id }))).toBe(NOT_FOUND);
  });
});
