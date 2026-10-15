import { NotFoundException } from '@nestjs/common';
import type { AuthedRequest } from '../src/auth/auth-request';
import type { PrismaService } from '../src/prisma.service';
import type { AuditService } from '../src/audit/audit.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import { WearableSamplesService } from '../src/wearables/samples/wearable-samples.service';
import { WearableSamplesController } from '../src/wearables/samples/wearable-samples.controller';
import type { IngestionService } from '../src/wearables/ingestion/ingestion.service';
import { WearableInsightsService } from '../src/wearables/insights/wearable-insights.service';
import { WearableInsightsController } from '../src/wearables/insights/wearable-insights.controller';
import { InsightCacheService, INSIGHT_WINDOW_DAYS } from '../src/wearables/insights/insight-cache.service';
import { PROMPT_VERSION as COACH_HF_VERSION } from '../src/wearables/insights/prompts/coach-hf.prompt';
import type { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import type { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import type { AiEgressService } from '../src/ai-egress/ai-egress.service';
import { MacrosService } from '../src/macros/macros.service';
import { CoachMacrosController } from '../src/macros/macros.controller';
import type { CreateMacroTargetDto } from '../src/macros/macros.dto';
import { computeMacros, resolveMacroInputs } from '../src/macros/macro-calculator';
import { CoachAIService } from '../src/ai/coach/coach-ai.service';
import type { CoachAIStateService } from '../src/ai/coach/coach-ai-state.service';
import type { AnthropicAdapter } from '../src/ai/adapters/anthropic.adapter';
import { ClientContextService } from '../src/ai/context/client-context.service';
import type { MealPlansService } from '../src/meal-plans/meal-plans.service';
import type { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';

// WEIGHTWALL (SoT A2 items 12-15): a coach the client keeps Weigh-ins from never sees the client's
// weight, body fat or any number computed from them, from any source. One table walks every coach
// route this job closes (device samples, the coach device insight, the macro refusal, the coach AI
// drafts) with Weigh-ins on and off, for the current coach, a former coach whose old grants are
// still on, and a sub-coach. Every weight and every number made from one is a unique value; the
// device metric names count too. What the model was sent and what was stored count as seen.

function stub<T>(v: unknown): T {
  return v as T;
}
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const J = '6f1d2c3b-0a9e-4c7d-8b6a-5e4f3d2c1b0a';
const NOW_COACH = 'coach-now';
const FORMER = 'coach-before';
const SUB = 'sub-coach';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const yearsAgo = (n: number) => new Date(new Date().getUTCFullYear() - n, 0, 1);
const num = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
const FOUR = [
  ConsentScope.FITNESS_WORKOUTS,
  ConsentScope.FITNESS_FOOD_MACROS,
  ConsentScope.FITNESS_BODY_METRICS,
  ConsentScope.FITNESS_HABITS_PROGRESS,
];

// Device weight 83.7 kg and body fat 21.9 %; profile 184.4 / 166.6 lbs and its computed targets
// 2471.1 kcal, 173.3 g protein, 247.7 g carbs, 73.7 g fat; the maintenance number (below).
const PROFILE = {
  id: 'profile-j', user_id: J, sex: 'male', current_weight_lbs: 184.4, target_weight_lbs: 166.6, height_cm: 170,
  date_of_birth: yearsAgo(30), activity_level: 'active', goal_type: 'fat_loss', workout_experience: 'beginner',
  macro_target_calories: 2471.1, macro_target_protein_g: 173.3, macro_target_carbs_g: 247.7, macro_target_fat_g: 73.7,
  preferred_snacks: [], equipment_access: [], dietary_restrictions: [], injuries: [], meals_per_day: 3,
};
function maintenanceOf(profile: typeof PROFILE): number {
  const r = resolveMacroInputs(profile, new Date());
  if (!r.ok) throw new Error('fixture profile must resolve');
  const m = computeMacros({ ...r.inputs, screening_yes: true });
  return Math.max(m.floor_kcal, m.tdee);
}
const MAINTENANCE = maintenanceOf(PROFILE);
const WEIGHT = ['BODY_WEIGHT_KG', 'BODY_FAT_PCT', '83.7', '21.9', '184.4', '166.6', '2471.1', '173.3', '247.7', '73.7',
  MAINTENANCE.toLocaleString('en-US')];
const seen = (out: unknown) => WEIGHT.filter((w) => JSON.stringify(out).includes(w));

// Minimal Prisma where-matcher: AND, equality, null, date, in, notIn, not, gt/gte/lt/lte; a compound
// unique key matches on its parts.
function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key.endsWith('_key')) return matches(row, cond as Where);
    const v = row[key];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return num(v) === cond.getTime();
    if (typeof cond !== 'object') return v === cond;
    const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown };
    if (c.in && !c.in.includes(v)) return false;
    if (c.notIn && c.notIn.includes(v)) return false;
    if (c.not !== undefined && v === c.not) return false;
    if (c.gt !== undefined && !(num(v) > num(c.gt))) return false;
    if (c.gte !== undefined && !(num(v) >= num(c.gte))) return false;
    if (c.lt !== undefined && !(num(v) < num(c.lt))) return false;
    if (c.lte !== undefined && !(num(v) <= num(c.lte))) return false;
    return true;
  });
}

interface WorldOpts {
  weighIns: boolean;
  answers?: Row;
  screening?: boolean;
  ageYears?: number;
  coachTarget?: boolean;
  cachedInsight?: boolean;
}

function world(o: WorldOpts) {
  const grant = (coach_id: string, scope: string, on: boolean) => ({
    id: `${coach_id}:${scope}`, client_id: J, coach_id, scope, granted_at: ago(60), revoked_at: on ? null : ago(1),
  });
  const profile = { ...PROFILE, date_of_birth: yearsAgo(o.ageYears ?? 30) };
  const sample = (id: string, metric: string, value: number, unit: string) => ({
    id, user_id: J, metric, bucket: 'HEALTH_FITNESS', value, unit, provider: 'APPLE_HEALTHKIT',
    start_at: ago(1), end_at: new Date(ago(1).getTime() + 60_000), recorded_at: ago(1),
  });
  const t: Record<string, Row[]> = {
    user: [
      { id: J, name: 'Jordan Lee', role: 'student', coach_id: NOW_COACH, deleted_at: null, profile },
      ...[NOW_COACH, FORMER, SUB].map((id) => ({ id, name: `Coach ${id}`, role: 'coach', coach_id: null, deleted_at: null })),
    ],
    userProfile: [profile],
    clientCoachConsent: [
      ...FOUR.map((s) => grant(NOW_COACH, s, s !== ConsentScope.FITNESS_BODY_METRICS || o.weighIns)),
      ...FOUR.map((s) => grant(FORMER, s, true)),
    ],
    wearableSample: [
      sample('ws-weight', 'BODY_WEIGHT_KG', 83.7, 'kg'),
      sample('ws-fat', 'BODY_FAT_PCT', 21.9, '%'),
      sample('ws-steps', 'STEPS', 8421, 'count'),
    ],
    wearableMetricDef: [],
    wearableConnection: [],
    wearableInsightCache: o.cachedInsight
      ? [{
          id: 'cached-1', user_id: J, side: `coach:${NOW_COACH}`, bucket: 'HEALTH_FITNESS', window_days: INSIGHT_WINDOW_DAYS,
          payload: { observation: 'Scale weight is 83.7 kg.', hypothesis: 'h', suggested_action: 'a', suggested_message_draft: 'd',
            confidence_level: 'i_think', source_metrics: ['BODY_WEIGHT_KG'] },
          model_used: 'stub', prompt_version: COACH_HF_VERSION, generated_at: ago(0.1), expires_at: new Date(Date.now() + DAY),
        }]
      : [],
    clientOnboardingIntake: [{ client_id: J, screening_any_yes: o.screening ?? true, answers: o.answers ?? { P1: 'yes', P6: 'no' } }],
    macroTarget: o.coachTarget
      ? [{ id: 'target-coach', client_id: J, coach_id: NOW_COACH, calories_kcal: 2222, protein_g: 155, carbs_g: 230, fats_g: 70,
          fiber_g: 30, notes: null, effective_from: ago(3), archived_at: null }]
      : [],
    weightLog: [],
    loggedFoodEntry: [],
    checkIn: [],
    coachMessage: [],
    clientWorkoutAssignment: [],
    aIDraft: [],
  };
  const model = (name: string) => ({
    findMany: jest.fn(async (a: { where?: Where } = {}) => t[name].filter((r) => matches(r, a.where))),
    findFirst: jest.fn(async (a: { where?: Where } = {}) => t[name].find((r) => matches(r, a.where)) ?? null),
    findUnique: jest.fn(async (a: { where: Where }) => t[name].find((r) => matches(r, a.where)) ?? null),
    create: jest.fn(async (a: { data: Row }) => {
      const row = { id: `${name}-${t[name].length + 1}`, ...a.data };
      t[name].push(row);
      return row;
    }),
    upsert: jest.fn(async (a: { where: Where; create: Row; update: Row }) => {
      const hit = t[name].find((r) => matches(r, a.where));
      if (hit) return Object.assign(hit, a.update);
      t[name].push({ ...a.create });
      return a.create;
    }),
  });
  return { t, prisma: Object.fromEntries(Object.keys(t).map((name) => [name, model(name)])) };
}

async function routes(o: WorldOpts) {
  const { t, prisma } = world(o);
  const db = stub<PrismaService>(prisma);
  const consent = new ConsentService(db, stub<AuditService>({ write: jest.fn() }));
  const ingestion = stub<IngestionService>({
    resolveBest: async (userId: string, metric: string) =>
      t.wearableSample.filter((s) => s.user_id === userId && s.metric === metric),
  });
  const samples = new WearableSamplesService(db, ingestion, consent);
  // The provider doubles keep what they were sent: whatever the model saw can reach the coach.
  const gateway = { invoke: jest.fn(async () => ({ reply: 'no insight', model: 'stub', provider: 'stub' })) };
  const egress = stub<AiEgressService>({ assertMaySend: jest.fn(async () => undefined) });
  const insights = new WearableInsightsService(db, stub<AiGatewayService>(gateway), new InsightCacheService(db), egress, consent);
  const anthropic = {
    completeStructured: jest.fn(async () => ({ data: { days: [] }, modelUsed: 'stub', tokensIn: 1, tokensOut: 1 })),
  };
  // Same reach as WorkoutBuilderService.assertCanAccessClient: the head coach and an open sub-coach.
  const workouts = stub<WorkoutBuilderService>({
    assertCanAccessClient: async (id: string) => {
      if (id !== NOW_COACH && id !== SUB) throw new NotFoundException('Client not found');
    },
  });
  const ai = new CoachAIService(
    db, stub<CoachAIStateService>({ isReady: () => true }), stub<AnthropicAdapter>(anthropic),
    new ClientContextService(db), stub<MealPlansService>({}), workouts, undefined, undefined, consent,
  );
  return {
    t,
    samples: new WearableSamplesController(samples, ingestion, db),
    insights: new WearableInsightsController(insights, stub<AiApprovalService>({}), db),
    insightsSvc: insights,
    macros: new CoachMacrosController(new MacrosService(db, consent)),
    ai,
    sent: () => [gateway.invoke.mock.calls, anthropic.completeStructured.mock.calls, t.aIDraft],
  };
}

type Routes = Awaited<ReturnType<typeof routes>>;
type Read = (r: Routes, callerId: string) => Promise<unknown>;
const caller = (id: string, role = 'coach') => stub<AuthedRequest>({ user: { id, role, coach_id: null }, headers: {} });
const WINDOW = { from: ago(14).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
const kcal = (calories_kcal: number) => stub<CreateMacroTargetDto>({ calories_kcal, protein_g: 150, carbs_g: 150, fats_g: 50 });
const BELOW = kcal(1_600);
const run = async (read: Read, r: Routes, id: string) => ({
  out: await read(r, id).catch((e: Error) => ({ refused: e.message })),
  sent: r.sent(),
});

// The path list (PR body, "Path table"): every coach route this job closes.
const COACH_READS: Array<[string, Read]> = [
  ['GET /v1/wearables/samples?clientId (Health & Fitness series)', (r, id) =>
    r.samples.getSamples(caller(id), { bucket: 'HEALTH_FITNESS', clientId: J, ...WINDOW })],
  ['GET /v1/wearables/samples?clientId&metric=BODY_WEIGHT_KG', (r, id) =>
    r.samples.getSamples(caller(id), { bucket: 'HEALTH_FITNESS', metric: 'BODY_WEIGHT_KG', clientId: J, ...WINDOW })],
  ['GET /v1/wearables/samples?clientId&metric=BODY_FAT_PCT', (r, id) =>
    r.samples.getSamples(caller(id), { bucket: 'HEALTH_FITNESS', metric: 'BODY_FAT_PCT', clientId: J, ...WINDOW })],
  ['GET /v1/wearables/insights/coach (what the model is sent)', (r, id) =>
    r.insights.getCoachInsight(caller(id), { clientId: J, bucket: 'HEALTH_FITNESS' })],
  ['POST /coach/clients/:clientId/macros below maintenance (the refusal)', (r, id) => r.macros.create(caller(id), J, BELOW)],
  ['POST /coach/ai/meal-plan (prompt and stored draft)', (r, id) => r.ai.generateMealPlan(id, { clientId: J, days: 3 })],
  ['POST /coach/ai/client-insight (prompt and stored draft)', (r, id) => r.ai.generateClientInsight(id, { clientId: J, windowDays: 7 })],
];

describe.each(COACH_READS)('WEIGHTWALL %s', (_path, read) => {
  it('Weigh-ins on: the current coach gets the weight', async () => {
    expect(seen(await run(read, await routes({ weighIns: true }), NOW_COACH))).not.toEqual([]);
  });

  it('Weigh-ins off: the current coach gets no weight and no number made from it', async () => {
    expect(seen(await run(read, await routes({ weighIns: false }), NOW_COACH))).toEqual([]);
  });

  it('a former coach after the move: nothing, though their old grants are still on', async () => {
    expect(seen(await run(read, await routes({ weighIns: true }), FORMER))).toEqual([]);
  });

  it('a sub-coach: no weight, though the client shares Weigh-ins with the head coach', async () => {
    expect(seen(await run(read, await routes({ weighIns: true }), SUB))).toEqual([]);
  });
});

describe('WEIGHTWALL Weigh-ins off: the not-shared shape', () => {
  it('device series and the insight prompt keep every other metric', async () => {
    const r = await routes({ weighIns: false });
    const out = await r.samples.getSamples(caller(NOW_COACH), { bucket: 'HEALTH_FITNESS', clientId: J, ...WINDOW });
    expect(out.series.map((s) => s.metric)).toContain('STEPS');
    await r.insights.getCoachInsight(caller(NOW_COACH), { clientId: J, bucket: 'HEALTH_FITNESS' });
    expect(JSON.stringify(r.sent()[0])).toContain('STEPS');
  });

  it('an insight cached while Weigh-ins was on is not served after it goes off', async () => {
    const on = await routes({ weighIns: true, cachedInsight: true });
    expect(JSON.stringify(await on.insights.getCoachInsight(caller(NOW_COACH), { clientId: J, bucket: 'HEALTH_FITNESS' })))
      .toContain('83.7');
    const off = await routes({ weighIns: false, cachedInsight: true });
    const out = await off.insights.getCoachInsight(caller(NOW_COACH), { clientId: J, bucket: 'HEALTH_FITNESS' });
    expect(seen([out, off.sent()])).toEqual([]);
  });

  it('a coach-set target still reaches the coach AI (it is the coach\'s own number)', async () => {
    const r = await routes({ weighIns: false, coachTarget: true });
    await r.ai.generateMealPlan(NOW_COACH, { clientId: J, days: 3 });
    expect(r.t.aIDraft[0]).toMatchObject({ inputContext: { prescribed: { calories: 2222, protein_g: 155 } } });
    expect(JSON.stringify(r.sent()[1])).toContain('2222');
    expect(seen(r.sent())).toEqual([]);
  });
});

describe('WEIGHTWALL the macro refusal: exactly as safe, with the reason in place of the number', () => {
  const FLOOR = "This target is below this client's safe floor.";
  const REASONS: Array<[string, WorldOpts, string]> = [
    ['pregnancy yes', { weighIns: false, answers: { P6: 'yes' } },
      `${FLOOR} They answered yes to the pregnancy question in their consultation, so calories stay at maintenance.`],
    ['another readiness yes', { weighIns: false, answers: { P1: 'yes', P6: 'no' } },
      `${FLOOR} They answered yes to a readiness question in their consultation, so calories stay at maintenance.`],
    ['under 18', { weighIns: false, screening: false, answers: {}, ageYears: 16 },
      `${FLOOR} They are under 18, so calories can't go below maintenance.`],
  ];

  it.each(REASONS)('Weigh-ins off, %s: the reason and no number', async (_why, o, message) => {
    const r = await routes(o);
    await expect(r.macros.create(caller(NOW_COACH), J, BELOW)).rejects.toThrow(message);
  });

  it('Weigh-ins on: today\'s message, number included', async () => {
    const r = await routes({ weighIns: true });
    await expect(r.macros.create(caller(NOW_COACH), J, BELOW)).rejects.toThrow(
      `Calorie targets can't go below ${MAINTENANCE.toLocaleString('en-US')} for this client. Their readiness answers or age rule out a deficit.`,
    );
  });

  it.each([true, false])('Weigh-ins %s: the same line, one below maintenance refused, maintenance saved', async (weighIns) => {
    const r = await routes({ weighIns });
    await expect(r.macros.create(caller(NOW_COACH), J, kcal(MAINTENANCE - 1))).rejects.toThrow();
    await expect(r.macros.create(caller(NOW_COACH), J, kcal(MAINTENANCE))).resolves.toMatchObject({ calories_kcal: MAINTENANCE });
  });
});

const OWN_READS: Array<[string, (r: Routes) => Promise<unknown>]> = [
  ['GET /v1/wearables/samples (own series)', (r) =>
    r.samples.getSamples(caller(J, 'student'), { bucket: 'HEALTH_FITNESS', ...WINDOW })],
  ['GET /v1/wearables/insights/client (what the model is sent)', async (r) => {
    await r.insightsSvc.generateForClient(J, 'HEALTH_FITNESS');
    return r.sent()[0];
  }],
];

it.each(OWN_READS)('WEIGHTWALL the client always sees their own device weight, Weigh-ins off: %s', async (_path, read) => {
  expect(seen(await read(await routes({ weighIns: false })))).not.toEqual([]);
});
