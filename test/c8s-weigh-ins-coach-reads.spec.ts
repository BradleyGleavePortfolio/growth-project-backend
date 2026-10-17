import { Test } from '@nestjs/testing';
import type { AuthedRequest } from '../src/auth/auth-request';
import { PrismaService } from '../src/prisma.service';
import { PtmService } from '../src/ptm/ptm.service';
import type { AuditService } from '../src/audit/audit.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import { CheckInsService } from '../src/check-ins/check-ins.service';
import { CoachCheckInsController } from '../src/check-ins/coach-check-ins.controller';
import type { ListCheckInsQueryDto } from '../src/check-ins/check-ins.dto';
import { CoachService } from '../src/coach/coach.service';
import { CoachController } from '../src/coach/coach.controller';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import { PrivateContextService } from '../src/ai/gateway/private-context.service';
import { AiGatewayController } from '../src/ai/gateway/ai-gateway.controller';
import type { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import type { AiApprovalService } from '../src/ai/gateway/ai-approval.service';
import { WeightService } from '../src/weight/weight.service';
import type { ClientAIContextService } from '../src/ai/client-ai-context.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

// C8-S (SoT A2 items 12-15): a coach-facing read returns a client's weight only
// to their current coach; #SHARE-SIMPLE: an old Weigh-ins switch-off no longer
// hides it. One table walks every coach read that can carry a weight or a
// number built from one. Client J moved from
// coach-before to coach-now; coach-before still holds every old grant. J keeps
// sharing Check-ins and habits, so check-in rows still come and only their
// weight must go. Each weight is a unique number; the two weight flags count too.
// Every case goes through a controller or an unchanged service signature.

function stub<T>(v: unknown): T {
  return v as T;
}
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type GroupArgs = { by: string[]; where?: Where; _max?: Record<string, true> };

const NOW_COACH = 'coach-now';
const FORMER = 'coach-before';
const J = 'client-j';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const num = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
const FOUR = [
  ConsentScope.FITNESS_WORKOUTS,
  ConsentScope.FITNESS_FOOD_MACROS,
  ConsentScope.FITNESS_BODY_METRICS,
  ConsentScope.FITNESS_HABITS_PROGRESS,
];
// Weigh-ins 183.3 > 182.2 > 181.1 (newest first: rising), check-in 82.4 kg,
// profile current 184.4 and target 166.6 lbs.
const WEIGHT = ['183.3', '182.2', '181.1', '82.4', '184.4', '166.6', 'weight_increasing', 'weight_flag'];
const seen = (out: unknown) => WEIGHT.filter((w) => JSON.stringify(out).includes(w));

// Minimal Prisma where-matcher: AND, equality, null, date, in, gte, lte; a
// compound unique key matches on its parts.
function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key.endsWith('_key')) return matches(row, cond as Where);
    const v = row[key];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return num(v) === cond.getTime();
    if (typeof cond !== 'object') return v === cond;
    const c = cond as { in?: unknown[]; gte?: unknown; lte?: unknown };
    if (c.in && !c.in.includes(v)) return false;
    if (c.gte !== undefined && !(num(v) >= num(c.gte))) return false;
    if (c.lte !== undefined && !(num(v) <= num(c.lte))) return false;
    return true;
  });
}

function group(rows: Row[], a: GroupArgs) {
  const key = a.by[0];
  const hit = rows.filter((r) => matches(r, a.where));
  return [...new Set(hit.map((r) => r[key]))].map((k) => {
    const rs = hit.filter((r) => r[key] === k);
    const max = (f: string) => rs.map((r) => r[f]).reduce((x, y) => (num(y) > num(x) ? y : x));
    return { [key]: k, _count: { _all: rs.length }, _max: Object.fromEntries(Object.keys(a._max ?? {}).map((f) => [f, max(f)])) };
  });
}

function world(weighInsShared: boolean) {
  const grant = (coach_id: string, scope: string, on: boolean) => ({
    client_id: J, coach_id, scope, granted_at: ago(60), revoked_at: on ? null : ago(1),
  });
  const profile = {
    id: 'profile-j', user_id: J, goal_type: 'fat_loss', activity_level: 'active', workout_experience: 'beginner',
    current_weight_lbs: 184.4, target_weight_lbs: 166.6, height_cm: 170, preferred_snacks: [], equipment_access: [],
  };
  const t: Record<string, Row[]> = {
    user: [{
      id: J, name: 'Jordan Lee', role: 'student', coach_id: NOW_COACH, archived_at: null, deleted_at: null,
      created_at: ago(90), profile, coach_messages_as_client: [],
    }],
    userProfile: [profile],
    clientCoachConsent: [
      ...FOUR.map((s) => grant(NOW_COACH, s, s !== ConsentScope.FITNESS_BODY_METRICS || weighInsShared)),
      ...FOUR.map((s) => grant(FORMER, s, true)),
    ],
    weightLog: [183.3, 182.2, 181.1].map((weight_lbs, i) => ({ id: `weigh-in-${i}`, user_id: J, date: ago(i + 1), weight_lbs })),
    checkIn: [{
      id: 'check-in-1', user_id: J, coach_id: NOW_COACH, date: ago(1), mood: 4, energy: 3, sleep_hours: 7,
      weight_kg: 82.4, notes: 'Slept well', reviewed_by_coach: false,
    }],
    loggedFoodEntry: [],
    workoutSession: [],
    clientWorkoutAssignment: [],
    message: [],
  };
  const model = (name: string) => ({
    findMany: jest.fn(async (a: { where?: Where } = {}) => t[name].filter((r) => matches(r, a.where))),
    findFirst: jest.fn(async (a: { where?: Where } = {}) => t[name].find((r) => matches(r, a.where)) ?? null),
    findUnique: jest.fn(async (a: { where: Where }) => t[name].find((r) => matches(r, a.where)) ?? null),
    count: jest.fn(async (a: { where?: Where } = {}) => t[name].filter((r) => matches(r, a.where)).length),
    groupBy: jest.fn(async (a: GroupArgs) => group(t[name], a)),
  });
  return Object.fromEntries(Object.keys(t).map((name) => [name, model(name)]));
}

async function routes(weighInsShared: boolean) {
  const prisma = world(weighInsShared);
  // Who coaches J now (SubCoachScopeService.getAuthorizedClientIds): NOW_COACH only.
  const coaches = stub<SubCoachScopeService>({ getAuthorizedClientIds: jest.fn(async (id: string) => (id === NOW_COACH ? [J] : [])) });
  const consent = new ConsentService(stub<PrismaService>(prisma), stub<AuditService>({ write: jest.fn() }), coaches);
  const mod = await Test.createTestingModule({
    providers: [
      CheckInsService,
      PrivateContextService,
      { provide: PrismaService, useValue: prisma },
      { provide: PtmService, useValue: {} },
      { provide: ConsentService, useValue: consent },
    ],
  }).compile();
  const service = new CoachService(stub<PrismaService>(prisma), stub<AuditService>({ write: jest.fn(async () => {}) }), consent);
  // The provider double answers with the prompt it was sent: whatever the model saw can reach the coach.
  const gateway = stub<AiGatewayService>({ invoke: jest.fn(async (a: { systemPrompt: string }) => ({ reply: a.systemPrompt })) });
  return {
    coach: new CoachController(service, stub<AnalyticsService>({ capture: jest.fn() }), stub<AdminPtmService>({})),
    checkIns: new CoachCheckInsController(mod.get(CheckInsService)),
    ai: new AiGatewayController(gateway, stub<AiApprovalService>({}), mod.get(PrivateContextService)),
    ownCheckIns: mod.get(CheckInsService),
    weight: new WeightService(stub<PrismaService>(prisma), stub<PtmService>({}), stub<ClientAIContextService>({})),
  };
}

type Routes = Awaited<ReturnType<typeof routes>>;
type Read = (r: Routes, callerId: string) => Promise<unknown>;
const caller = (id: string, role = 'coach', coach_id: string | null = null) =>
  stub<AuthedRequest>({ user: { id, role, coach_id }, headers: {} });
const ASK = stub<ListCheckInsQueryDto>({});
const run = (read: Read, r: Routes, id: string) => read(r, id).catch((e: Error) => ({ refused: e.message }));

// The path list (PR body, "Path table"), every coach read here that can return a weight.
const COACH_READS: Array<[string, Read]> = [
  ['GET /coach/clients (profile weights)', (r, id) => r.coach.getClients(caller(id))],
  ['GET /coach/clients/:id/summary (weigh-ins, profile weights)', (r, id) => r.coach.getClientSummary(caller(id), J)],
  ['GET /coach/clients/:id/timeline (weigh-ins, check-in rows, events)', (r, id) => r.coach.getClientTimeline(caller(id), J)],
  ['GET /coach/clients/:client_id/check-ins (check-in rows)', (r, id) => r.checkIns.list(caller(id), J, ASK)],
  ['GET /coach/alerts (weight_increasing)', (r, id) => r.coach.getAlerts(caller(id))],
  ['GET /coach/dashboard/summary (weight_flag)', (r, id) => r.coach.getDashboardSummary(caller(id))],
  ['POST /ai/gateway/invoke about a client (AI context)', (r, id) =>
    r.ai.invoke(caller(id), { capability: 'client_path_summary', message: 'How is the week going?', subject_user_id: J })],
];

describe.each(COACH_READS)('C8-S %s', (_path, read) => {
  it('Weigh-ins on: the coach gets the weight', async () => {
    expect(seen(await run(read, await routes(true), NOW_COACH))).not.toEqual([]);
  });

  it('an old Weigh-ins switch-off: the current coach still gets the weight (#SHARE-SIMPLE)', async () => {
    expect(seen(await run(read, await routes(false), NOW_COACH))).not.toEqual([]);
  });

  it('a former coach after the move: nothing, though their old grants are still on', async () => {
    const out = await run(read, await routes(true), FORMER);
    expect(seen(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(J);
  });
});

describe('C8-S an old Weigh-ins switch-off (#SHARE-SIMPLE)', () => {
  it('the current coach still gets weigh-ins and the check-in weight; the timeline says weigh-ins are shared', async () => {
    const r = await routes(false);
    const row = { id: 'check-in-1', mood: 4, weight_kg: 82.4 };
    const timeline = await r.coach.getClientTimeline(caller(NOW_COACH), J);
    expect(timeline).toMatchObject({ checkIns: [row], consent: { body_metrics: true, habits_progress: true } });
    expect((timeline as { weights: unknown[] }).weights).toHaveLength(3);
    expect(await r.checkIns.list(caller(NOW_COACH), J, ASK)).toMatchObject([row]);
  });
});

const OWN_READS: Array<[string, (r: Routes) => Promise<unknown>]> = [
  ['GET /check-ins', (r) => r.ownCheckIns.listForClient(J, ASK)],
  ['GET /weight/history', (r) => r.weight.getHistory(J)],
  ['POST /ai/gateway/invoke about themselves', (r) =>
    r.ai.invoke(caller(J, 'student', NOW_COACH), { capability: 'chat.client_self', message: 'How am I doing?' })],
];

it.each(OWN_READS)('C8-S the client always sees their own weight, Weigh-ins off: %s', async (_path, read) => {
  expect(seen(await read(await routes(false)))).not.toEqual([]);
});
