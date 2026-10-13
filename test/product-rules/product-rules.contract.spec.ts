/**
 * The four product rules (boot loader 140, section 3) as one contract. The real
 * AppModule runs over HTTP with its real guards and services; only Prisma (the
 * in-memory world.ts, one row of every model) and the JWT check are replaced.
 * Routes come from the Nest router and rows from prisma/schema.prisma, so a new
 * route or model is covered without editing this file.
 *
 * 1. A moved client is gone for the old coach (owner 4): after a move (coach_id
 *    changes and deleteDraftsLeftByMove runs, as every move path does), no GET
 *    the old coach can call answers 2xx with the client in it. Their own money
 *    records may keep the client's name (CONTRACT-1), and the move cancels
 *    their upcoming sessions with the client (HIST-2b).
 * 2. History follows the client (139-13, 4b): the new coach gets the same answer
 *    whether the client's rows carry the old coach or the new one, the old
 *    coach's chat, nudges, tags and session notes never reach the new coach, and
 *    the move deletes only drafts (no export step, no wipe).
 * 3. Coachless clients have no Roman (139-15): every Roman, AI and AI-consent
 *    route a client may call answers 403 ROMAN_REQUIRES_COACH.
 * 4. Safety alerts are never lost or merged (57q), run on the real push outbox.
 *
 * KNOWN_GAPS: what fails on main today, skipped, each naming the PR, job or
 * owner decision that fixes it. The guard fails if the list grows, and when a
 * gap is fixed (remove it and lower the ceiling). EXEMPT: not a path of the
 * rule, with the reason. Fix a new path instead of listing it.
 */
import 'reflect-metadata';
import { ModelDef, Row, SEED_DATE, World, defaultFor, isRelation, parseSchema } from './world';
import type { AddressInfo } from 'node:net';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { JwksVerifierService } from '../../src/auth/jwks.service';
import { deleteDraftsLeftByMove } from '../../src/coach/moved-client-drafts';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { ConsentScope } from '../../src/consent/consent.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { PushDeliveryService } from '../../src/notifications/push/push-delivery.service';
import { PrismaService } from '../../src/prisma.service';
import { asPrismaDouble } from '../../src/regimes/__tests__/prisma-test-double';
import { ROMAN_REQUIRES_COACH } from '../../src/roman/roman-requires-coach';
import { METRIC_AGGREGATION, METRIC_BUCKET } from '../../src/wearables/samples/metric-bucket.map';

jest.setTimeout(300_000);

type Rule = 1 | 2 | 3 | 4;
// HIST-2b, checked on the world rather than through a route.
const MOVE_CANCELS = "a move cancels the old coach's upcoming session with the client and leaves the past one";
const KNOWN_GAPS: Array<{ id: string; rule: Rule; key: string; reason: string }> = [
  { id: 'MOVECLEAN inbox', rule: 1, key: 'GET /notifications', reason: "the old coach's inbox row about the client stays; fix: #960 MOVECLEAN" },
  { id: 'HIST2A meal-plan assignees', rule: 1, key: 'GET /coach/daily-meal-plans/:id/assignments', reason: "the old coach's daily meal plan still lists the client; fix: #961 HIST2A" },
  { id: 'HIST2A past session', rule: 1, key: 'GET /scheduling/sessions/:id', reason: 'the old coach still opens a past session with the client; fix: #961 HIST2A' },
  { id: 'HIST2A program assignees', rule: 1, key: 'GET /v1/coach/programs/:programId/assignees', reason: "the old coach's program still lists the client's copy; fix: #961 HIST2A" },
  { id: 'HIST2B plan assignees', rule: 1, key: 'GET /workout-plans/:planId/assignments', reason: "a plan's assignment list still names the client; fix: #967 HIST2B" },
  { id: 'HIST2C upcoming session', rule: 1, key: MOVE_CANCELS, reason: "nothing cancels the old coach's upcoming session with the client; fix: HIST2C" },
  { id: 'HIST2C upcoming list', rule: 1, key: 'GET /scheduling/sessions', reason: "the old coach's calendar still lists the upcoming session with the client; fix: HIST2C" },
  { id: 'GAPS1 chat list', rule: 1, key: 'GET /v1/coach/me/threads', reason: "the old coach's chat list still shows the client and the last message; fix: GAPS1" },
  { id: 'MONEY1 attention', rule: 1, key: 'GET /v1/coach/money/attention', reason: "a dispute row still carries the client's id, not only the name; fix: MONEY1" },
  { id: 'MONEY1 subscribers', rule: 1, key: 'GET /v1/coach/packages/:id/subscribers', reason: "a subscriber row still carries the client's id; fix: MONEY1" },
  { id: 'MONEY1 purchases', rule: 1, key: 'GET /v1/coach/payments/purchases', reason: "a purchase row still carries the client's id; fix: MONEY1" },
  { id: 'MONEY1 purchase', rule: 1, key: 'GET /v1/coach/payments/purchases/:id', reason: "one purchase still carries the client's id; fix: MONEY1" },
  { id: 'MONEY1 sales', rule: 1, key: 'GET /v1/coach/purchases', reason: "a sale row still carries the client's id; fix: MONEY1" },
  { id: 'BRIEF4B', rule: 2, key: 'GET /coach/brief/today', reason: "the new coach's brief shows the old coach's unread chat; fix: #964 BRIEF4B" },
  { id: 'HIST-4b meal plans', rule: 2, key: 'GET /coach/clients/:client_id/meal-plans', reason: 'the new coach lists only the meal plans they wrote; fix: HIST-4b (owner)' },
  { id: 'HIST-4b past session', rule: 2, key: 'GET /scheduling/sessions/:id', reason: "the new coach can't open the client's past session; fix: HIST-4b (owner)" },
  { id: 'HIST-4b program days', rule: 2, key: 'GET /workout-plans', reason: "the new coach's plan list leaves out the days of the client's program copy; fix: HIST-4b (owner)" },
  { id: 'CONSENT-2 grant', rule: 3, key: 'POST /me/ai-consent/roman', reason: 'a coachless client is not refused an AI grant; fix: #954 CONSENT-2' },
  { id: 'CONTRACT-2', rule: 3, key: 'GET /roman/sessions/:id/messages', reason: 'may a coachless client open an old Roman chat; fix: CONTRACT-2 (owner)' },
  { id: 'GAPS3 ai context', rule: 3, key: 'GET /ai/context', reason: 'a coachless client still reads what the AI knows about them; fix: GAPS3 #970' },
  { id: 'GAPS3 ai structured', rule: 3, key: 'GET /ai/structured-context', reason: 'the same read, typed; fix: GAPS3 #970' },
  { id: 'GAPS3 roman context', rule: 3, key: 'GET /roman/context/me', reason: 'a coachless client still reads what Roman is grounded in; fix: GAPS3 #970' },
];
const KNOWN_GAPS_CEILING = 22;
const EXEMPT: Array<{ rule: Rule; key: string; reason: string }> = [
  { rule: 1, key: 'GET /consent/check/:client_id/:scope', reason: "it echoes the ids it was asked about and whether the caller's own grant stands, nothing else" },
  { rule: 2, key: 'GET /coach/consultation', reason: "the coach's own set-up; it mints a random invite code for a coach with none, so two reads differ" },
  { rule: 2, key: 'GET /coaches/me/invite-link', reason: "the coach's own link; it mints a random invite code for a coach with none, so two reads differ" },
  { rule: 3, key: 'GET /roman/sessions', reason: '62x: a coachless client "may delete prior data here"; this is the list they delete from' },
  { rule: 3, key: 'DELETE /roman/sessions', reason: '62x: a coachless client may delete prior data' },
  { rule: 3, key: 'DELETE /roman/sessions/:id', reason: '62x: a coachless client may delete prior data' },
  { rule: 3, key: 'GET /me/ai-consent', reason: 'CONSENT-2 (b#954) keeps it open so the app can read the consent state' },
  { rule: 3, key: 'DELETE /me/ai-consent/roman', reason: 'CONSENT-2 (b#954) keeps it open: withdrawing only turns AI use off' },
  { rule: 3, key: 'POST /coachless/roman-card/seen', reason: 'the coachless card that says Roman needs a coach; it records a view, no AI' },
  { rule: 3, key: 'POST /coachless/roman-card/not-now', reason: 'the coachless card that says Roman needs a coach; it records Not now, no AI' },
];
const EXEMPT_CEILING = 10;

const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const [OLD, NEW, MOVED, COACHLESS, COACHED, ROW] = [1, 2, 3, 4, 5, 6].map(uuid);
const COPY = uuid(8); // the client's copy of a program
// The bearer token is the label; the JWT stand-in answers it as the user.
const USERS: Array<[id: string, role: string, label: string]> = [
  [OLD, 'coach', 'old-coach'],
  [NEW, 'coach', 'new-coach'],
  [MOVED, 'student', 'moved'],
  [COACHLESS, 'student', 'coachless'],
  [COACHED, 'student', 'coached'],
];
// Rows that decide who coaches whom: none, so only coach_id does.
const AUTHORITY = new Set(['SubCoachAssignment', 'TeamSubCoachAssignment', 'SubCoachInvite']);
// Owner 4b: the old coach's chat, nudges, tags and session notes stay with the old coach.
const PRIVATE_4B = new Set(['CoachMessage', 'CoachNudge', 'CoachClientTag']);
const PRIVATE_4B_TEXT = ['s:CoachMessage.', 's:CoachNudge.', 's:CoachClientTag.', 's:CoachingSession.coach_notes_md'];
// A coach's own rows about a client (codes, sales, drafts, alerts, reviews, logs) are not the client's
// history, so rule 2 never restamps them. Every other row with a client in it is the client's history.
const COACH_SIDE = new Set(['AICallLog', 'AIDraft', 'AiActionDraft', 'AiRequestAudit', 'AuditLog', 'ChurnIntervention', 'ClientPurchase',
  'CoachAlert', 'CoachBroadcast', 'CoachCodeRedemption', 'CoachFirstPaymentNotification', 'CoachGuideline', 'CoachPlaybookSource',
  'CoachThreadState', 'CoachWelcomeMessageJob', 'ContractEnvelope', 'ConversationReview', 'InviteCode', 'InviteRedemption', 'MessageDraft',
  'MessageReport', 'PackageTrialUsage', 'TeamAuditEvent', 'WorkoutAdjustmentProposal']);
// Plain id columns (no @relation) that say whose row it is hold the same people the foreign keys do. Who-did-it
// stamps (author, actor, decided_by, accepted_by) keep their marker: no coach read is scoped by them.
const PLAIN_PERSON = /^((tenant_|head_)?coach(_user)?_id|coachId|owner_user_id|payee_user_id|client_id|clientId|subject_user_id)$/;
// Owner 17: a move deletes the drafts other coaches hold, nothing else.
const MOVE_MAY_DELETE = new Set(['AIDraft', 'AiActionDraft', 'MessageDraft', 'ChurnIntervention']);
// What every move path runs once coach_id changes. HIST2C adds its session cancel here when it lands.
const move = () => deleteDraftsLeftByMove(db, [MOVED], NEW);
// CONTRACT-1 Option 1: the old coach keeps their own money records for the client (name, date, amount; the record's
// id, status and currency don't name anyone) and nothing else about the client or their new coach.
const MONEY = /^v1\/coach\/(money|payments|purchases|packages\/:id\/subscribers)(\/|$)/;
const moneyLeak = (t: string) => namesMoved(t.replace(/moved:name\b/g, '')) || t.includes(NEW);

const { models, enums } = parseSchema();
const world = new World(models, enums);
const db = asPrismaDouble(world.client);
type State = 'before' | 'moved' | 'moved-restamped';

/** One row of every model. A person column named for a coach (or invited_by, owner_user) holds the coach; any other the client. */
async function seed(state: State): Promise<void> {
  world.rows.clear();
  const user = models.get('User') as ModelDef;
  for (const [id, role, label] of USERS) {
    const row: Row = {};
    for (const f of user.fields.values()) {
      const v = isRelation(f, models) ? undefined : defaultFor(user, f, enums);
      if (v !== undefined) row[f.name] = typeof v === 'string' && v.startsWith('s:') ? `${label}:${f.name}` : v;
    }
    const coach = id === MOVED ? (state === 'before' ? OLD : NEW) : id === COACHED ? NEW : null;
    world.table('User').push(Object.assign(row, { id, role, coach_id: coach, supabase_id: label }));
  }
  for (const m of models.values()) {
    if (m.name === 'User' || AUTHORITY.has(m.name)) continue;
    const fkTo = new Map<string, string>();
    for (const f of m.fields.values()) if (isRelation(f, models)) f.fk?.forEach((k) => fkTo.set(k, f.type));
    const row: Row = {};
    let clients = false;
    for (const f of m.fields.values()) {
      if (isRelation(f, models)) continue;
      const person = fkTo.get(f.name) === 'User' || (!fkTo.has(f.name) && f.type === 'String' && !f.list && PLAIN_PERSON.test(f.name));
      const coachSide = /coach|tenant|invited_by|owner_user|payee/i.test(f.name);
      clients ||= person && !coachSide;
      row[f.name] = person ? (coachSide ? 'COACH' : MOVED) : fkTo.has(f.name) || f.isId ? ROW : defaultFor(m, f, enums);
    }
    const restamped = state === 'moved-restamped' && clients && !PRIVATE_4B.has(m.name) && !COACH_SIDE.has(m.name);
    const coach = state !== 'before' && restamped ? NEW : OLD;
    for (const k of Object.keys(row)) if (row[k] === 'COACH') row[k] = coach;
    world.table(m.name).push(row);
  }
  // The client shares every scope with both coaches. Nothing revokes the old coach's grants on a move, so only the move
  // rules can hide the client from them, and the new coach reads real history, not a consent refusal.
  const consent = world.table('ClientCoachConsent')[0];
  world.rows.set('ClientCoachConsent', [OLD, NEW].flatMap((coach_id) => Object.values(ConsentScope).map((scope) =>
    ({ ...consent, id: `${coach_id}:${scope}`, coach_id, scope, granted_at: SEED_DATE }))));
  // Programs are template-first: coach A's master has no client and stays coach A's. The client runs a copy of it,
  // with a day that holds the client's assignment; the copy is the client's history.
  const [program, plan, assignment] = ['WorkoutProgram', 'WorkoutPlan', 'ClientWorkoutAssignment'].map((m) => world.table(m)[0]);
  world.table('WorkoutProgram').push({ ...program, id: COPY, is_template: false, cloned_from_id: ROW, delivery_key: null });
  world.table('WorkoutPlan').push({ ...plan, id: COPY, program_id: COPY, coach_id: program.coach_id });
  world.table('ClientWorkoutAssignment').push({ ...assignment, id: COPY, workout_plan_id: COPY });
  Object.assign(program, { client_id: null, coach_id: OLD, owner_user_id: OLD });
  // HIST-2b: the generic session is past; this one, a week out with the old coach, is what a move cancels.
  const [session] = world.table('CoachingSession');
  const soon = SEED_DATE.getTime() + 8 * 86_400_000;
  world.table('CoachingSession').push({ ...session, id: uuid(9), coach_id: OLD, status: 'scheduled', start_at: new Date(soon), end_at: new Date(soon + 3_600_000) });
  // The old coach's own inbox row about the client (the generic row is the client's).
  const note = world.table('Notification')[0];
  world.table('Notification').push({ ...note, id: uuid(7), user_id: OLD, payload: { client_id: MOVED }, deep_link: `/coach/clients/${MOVED}` });
  // Reference rows the app checks at boot (a migration seeds them in production).
  const def = world.table('WearableMetricDef')[0];
  const metrics = Object.keys(METRIC_BUCKET) as Array<keyof typeof METRIC_BUCKET>;
  world.rows.set('WearableMetricDef', metrics.map((m) => ({ ...def, id: m, metric: m, bucket: METRIC_BUCKET[m], aggregation: METRIC_AGGREGATION[m] })));
  if (state !== 'before') await move();
}

interface Route {
  key: string;
  method: string;
  path: string;
  roles: string[];
}
let app: INestApplication;
let base = '';
let routes: Route[] = [];
const found: Record<'leaks' | 'hidden' | 'private4b' | 'roman' | 'romanCoached', string[]> = { leaks: [], hidden: [], private4b: [], roman: [], romanCoached: [] };
const outcomes: Record<string, string> = {};

/** Client-named params get the moved client, every other id the stored row. */
async function call(user: string, method: string, path: string): Promise<{ status: number; text: string }> {
  const segs = path.split('/');
  const url = segs.map((s, i) => {
    const name = s.slice(1).replace(/\?$/, '');
    if (!s.startsWith(':')) return s;
    return /^(client|student)(_?id)?$/i.test(name) || (name === 'id' && /^(clients|students)$/.test(segs[i - 1])) ? MOVED : ROW;
  });
  try {
    const r = await fetch(`${base}/api/${url.join('/')}?client_id=${MOVED}&clientId=${MOVED}`, {
      method,
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ content: 'Plan my week', message: 'Plan my week' }),
      signal: AbortSignal.timeout(4000),
    });
    return { status: r.status, text: await r.text() };
  } catch {
    return { status: 0, text: '' };
  }
}
const ok = (status: number) => status >= 200 && status < 300;
const namesMoved = (t: string) => t.includes(MOVED) || t.includes('moved:');
// Coach ids, times, new ids and request ids aside; the new coach's own session notes are 4b-checked instead.
const normal = (t: string) =>
  t.split(OLD).join('C').split(NEW).join('C').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z|gen-\d+|"request_id":"\w+"/g, '_').replace(/"s:CoachingSession\.coach_notes_md"/g, 'null');
const listed = (rule: Rule) => new Set([...KNOWN_GAPS, ...EXEMPT].filter((g) => g.rule === rule).map((g) => g.key));
const unexpected = (rule: Rule, keys: string[]) => keys.filter((k) => !listed(rule).has(k));
// A check that is not one route (rule 1's move, rule 4's outbox): skipped while listed, and seen by the guard.
const CHECKS: Array<[Rule, string, () => Promise<boolean>]> = [];
function check(rule: Rule, name: string, holds: () => Promise<boolean>): void {
  CHECKS.push([rule, name, holds]);
  (listed(rule).has(name) ? it.skip : it)(name, async () => expect(await holds()).toBe(true));
}

beforeAll(async () => {
  await seed('moved');
  const ref = await Test.createTestingModule({ imports: [DiscoveryModule, AppModule] })
    .overrideProvider(PrismaService)
    .useValue(world.client)
    .overrideProvider(JwksVerifierService)
    .useValue({ verify: async (sub: string) => ({ sub }), verifyForDeletionReceipt: async (sub: string) => ({ sub }) })
    .compile();
  app = ref.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  // No cron or interval may touch the world between a seed and its call.
  const jobs = ref.get(SchedulerRegistry);
  jobs.getCronJobs().forEach((job) => void job.stop());
  jobs.getIntervals().forEach((name) => jobs.deleteInterval(name));
  jobs.getTimeouts().forEach((name) => jobs.deleteTimeout(name));

  const reflector = ref.get(Reflector);
  const seen = new Map<string, Route>();
  for (const w of ref.get(DiscoveryService).getControllers()) {
    const proto = w.instance && Object.getPrototypeOf(w.instance);
    if (!w.metatype || !proto) continue;
    const prefixes = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, w.metatype) ?? '');
    for (const name of ref.get(MetadataScanner).getAllMethodNames(proto)) {
      const handler = proto[name];
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (sub === undefined || reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, w.metatype])) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [handler, w.metatype]) ?? [];
      for (const p of prefixes)
        for (const s of ([] as string[]).concat(sub)) {
          const path = [p, s].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
          seen.set(`${method} /${path}`, { key: `${method} /${path}`, method, path, roles });
        }
    }
  }
  routes = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));

  // Rules 1 and 2: every GET a coach can call (not admin, internal or owner-only).
  for (const r of routes.filter((x) => x.method === 'GET' && !/^(v1\/)?(admin|internal)\b/.test(x.path) && !(x.roles.length && x.roles.every((y) => y === 'owner')))) {
    await seed('moved');
    const old = await call('old-coach', 'GET', r.path);
    const leak = ok(old.status) && (MONEY.test(r.path) ? moneyLeak(old.text) : namesMoved(old.text));
    if (leak) found.leaks.push(r.key);
    const stampedOld = await call('new-coach', 'GET', r.path);
    if (ok(stampedOld.status) && PRIVATE_4B_TEXT.some((m) => stampedOld.text.includes(m))) found.private4b.push(r.key);
    await seed('moved-restamped');
    const stampedNew = await call('new-coach', 'GET', r.path);
    const [was, now] = [stampedOld.text, stampedNew.text].map(normal);
    if (stampedOld.status !== stampedNew.status || was !== now) found.hidden.push(r.key);
    // The log shows where the old coach's answer names the client, and where the new coach's two answers part.
    const at = Math.max(0, old.text.indexOf(MOVED) - 100);
    const parts = Math.max(0, [...was].findIndex((c, i) => c !== now[i]) - 60);
    outcomes[r.key] = `old ${old.status} | new ${stampedOld.status}->${stampedNew.status}${leak ? ` | ${old.text.slice(at, at + 160)}` : ''}` +
      (was !== now ? ` | ${was.slice(parts, parts + 160)} >> ${now.slice(parts, parts + 160)}` : '');
  }

  // Rule 3: every Roman, AI and AI-consent route a client may call.
  for (const r of routes.filter((x) => /(^|\/)roman\b|^ai\/(?!gateway)|^me\/ai-consent/.test(x.path) && x.roles.includes('student'))) {
    await seed('moved');
    const res = await call('coachless', r.method, r.path);
    const code = /"code":"([^"]+)"/.exec(res.text)?.[1];
    if (!(res.status === 403 && code === ROMAN_REQUIRES_COACH)) found.roman.push(r.key);
    if (r.method === 'GET' && (await call('coached', 'GET', r.path)).text.includes(ROMAN_REQUIRES_COACH)) found.romanCoached.push(r.key);
    outcomes[r.key] = `coachless ${res.status} ${code}`;
  }
  console.log(`product-rules contract: ${routes.length} routes\n${JSON.stringify({ found, outcomes }, null, 1)}`);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Rule 1: a moved client is gone for the old coach (owner 4)', () => {
  it('reads every coach route in the router', () => {
    expect(routes.length).toBeGreaterThan(500);
    for (const k of ['GET /coach/clients', 'GET /coach/alerts', 'GET /notifications', 'GET /coach/clients/:id/summary']) expect(outcomes[k]).toBeDefined();
  });

  // The roster, Roman's drafts (plain tenant_coach_id), a program's clients (plain coach_id and owner_user_id, the
  // client's copy) and check-ins (behind the client's consent): the fixture is real, so the check can fail.
  const reads = ['coach/clients', 'ai/gateway/drafts', `v1/coach/programs/${ROW}/assignees`, `coach/clients/${MOVED}/check-ins`];
  it.each(reads)('before the move, %s names the client', async (path) => {
    await seed('before');
    const res = await call('old-coach', 'GET', path);
    expect([res.status, namesMoved(res.text)]).toEqual([200, true]);
  });

  it('no route the old coach can call answers with the moved client (404 or left out)', () => {
    expect(unexpected(1, found.leaks)).toEqual([]);
  });

  check(1, MOVE_CANCELS, async () => {
    await seed('before');
    const past = JSON.stringify(world.table('CoachingSession')[0]);
    await seed('moved');
    const [after, upcoming] = world.table('CoachingSession');
    return upcoming?.status === 'canceled' && JSON.stringify(after) === past;
  });
});

describe('Rule 2: history follows the client (139-13, owner 4b)', () => {
  it("after the move, the new coach reads the client's check-ins (the comparison sees real history)", async () => {
    await seed('moved');
    const res = await call('new-coach', 'GET', `coach/clients/${MOVED}/check-ins`);
    expect([res.status, namesMoved(res.text)]).toEqual([200, true]);
  });

  it("the new coach reads the client's history whichever coach's id it carries", () => {
    expect(unexpected(2, found.hidden)).toEqual([]);
  });

  it("the old coach's chat, nudges, tags and session notes never reach the new coach", () => {
    expect(unexpected(2, found.private4b)).toEqual([]);
  });

  it('a move deletes only drafts: no export step, no wipe', async () => {
    await seed('before');
    const sizes = () => new Map([...world.rows].map(([m, rows]): [string, number] => [m, rows.length]));
    const was = sizes();
    await move();
    const lost = [...sizes()].filter(([m, n]) => n < (was.get(m) ?? 0)).map(([m]) => m);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.filter((m) => !MOVE_MAY_DELETE.has(m))).toEqual([]);
  });
});

describe('Rule 3: coachless clients have no Roman (139-15)', () => {
  it('every Roman, AI and AI-consent route answers a coachless client 403 ROMAN_REQUIRES_COACH', () => {
    expect(Object.values(outcomes).filter((v) => v.startsWith('coachless')).length).toBeGreaterThan(10);
    expect(unexpected(3, found.roman)).toEqual([]);
  });

  it('a client with a coach is never told Roman needs a coach', () => {
    expect(unexpected(3, found.romanCoached)).toEqual([]);
  });
});

// Rule 4 on the real push outbox for a coach in New York, at 22:00 there.
const NIGHT = new Date('2026-10-13T02:00:00.000Z');
const MORNING = new Date('2026-10-13T12:00:00.000Z');
class PushAt extends PushDeliveryService {
  protected now(): Date {
    return NIGHT;
  }
}
function outbox(): PushAt {
  world.rows.clear();
  const svc = new PushAt(db);
  svc.autoDrain = false;
  return svc;
}
const push = (alertId: string | null, urgent = false) => ({
  userId: NEW,
  kind: NotificationKind.COACH_ALERT,
  title: 'Coach alert',
  body: alertId ? `Safety alert ${alertId}` : 'Ordinary alert',
  data: { alertId },
  dedupeKey: alertId && `coach_alert:${alertId}`,
  collapseKey: `${NotificationKind.COACH_ALERT}:/coach/notifications`,
  urgent,
  timeZone: 'America/New_York',
});
const bodies = () => world.table('PushOutbox').map((r) => r.body).join(' | ');
const RULE4: Record<string, () => Promise<boolean>> = {
  'an urgent safety push goes at once': async () => {
    const r = await outbox().enqueue(push('urgent', true));
    return r.code === 'queued' && r.notBefore.getTime() === NIGHT.getTime();
  },
  'an eating-disorder push waits until 08:00 and is kept': async () => {
    const r = await outbox().enqueue(push('ed'));
    const row = world.table('PushOutbox')[0];
    return r.code === 'deferred' && row?.status === 'pending' && (row.not_before as Date).getTime() === MORNING.getTime();
  },
  'two safety alerts are two pushes, never merged': async () => {
    const svc = outbox();
    await svc.enqueue(push('ed'));
    await svc.enqueue(push('ed-2'));
    return bodies() === 'Safety alert ed | Safety alert ed-2';
  },
  'another push never takes over a waiting safety push': async () => {
    const svc = outbox();
    await svc.enqueue(push('ed'));
    await svc.enqueue(push(null));
    return bodies() === 'Safety alert ed | Ordinary alert';
  },
};

describe('Rule 4: safety alerts are never lost or merged (57q)', () => {
  for (const [name, holds] of Object.entries(RULE4)) check(4, name, holds);
});

describe('Known gaps: skipped, and the list may only shrink', () => {
  for (const g of KNOWN_GAPS) it.skip(`${g.id} (rule ${g.rule}) ${g.key}: ${g.reason}`, () => undefined);

  it('the lists never grow', () => {
    expect([KNOWN_GAPS.length, EXEMPT.length]).toEqual([KNOWN_GAPS_CEILING, EXEMPT_CEILING]);
    expect(new Set(KNOWN_GAPS.map((g) => g.id)).size).toBe(KNOWN_GAPS.length);
  });

  it('a fixed gap leaves the list (remove it and lower the ceiling)', async () => {
    const failing: Record<Rule, string[]> = { 1: [...found.leaks], 2: [...found.hidden, ...found.private4b], 3: [...found.roman, ...found.romanCoached], 4: [] };
    for (const [rule, name, holds] of CHECKS) if (!(await holds())) failing[rule].push(name);
    expect([...KNOWN_GAPS, ...EXEMPT].filter((g) => !failing[g.rule].includes(g.key)).map((g) => g.key)).toEqual([]);
  });
});
