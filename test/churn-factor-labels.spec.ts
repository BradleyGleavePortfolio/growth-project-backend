import { AnthropicHandle, type AnthropicMessagesClient } from '../src/ai-egress/ai-egress.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';

// CHURN-LABELS-132: the churn-risk factor labels a coach sees follow the client's sharing. The at-risk
// lists and the churn draft already need the four Coach sharing switches (Workouts, Food logs, Weigh-ins,
// Check-ins and habits), so the fitness labels are shared. The finance labels come from the finance app,
// which none of the four covers (the engine writes "5+ finance EOD misses" for every client with no
// finance app): a coach sees them only with finance.summary, which no app screen grants. A factor key
// with no known source is never shown. Every case uses an unchanged service signature, so this file
// compiles on main and fails there on behaviour.

const COACH = 'coach-1';
const NOW = Date.now();
const DAY = 86_400_000;
const FOUR = [
  ConsentScope.FITNESS_WORKOUTS,
  ConsentScope.FITNESS_FOOD_MACROS,
  ConsentScope.FITNESS_BODY_METRICS,
  ConsentScope.FITNESS_HABITS_PROGRESS,
];
// 'fit' shares the four switches; 'fin' also shares finance.summary.
const GRANTS: Record<string, string[]> = { fit: FOUR, fin: [...FOUR, ConsentScope.FINANCE_SUMMARY] };
const CLIENTS = Object.keys(GRANTS);

// Labels exactly as src/ptm/ptm-heuristic.service.ts writes them.
const FINANCE_EOD = { key: 'finance_eod_skip_5plus', label: '5+ finance EOD misses in last 7 days', contribution: 0.12 };
const FINANCE_WIN = { key: 'finance_milestone_recent', label: 'Finance milestone hit in last 14 days', contribution: -0.12 };
const WEIGHT = { key: 'weight_skip_14d', label: 'No weight logged in last 14 days', contribution: 0.15 };
const WORKOUT = { key: 'workout_skip_10d', label: 'No workout logged in last 10 days', contribution: 0.1 };
const MEAL = { key: 'meal_skip_7d', label: 'No meal logged in last 7 days', contribution: 0.08 };
const APP = { key: 'app_open_gap_7d', label: 'No app open in last 7 days', contribution: 0.25 };
const UNKNOWN = { key: 'model_v3_signal', label: 'Label from a factor with no known source', contribution: 0.3 };
type Factor = typeof WEIGHT;

function consent(): ConsentService {
  const row = (client_id: string, scope: string) => ({ client_id, coach_id: COACH, scope, granted_at: new Date(NOW - 30 * DAY), revoked_at: null });
  const has = (coach: string, client: string, scope: string) => coach === COACH && (GRANTS[client] ?? []).includes(scope);
  type ManyArgs = { where: { coach_id: string; client_id: { in: string[] }; scope: { in: string[] } } };
  type OneArgs = { where: { ClientCoachConsent_client_coach_scope_key: { client_id: string; coach_id: string; scope: string } } };
  const findMany = async ({ where }: ManyArgs) =>
    where.client_id.in.flatMap((id) => where.scope.in.filter((s) => has(where.coach_id, id, s)).map((s) => row(id, s)));
  const findUnique = async ({ where: { ClientCoachConsent_client_coach_scope_key: k } }: OneArgs) =>
    has(k.coach_id, k.client_id, k.scope) ? row(k.client_id, k.scope) : null;
  return new ConsentService(fakeOf({ clientCoachConsent: { findMany, findUnique } }), fakeOf({}));
}

// One prediction per client, every client with the same factors.
function prismaWith(factors: Factor[]) {
  const preds = CLIENTS.map((user_id) => ({ user_id, computed_at: new Date(NOW - DAY), risk_score: 0.7, factors }));
  type Rows = { where: { user_id?: { in: string[] }; OR?: Array<{ user_id: string }> } };
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    user: {
      findMany: async () => CLIENTS.map((id) => ({ id, name: `Client ${id}` })),
      findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: `Client ${where.id}` }),
      findUnique: async () => ({ name: 'Coach One', role: 'coach', coach_profile: null }),
    },
    ptmPrediction: {
      groupBy: async ({ where }: Rows) =>
        preds.filter((p) => where.user_id?.in.includes(p.user_id)).map((p) => ({ user_id: p.user_id, _max: { computed_at: p.computed_at } })),
      findMany: async ({ where }: Rows) =>
        preds
          .filter((p) => where.OR?.some((o) => o.user_id === p.user_id))
          .map((p) => ({ ...p, user: { id: p.user_id, name: p.user_id, ptm_signals: [] } })),
    },
    coachAlert: { findMany: async () => [] },
    checkIn: { findFirst: async () => null },
    churnIntervention: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `i-${created.length}`, created_at: new Date(NOW), ...data };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id, created_at: new Date(NOW), ...created[Number(where.id.slice(2)) - 1], ...data,
      }),
    },
  };
}

function churnService(factors: Factor[]) {
  const prisma = prismaWith(factors);
  const create = jest.fn(async (_body: { system: string }) => ({ content: [{ type: 'text', text: 'Checking in this week. Coach One' }] }));
  const ptm = { getLatestPrediction: async () => ({ risk_score: 0.7, factors }) };
  const svc = new ChurnInterventionService(
    fakeOf(prisma), fakeOf(ptm), fakeOf({ get: () => undefined }), grantAllEgress(), undefined,
    AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>({ messages: { create } })), consent(),
  );
  return { svc, create, prisma };
}

describe('CHURN-LABELS-132: churn-at-risk risk signals', () => {
  const factors = [FINANCE_EOD, FINANCE_WIN, WEIGHT, WORKOUT, MEAL, UNKNOWN];

  it('a client sharing the four switches but not finance: no finance label and no label with an unknown source', async () => {
    const { svc } = churnService(factors);
    const out = await svc.getChurnAtRisk(COACH, { callerRole: 'coach' });
    const fit = out.items.find((i) => i.user_id === 'fit');
    expect(fit?.risk_signals.map((s) => s.label)).toEqual([WEIGHT.label, WORKOUT.label, MEAL.label]);
    expect(fit?.top_factor).toBe(WEIGHT.label);
  });

  it('finance labels show while the client shares finance.summary, and to the owner account', async () => {
    const { svc } = churnService(factors);
    const fin = (await svc.getChurnAtRisk(COACH, { callerRole: 'coach' })).items.find((i) => i.user_id === 'fin');
    expect(fin?.risk_signals.map((s) => s.label)).toEqual([WEIGHT.label, FINANCE_EOD.label, WORKOUT.label]);
    const owner = await svc.getChurnAtRisk(COACH, { callerRole: 'owner' });
    expect(owner.items.map((i) => i.risk_signals[1]?.label)).toEqual([FINANCE_EOD.label, FINANCE_EOD.label]);
  });

  it('app opens are not one of the four logs: that label stays', async () => {
    const { svc } = churnService([APP, FINANCE_EOD, WEIGHT]);
    const fit = (await svc.getChurnAtRisk(COACH, { callerRole: 'coach' })).items.find((i) => i.user_id === 'fit');
    expect(fit?.risk_signals.map((s) => s.label)).toEqual([APP.label, WEIGHT.label]);
  });
});

describe('CHURN-LABELS-132: churn draft', () => {
  const KEY = '0f3b6f1e-6a51-4a59-9a3e-2b8f0c7d4e21';

  it('the AI prompt and the stored top factor leave out the finance label when finance is not shared', async () => {
    const { svc, create, prisma } = churnService([FINANCE_EOD, WORKOUT]);
    const out = await svc.generateChurnDraft(COACH, 'fit', { idempotency_key: KEY }, 'coach');
    const system = create.mock.calls[0][0].system;
    expect(system).toContain(WORKOUT.label);
    expect(system).not.toMatch(/finance/i);
    expect(prisma.created[0].top_factor).toBe(WORKOUT.label);
    expect(out.top_factor).toBe(WORKOUT.label);
  });

  it('a client sharing finance.summary: the finance label goes in', async () => {
    const { svc, create } = churnService([FINANCE_EOD, WORKOUT]);
    const out = await svc.generateChurnDraft(COACH, 'fin', { idempotency_key: KEY }, 'coach');
    expect(create.mock.calls[0][0].system).toContain(FINANCE_EOD.label);
    expect(out.top_factor).toBe(FINANCE_EOD.label);
  });
});

describe('CHURN-LABELS-132: Command Center at-risk top factor (coach app At risk list)', () => {
  it('a client sharing the four switches but not finance: the top shared factor, not the finance one', async () => {
    const board = {
      getRiskBoardForCoach: async (_coachId: string, opts: { clientIds?: string[] }) => ({
        data: (opts.clientIds ?? []).map((user_id) => ({ user_id, name: user_id, bucket: 'amber', last_signal_at: null })),
        next_cursor: null,
        generated_at: new Date(NOW).toISOString(),
      }),
    };
    const svc = new CommandCenterService(fakeOf(prismaWith([FINANCE_EOD, MEAL])), fakeOf(board), fakeOf({}), undefined, consent());
    const out = await svc.getAtRisk(COACH, {});
    expect(Object.fromEntries(out.items.map((i) => [i.user_id, i.top_factor]))).toEqual({ fit: MEAL.label, fin: FINANCE_EOD.label });
  });
});
