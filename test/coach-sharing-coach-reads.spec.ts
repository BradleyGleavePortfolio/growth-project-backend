import { Test } from '@nestjs/testing';
import type { AuthedRequest } from '../src/auth/auth-request';
import { PrismaService } from '../src/prisma.service';
import { PtmService } from '../src/ptm/ptm.service';
import { AuditService } from '../src/audit/audit.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import { CheckInsService } from '../src/check-ins/check-ins.service';
import { CoachCheckInsController } from '../src/check-ins/coach-check-ins.controller';
import type { ListCheckInsQueryDto } from '../src/check-ins/check-ins.dto';
import { CoachService } from '../src/coach/coach.service';
import { CoachController } from '../src/coach/coach.controller';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import type { RiskBoardQueryDto } from '../src/admin/ptm/admin-ptm.dto';
import { CoachAlertsService } from '../src/coach/coach-alerts.service';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../src/supabase/supabase.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { V1CoachController } from '../src/v1/v1-coach.controller';
import { AiEgressService } from '../src/ai-egress/ai-egress.service';
import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import { CommandCenterController } from '../src/coach/command-center/command-center.controller';

// CF-SHARE-GATE-128 (FW-COACH-128 U2): a client turns a switch off in Settings >
// Privacy > Coach sharing (Workouts, Food logs, Weigh-ins, Check-ins and
// habits) and their coach must stop seeing that kind of log, and anything
// built from it, on every coach read. The owner account keeps its bypass.
// Every case goes through a controller or an unchanged service signature, so
// this file compiles on main and fails there on behaviour.

function stub<T>(v: unknown): T {
  return v as T;
}
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type GroupArgs = { by: string[]; where?: Where; _max?: Record<string, true>; _min?: Record<string, true> };

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);
const num = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : NaN);

// Minimal Prisma where-matcher: equality, null, in, notIn, gte, lte, lt, OR.
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const v = row[key];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return num(v) === cond.getTime();
    if (typeof cond !== 'object') return v === cond;
    const c = cond as { in?: unknown[]; notIn?: unknown[]; gte?: unknown; lte?: unknown; lt?: unknown };
    if (c.in && !c.in.includes(v)) return false;
    if (c.notIn && c.notIn.includes(v)) return false;
    if (c.gte !== undefined && !(num(v) >= num(c.gte))) return false;
    if (c.lte !== undefined && !(num(v) <= num(c.lte))) return false;
    if (c.lt !== undefined && !(num(v) < num(c.lt))) return false;
    return true;
  });
}

function group(rows: Row[], a: GroupArgs) {
  const key = a.by[0];
  const groups = new Map<unknown, Row[]>();
  for (const r of rows.filter((x) => matches(x, a.where ?? {}))) groups.set(r[key], [...(groups.get(r[key]) ?? []), r]);
  const pick = (rs: Row[], fields: Record<string, true> | undefined, better: (x: number, y: number) => boolean) =>
    Object.fromEntries(
      Object.keys(fields ?? {}).map((f) => [f, rs.map((r) => r[f]).reduce((x, y) => (better(num(y), num(x)) ? y : x))]),
    );
  return [...groups].map(([k, rs]) => ({
    [key]: k,
    _count: { _all: rs.length },
    _max: pick(rs, a._max, (x, y) => x > y),
    _min: pick(rs, a._min, (x, y) => x < y),
  }));
}

const COACH = 'coach-A';
const FOUR = [
  ConsentScope.FITNESS_WORKOUTS,
  ConsentScope.FITNESS_FOOD_MACROS,
  ConsentScope.FITNESS_BODY_METRICS,
  ConsentScope.FITNESS_HABITS_PROGRESS,
];
const FOOD_TOTALS = [
  { user_id: 'c1', total_kcal: 500, total_protein_g: 30, total_carbs_g: 50, total_fat_g: 10 },
  { user_id: 'c2', total_kcal: 700, total_protein_g: 40, total_carbs_g: 60, total_fat_g: 20 },
  { user_id: 'c3', total_kcal: 300, total_protein_g: 20, total_carbs_g: 30, total_fat_g: 5 },
];

// c1 shares all four; c2 shared all four and turned every one off; c3 shares
// only "Check-ins and habits". Every client has the same logs.
function makePrisma() {
  const ids = ['c1', 'c2', 'c3'];
  const grant = (client_id: string, scope: string, revoked: boolean) => ({
    client_id,
    coach_id: COACH,
    scope,
    granted_at: ago(30 * DAY),
    revoked_at: revoked ? ago(DAY) : null,
  });
  const alert = (id: string, client_id: string, alert_type: string, n: number) => ({
    id, coach_id: COACH, client_id, alert_type, message: alert_type, created_at: ago(n * 60_000), acknowledged_at: null,
  });
  const t: Record<string, Row[]> = {
    user: ids.map((id) => ({ id, name: `Client ${id}`, role: 'student', coach_id: COACH, deleted_at: null })),
    clientCoachConsent: [
      ...FOUR.map((s) => grant('c1', s, false)),
      ...FOUR.map((s) => grant('c2', s, true)),
      grant('c3', ConsentScope.FITNESS_HABITS_PROGRESS, false),
    ],
    checkIn: ids.map((id) => ({
      id: `ci-${id}`, user_id: id, coach_id: COACH, date: ago(DAY), logged_at: ago(3_600_000),
      mood: 2, energy: 3, sleep_hours: 6, notes: 'private note', reviewed_by_coach: false,
    })),
    // Sorted user asc, date desc (the order getAlerts / getDashboardSummary ask for): rising weight.
    weightLog: ids.flatMap((id) => [182, 181, 180].map((w, i) => ({ user_id: id, date: ago((i + 1) * DAY), weight_lbs: w }))),
    workoutSession: [],
    loggedFoodEntry: ids.map((id) => ({ user_id: id, logged_at: new Date(NOW) })),
    message: [],
    coachMessage: [],
    ptmPrediction: ids.map((id) => ({
      user_id: id, computed_at: ago(DAY), risk_score: 0.8,
      factors: [{ key: 'weight', label: 'No weight logged in last 14 days', contribution: 1 }],
    })),
    clientSignal: [
      ...['c2', 'c3'].map((id) => ({ user_id: id, signal_type: 'checkin_streak', value: 5, recorded_at: ago(DAY) })),
      ...ids.flatMap((id) => [1, 2, 3].map((d) => ({ user_id: id, signal_type: 'workout_logged', value: 1, recorded_at: ago(d * DAY) }))),
    ],
    coachAlert: [
      alert('a1', 'c1', 'consecutive_misses', 1),
      alert('a2', 'c2', 'consecutive_misses', 2),
      alert('a3', 'c2', 'risk_red_transition', 3),
      alert('a4', 'c2', 'finance_eod_gap', 4),
      alert('a5', 'c3', 'consecutive_misses', 5),
      alert('a6', 'c3', 'risk_red_transition', 6),
    ],
  };
  const model = (name: string) => ({
    findMany: jest.fn(async (a: { where?: Where } = {}) => t[name].filter((r) => matches(r, a.where ?? {}))),
    findFirst: jest.fn(async (a: { where?: Where }) => t[name].find((r) => matches(r, a.where ?? {})) ?? null),
    count: jest.fn(async (a: { where?: Where }) => t[name].filter((r) => matches(r, a.where ?? {})).length),
    groupBy: jest.fn(async (a: GroupArgs) => group(t[name], a)),
  });
  const prisma = Object.fromEntries(Object.keys(t).map((name) => [name, model(name)]));
  return {
    ...prisma,
    // Named so tests can assert on it: next to named keys, the spread's index type is dropped.
    checkIn: prisma.checkIn,
    clientCoachConsent: {
      ...prisma.clientCoachConsent,
      findUnique: jest.fn(async (a: { where: { ClientCoachConsent_client_coach_scope_key: Row } }) => {
        const k = a.where.ClientCoachConsent_client_coach_scope_key;
        return (
          t.clientCoachConsent.find((r) => r.client_id === k.client_id && r.coach_id === k.coach_id && r.scope === k.scope) ??
          null
        );
      }),
    },
    $queryRaw: jest.fn(async (_sql: TemplateStringsArray, clientIds: string[]) =>
      FOOD_TOTALS.filter((r) => clientIds.includes(r.user_id)),
    ),
  };
}

function setup() {
  const prisma = makePrisma();
  const consent = new ConsentService(stub<PrismaService>(prisma), stub<AuditService>({ write: jest.fn() }));
  const board = jest.fn(async (_coachId: string, opts: { clientIds?: string[] }) => ({
    data: (opts.clientIds ?? []).map((user_id) => ({ user_id, name: user_id, bucket: 'red', last_signal_at: null })),
    next_cursor: null,
    generated_at: new Date(NOW).toISOString(),
  }));
  const providers = [
    { provide: PrismaService, useValue: prisma },
    { provide: ConsentService, useValue: consent },
    { provide: PtmService, useValue: {} },
    { provide: AdminPtmService, useValue: { getRiskBoardForCoach: board } },
    { provide: CoachAlertsService, useValue: {} },
  ];
  return { prisma, consent, board, providers };
}

const req = (role: string) => stub<AuthedRequest>({ user: { id: COACH, role, email: 'coach@example.test' } });

describe('CF-SHARE-GATE-128: GET /coach/clients/:id/check-ins follows "Check-ins and habits"', () => {
  it('not shared: empty list; shared: the rows; owner account: the rows', async () => {
    const { prisma, providers } = setup();
    const mod = await Test.createTestingModule({ providers: [CheckInsService, ...providers] }).compile();
    const ctrl = new CoachCheckInsController(mod.get(CheckInsService));
    const query = stub<ListCheckInsQueryDto>({});

    expect(await ctrl.list(req('coach'), 'c2', query)).toEqual([]);
    expect(prisma.checkIn.findMany).not.toHaveBeenCalled();
    expect((await ctrl.list(req('coach'), 'c3', query)).map((r) => r.id)).toEqual(['ci-c3']);
    expect((await ctrl.list(req('owner'), 'c2', query)).map((r) => r.id)).toEqual(['ci-c2']);
  });
});

describe('CF-SHARE-GATE-128: roster dashboards count only what each client shares', () => {
  const service = (s: ReturnType<typeof setup>) =>
    new CoachService(stub<PrismaService>(s.prisma), stub<AuditService>({ write: jest.fn() }), s.consent);

  it('GET /coach/dashboard: food totals only for clients sharing Food logs', async () => {
    const s = setup();
    expect(await service(s).getDashboard(COACH, 'coach')).toEqual({ logs_today: 1, total_kcal: 500, logging_rate: 1 });
  });

  it('GET /coach/alerts: weight alert needs Weigh-ins, missed-workout alert needs Workouts', async () => {
    const alerts = await service(setup()).getAlerts(COACH, 'coach');
    expect(alerts.map((a) => `${a.type}:${a.client_id}`).sort()).toEqual(['missed_workouts:c1', 'weight_increasing:c1']);
  });

  it('GET /coach/dashboard/summary: each count and flag follows its switch; the owner account sees all', async () => {
    const coach = await service(setup()).getDashboardSummary(COACH, 'coach');
    expect(coach.stats).toEqual({ total_clients: 3, active_today: 1, unread_messages: 0, pending_checkins: 2 });
    expect(coach.attention_needed.map((a) => `${a.reason}:${a.client_id}`)).toEqual(['weight_flag:c1', 'no_checkin:c3']);

    const owner = await service(setup()).getDashboardSummary(COACH, 'owner');
    expect(owner.attention_needed.map((a) => a.client_id)).toEqual(['c1', 'c2', 'c3']);
    expect(owner.stats.pending_checkins).toBe(3);
  });

  it('GET /coach/clients/risk-board: only clients sharing all four; the owner account sees all', async () => {
    const s = setup();
    const ctrl = new CoachController(
      service(s),
      stub<ConstructorParameters<typeof CoachController>[1]>({ capture: jest.fn() }),
      stub<AdminPtmService>({ getRiskBoardForCoach: s.board }),
    );
    const query = stub<RiskBoardQueryDto>({});
    expect((await ctrl.getCoachRiskBoard(req('coach'), query)).data.map((r) => r.user_id)).toEqual(['c1']);
    expect((await ctrl.getCoachRiskBoard(req('owner'), query)).data.map((r) => r.user_id)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('CF-SHARE-GATE-128: Command Center (coach Overview tab) follows the switches', () => {
  async function commandCenter() {
    const { providers } = setup();
    const mod = await Test.createTestingModule({ providers: [CommandCenterService, ...providers] }).compile();
    return mod.get(CommandCenterService);
  }

  it('overview: check-in tiles and streaks need Check-ins, at-risk needs all four, alerts by type', async () => {
    const o = await (await commandCenter()).getOverview(COACH);
    expect(o).toMatchObject({
      roster_size: 3,
      active_today: 2,
      pending_actions: 2,
      win_streak_count: 1,
      at_risk_count: 1,
      open_alerts: 3,
    });
  });

  it('at-risk lists only clients sharing all four', async () => {
    const r = await (await commandCenter()).getAtRisk(COACH, {});
    expect(r.items.map((i) => i.user_id)).toEqual(['c1']);
  });

  it('win streaks: check-in streaks need Check-ins, workout streaks need Workouts', async () => {
    const w = await (await commandCenter()).getWinStreaks(COACH, {});
    expect(w.items.map((i) => `${i.streak_type}:${i.user_id}`).sort()).toEqual(['check_in:c3', 'workout:c1']);
  });

  it('action queue: check-in alerts need Check-ins, the red-risk alert needs all four, other types stay', async () => {
    const q = await (await commandCenter()).getActionQueue(COACH, {});
    expect(q.items.map((i) => i.alert_id).sort()).toEqual(['a1', 'a4', 'a5']);
    expect(q.total_pending).toBe(3);
  });
});

describe('CF-SHARE-GATE-128: the gate cannot be skipped by wiring', () => {
  it('CheckInsService and CommandCenterService do not build without ConsentService', async () => {
    const { providers } = setup();
    const withoutConsent = providers.filter((p) => p.provide !== ConsentService);
    await expect(Test.createTestingModule({ providers: [CheckInsService, ...withoutConsent] }).compile()).rejects.toThrow(
      /ConsentService/,
    );
    await expect(
      Test.createTestingModule({ providers: [CommandCenterService, ...withoutConsent] }).compile(),
    ).rejects.toThrow(/ConsentService/);
  });
});

// B-865-SOL-130-1 (FIX-OPUS-130): two mounted coach routes with no app screen
// also follow the switches: the v1 roster's last check-in and last workout
// dates, and churn-at-risk (its score and factors read all four kinds of logs).
describe('B-865-SOL-130-1: GET /v1/coach/me/clients and churn-at-risk follow the switches', () => {
  const users = ['c1', 'c2', 'c3'].map((id) => ({ id, name: `Client ${id}`, role: 'student', coach_id: COACH, deleted_at: null }));
  const logs = users.map((u) => ({ user_id: u.id, date: ago(DAY) }));
  const preds = users.map((u) => ({
    user_id: u.id, computed_at: ago(DAY), risk_score: 0.8,
    factors: [{ key: 'weight', label: 'No weight logged in last 14 days', contribution: 1 }],
  }));
  const v1Providers = (consent: ConsentService | null) => [
    V1CoachService,
    { provide: PrismaService, useValue: {
      user: { findMany: jest.fn(async () => users) },
      checkIn: { groupBy: jest.fn(async (a: GroupArgs) => group(logs, a)) },
      workoutSession: { groupBy: jest.fn(async (a: GroupArgs) => group(logs, a)) },
      coachMessage: { groupBy: jest.fn(async () => []) },
    } },
    { provide: SupabaseService, useValue: {} },
    { provide: AuditService, useValue: { write: jest.fn() } },
    // 'sub-1' is a sub-coach of COACH; the grants belong to COACH.
    { provide: SubCoachScopeService, useValue: {
      isSubCoach: jest.fn(async (id: string) => id === 'sub-1'),
      getAuthorizedClientIds: jest.fn(async () => ['c1', 'c2', 'c3']),
      getHeadCoachIdForSubCoach: jest.fn(async (id: string) => (id === 'sub-1' ? COACH : null)),
    } },
    ...(consent ? [{ provide: ConsentService, useValue: consent }] : []),
  ];
  const churnProviders = (consent: ConsentService | null) => [
    ChurnInterventionService,
    { provide: PrismaService, useValue: {
      user: { findMany: jest.fn(async (a: { where?: Where }) => users.filter((u) => matches(u, a.where ?? {}))) },
      ptmPrediction: {
        groupBy: jest.fn(async (a: GroupArgs) => group(preds, a)),
        findMany: jest.fn(async (a: { where?: Where }) => preds.filter((p) => matches(p, a.where ?? {}))
          .map((p) => ({ ...p, user: { id: p.user_id, name: p.user_id, ptm_signals: [] } }))),
      },
      coachAlert: { findMany: jest.fn(async () => []) },
    } },
    { provide: PtmService, useValue: {} },
    { provide: ConfigService, useValue: { get: jest.fn() } },
    { provide: AiEgressService, useValue: {} },
    ...(consent ? [{ provide: ConsentService, useValue: consent }] : []),
  ];

  it('roster: the check-in date needs Check-ins, the workout date needs Workouts; sub-coach and owner keep their grant rules', async () => {
    const mod = await Test.createTestingModule({ providers: v1Providers(setup().consent) }).compile();
    const ctrl = new V1CoachController(mod.get(V1CoachService));
    const rows = async (id: string, role: string) => ctrl.listClients(stub<AuthedRequest>({ user: { id, role } }));
    const seen = (rs: Awaited<ReturnType<typeof rows>>) =>
      rs.map((r) => `${r.id}:${r.lastCheckInAt ? 'check-in' : '-'}:${r.lastWorkoutAt ? 'workout' : '-'}`);

    const coach = await rows(COACH, 'coach');
    expect(seen(coach)).toEqual(['c1:check-in:workout', 'c2:-:-', 'c3:check-in:-']);
    // A hidden check-in date is not turned into a "No check-in" risk reason.
    expect(coach.map((r) => r.riskReason ?? '').filter((r) => /check-in/i.test(r))).toEqual([]);
    expect(seen(await rows('sub-1', 'coach'))).toEqual(['c1:check-in:workout', 'c2:-:-', 'c3:check-in:-']);
    expect(seen(await rows('owner-1', 'owner'))).toEqual(['c1:check-in:workout', 'c2:check-in:workout', 'c3:check-in:workout']);
  });

  it('churn-at-risk lists only clients sharing all four; the owner account sees all', async () => {
    const mod = await Test.createTestingModule({ providers: churnProviders(setup().consent) }).compile();
    const ctrl = new CommandCenterController(stub<CommandCenterService>({}), mod.get(ChurnInterventionService));
    const listed = async (role: string) => (await ctrl.getChurnAtRisk(req(role))).items.map((i) => i.user_id);
    expect(await listed('coach')).toEqual(['c1']);
    expect(await listed('owner')).toEqual(['c1', 'c2', 'c3']);
  });

  it('V1CoachService and ChurnInterventionService do not build without ConsentService', async () => {
    await expect(Test.createTestingModule({ providers: v1Providers(null) }).compile()).rejects.toThrow(/ConsentService/);
    await expect(Test.createTestingModule({ providers: churnProviders(null) }).compile()).rejects.toThrow(/ConsentService/);
  });
});
