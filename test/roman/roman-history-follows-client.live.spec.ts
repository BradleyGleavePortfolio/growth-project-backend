/**
 * HIST3 live proof on real Postgres (owner 139-13 "history follows the
 * client", owner 4b): client X moved from coach A to coach B.
 *
 * - Roman's per-turn context and timeline read what X was given by the
 *   earlier coach (targets, workouts, daily meal plan, sessions, applied
 *   adjustments), exactly as X's own app shows them.
 * - Coach A's guideline, thread, message marker and session notes never
 *   reach X's Roman, and coach A's thread never reaches coach B's AI gateway
 *   context.
 * - Another client of coach A (Y) never appears in X's context, and X's
 *   earlier-coach rows never appear in Y's.
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped
 * with a logged reason elsewhere.
 */
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma.service';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { localDayStart } from '../../src/roman/context/roman-client-context.service';
import { RomanConsultationIntakeSource } from '../../src/roman/context/roman-consultation.source';
import { RomanTimelineReader } from '../../src/roman/memory/roman-timeline.reader';
import { PrivateContextService } from '../../src/ai/gateway/private-context.service';
import { bootstrapTestSchema } from '../utils/bootstrap-test-schema';
import { resetPublicSchema } from '../utils/reset-public-schema';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[roman-history-follows-client.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.',
  );
}

const A = 'hist3-coach-a';
const B = 'hist3-coach-b';
const X = 'hist3-client-x'; // moved A -> B
const Y = 'hist3-client-y'; // still with A
const W = 'hist3-client-w'; // moved A -> B, B has not written yet
const NOW = new Date('2026-10-08T19:00:00.000Z'); // 12:00 PT
const TZ = 'America/Los_Angeles';
const T = (iso: string) => new Date(iso);
const PRIVATE = ['HIST3-A-GUIDELINE', 'HIST3-A-THREAD', 'HIST3-A-NOTE', 'HIST3-ROMAN-TEXT'];

liveDescribe('HIST3 live: Roman context follows the client across coaches', () => {
  let prisma: PrismaService;
  let ctx: RomanClientContextService;
  let timeline: RomanTimelineReader;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    ctx = new RomanClientContextService(prisma, new RomanConsultationIntakeSource(prisma), grantAllEgress());
    timeline = new RomanTimelineReader(prisma, grantAllEgress());

    const user = (id: string, name: string, role: 'coach' | 'student', coach_id?: string) =>
      prisma.user.create({
        data: { id, supabase_id: `sb-${id}`, email: `${id}@example.test`, name, role, coach_id },
      });
    await user(A, 'Ari Chen', 'coach');
    await user(B, 'Bo Grant', 'coach');
    await user(X, 'Rae Lund', 'student', B);
    await user(Y, 'Sam Ortiz', 'student', A);
    await user(W, 'Kit Moss', 'student', B);

    // What coach A gave X before the move.
    const plan = (name: string) =>
      prisma.workoutPlan.create({ data: { coach_id: A, name, type: 'strength' } });
    const lower = await plan('Earlier Lower');
    const upper = await plan('Earlier Upper');
    const done = await prisma.clientWorkoutAssignment.create({
      data: {
        workout_plan_id: lower.id,
        client_id: X,
        assigned_by_coach_id: A,
        scheduled_for: T('2026-10-05T17:00:00Z'),
        completed_at: T('2026-10-05T18:00:00Z'),
        post_rpe: 7,
      },
    });
    ids.done = done.id;
    await prisma.clientWorkoutAssignment.create({
      data: {
        workout_plan_id: upper.id,
        client_id: X,
        assigned_by_coach_id: A,
        scheduled_for: T('2026-10-09T17:00:00Z'),
      },
    });
    await prisma.macroTarget.create({
      data: {
        client_id: X,
        coach_id: A,
        calories_kcal: 2300,
        protein_g: 170,
        carbs_g: 230,
        fats_g: 75,
        effective_from: T('2026-09-01T00:00:00Z'),
      },
    });
    const meals = await prisma.dailyMealPlan.create({ data: { coach_id: A, name: 'Earlier Meals' } });
    await prisma.dailyMealPlanAssignment.create({
      data: {
        daily_meal_plan_id: meals.id,
        client_id: X,
        assigned_by_coach_id: A,
        starts_on: T('2026-10-01T00:00:00Z'),
      },
    });
    const session = (title: string, status: 'scheduled' | 'completed', start: string, recap?: string) =>
      prisma.coachingSession.create({
        data: {
          coach_id: A,
          client_id: X,
          title,
          status,
          start_at: T(start),
          end_at: new Date(T(start).getTime() + 45 * 60_000),
          coach_notes_md: 'HIST3-A-NOTE',
          client_recap_md: recap ?? null,
        },
      });
    await session('Earlier check-in', 'scheduled', '2026-10-10T17:00:00Z');
    ids.review = (await session('Earlier review', 'completed', '2026-10-03T17:00:00Z', 'Earlier recap')).id;
    ids.adj = (
      await prisma.workoutAdjustmentProposal.create({
        data: {
          coach_id: A,
          client_id: X,
          assignment_id: done.id,
          rule_key: 'high_rpe',
          rule_version: 1,
          status: 'approved',
          severity: 'medium',
          signals: {},
          proposed_change: {},
          applied_change: { volume_pct: -10 },
          base_fingerprint: 'fp',
          roman_text: 'HIST3-ROMAN-TEXT',
          decided_at: T('2026-10-05T20:00:00Z'),
        },
      })
    ).id;

    // Coach A's own conversation with X and W (owner 4b: never follows).
    await prisma.coachGuideline.create({ data: { coach_id: A, client_id: X, content: 'HIST3-A-GUIDELINE' } });
    for (const client of [X, W]) {
      await prisma.coachMessage.create({
        data: { coach_id: A, client_id: client, sender_id: A, body: 'HIST3-A-THREAD', created_at: T('2026-10-04T16:00:00Z') },
      });
    }
    await prisma.activityEvent.create({
      data: { coach_id: A, client_id: X, actor_id: A, type: 'coach.message_sent', created_at: T('2026-10-04T16:00:01Z') },
    });

    // Coach B's conversation with X.
    await prisma.coachGuideline.create({ data: { coach_id: B, client_id: X, content: 'Walk after dinner' } });
    await prisma.coachMessage.create({
      data: { coach_id: B, client_id: X, sender_id: B, body: 'Welcome aboard', created_at: T('2026-10-07T16:00:00Z') },
    });

    // Y, coach A's other client.
    const yPlan = await plan('HIST3-Y plan');
    await prisma.clientWorkoutAssignment.create({
      data: { workout_plan_id: yPlan.id, client_id: Y, assigned_by_coach_id: A, scheduled_for: T('2026-10-09T17:00:00Z') },
    });
    await prisma.macroTarget.create({
      data: { client_id: Y, coach_id: A, calories_kcal: 1999, protein_g: 120, carbs_g: 200, fats_g: 60, notes: 'HIST3-Y', effective_from: T('2026-09-01T00:00:00Z') },
    });
    await prisma.coachMessage.create({
      data: { coach_id: A, client_id: Y, sender_id: A, body: 'HIST3-Y message', created_at: T('2026-10-06T16:00:00Z') },
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it("per-turn: X's Roman sees coach A's targets, workouts, meal plan and sessions; none of A's conversation or Y", async () => {
    const { context: c, rendered } = await ctx.buildFresh({ id: X, role: 'student' }, NOW);
    expect(c.targets).toMatchObject({ source: 'coach_set', calories: 2300, protein_g: 170 });
    expect(c.plan?.next_session?.name).toBe('Earlier Upper');
    expect(c.plan?.recent_completions.map((r) => r.name)).toEqual(['Earlier Lower']);
    expect(c.meal_plan?.title).toBe('Earlier Meals');
    expect(c.upcoming_sessions.map((s) => s.title)).toEqual(['Earlier check-in']);
    expect(c.data_quality.missing).not.toContain('plan');
    // The conversation is coach B's only.
    expect(c.coach).toMatchObject({ has_coach: true, coach_first_name: 'Bo', guidelines: 'Walk after dinner' });
    expect(c.coach.recent_messages.map((m) => m.excerpt)).toEqual(['Welcome aboard']);
    for (const s of [...PRIVATE, 'HIST3-Y', 'Sam']) expect(rendered).not.toContain(s);
  });

  it("timeline: X's earlier-coach workouts, sessions and adjustments are read; A's thread and marker are not", async () => {
    const page = await timeline.read(X, {
      from: localDayStart('2026-10-01', TZ),
      to: localDayStart('2026-10-09', TZ),
      now: NOW,
    });
    const by = (id: string) => page.events.find((e) => e.source.id === id);
    expect(by(ids.done)).toMatchObject({ kind: 'workout_done', facts: { plan_name: 'Earlier Lower', post_rpe: 7 } });
    expect(by(ids.review)).toMatchObject({ kind: 'booking', facts: { status: 'completed' }, text: 'Earlier recap' });
    expect(by(ids.adj)).toMatchObject({ kind: 'adjustment', facts: { status: 'approved', volume_pct: -10 } });
    const messages = page.events.filter((e) => e.kind === 'message');
    expect(messages.map((m) => m.text)).toEqual(['Welcome aboard']);
    expect(page.events.some((e) => e.kind === 'activity')).toBe(false);
    const json = JSON.stringify(page);
    for (const s of [...PRIVATE, 'HIST3-Y']) expect(json).not.toContain(s);
  });

  it("another client: Y's Roman never sees X's history, and sees its own", async () => {
    const { rendered } = await ctx.buildFresh({ id: Y, role: 'student' }, NOW);
    expect(rendered).toContain('HIST3-Y plan');
    for (const s of ['Earlier Upper', 'Earlier Lower', 'Earlier Meals', 'Earlier check-in', 'Rae', 'Welcome aboard']) {
      expect(rendered).not.toContain(s);
    }
  });

  it("AI gateway (owner 4b): coach B's context for a moved client never carries coach A's last message", async () => {
    const gateway = new PrivateContextService(prisma);
    const w = await gateway.loadClientContext({ id: B, role: 'coach' }, W);
    expect(w.systemPrompt).not.toContain('HIST3-A-THREAD');
    expect(w.systemPrompt).toMatch(/"last_coach_message_excerpt":\s*null/);
    expect(w.provenance.map((p) => p.source)).not.toContain('coach_messages');
    const x = await gateway.loadClientContext({ id: B, role: 'coach' }, X);
    expect(x.systemPrompt).toContain('Welcome aboard');
    expect(x.systemPrompt).not.toContain('HIST3-A-THREAD');
    await expect(gateway.loadClientContext({ id: A, role: 'coach' }, W)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('the newest effective target wins, whichever coach set it (= GET /me/macros/current)', async () => {
    await prisma.macroTarget.create({
      data: {
        client_id: X,
        coach_id: B,
        calories_kcal: 2100,
        protein_g: 160,
        carbs_g: 210,
        fats_g: 70,
        effective_from: T('2026-10-06T00:00:00Z'),
      },
    });
    const { context: c } = await ctx.buildFresh({ id: X, role: 'student' }, NOW);
    expect(c.targets).toMatchObject({ source: 'coach_set', calories: 2100 });
  });

  it("meal plan archive rule (#961): an earlier coach's archived plan stays; the current coach's archived plan is never read", async () => {
    // Coach A archives the plan X still has (as #961's frozen copy is): X keeps it.
    await prisma.dailyMealPlan.updateMany({
      where: { coach_id: A, name: 'Earlier Meals' },
      data: { archived_at: T('2026-10-07T00:00:00Z') },
    });
    const kept = await ctx.buildFresh({ id: X, role: 'student' }, NOW);
    expect(kept.context.meal_plan?.title).toBe('Earlier Meals');
    for (const s of [...PRIVATE, 'HIST3-Y']) expect(kept.rendered).not.toContain(s);

    // A newer assignment of coach B's own archived plan never hides the older
    // plan X still has.
    const retired = await prisma.dailyMealPlan.create({
      data: { coach_id: B, name: 'HIST3-B-RETIRED', archived_at: T('2026-10-07T00:00:00Z') },
    });
    for (const client of [X, W]) {
      await prisma.dailyMealPlanAssignment.create({
        data: {
          daily_meal_plan_id: retired.id,
          client_id: client,
          assigned_by_coach_id: B,
          starts_on: T('2026-10-06T00:00:00Z'),
        },
      });
    }
    const still = await ctx.buildFresh({ id: X, role: 'student' }, NOW);
    expect(still.context.meal_plan?.title).toBe('Earlier Meals');
    expect(still.rendered).not.toContain('HIST3-B-RETIRED');

    // Only the current coach's archived plan: no meal plan.
    const w = await ctx.buildFresh({ id: W, role: 'student' }, NOW);
    expect(w.context.meal_plan).toBeNull();
    expect(w.rendered).not.toContain('HIST3-B-RETIRED');

    // Another client never sees either plan.
    const y = await ctx.buildFresh({ id: Y, role: 'student' }, NOW);
    expect(y.context.meal_plan).toBeNull();
    for (const s of ['Earlier Meals', 'HIST3-B-RETIRED']) expect(y.rendered).not.toContain(s);
  });
});
