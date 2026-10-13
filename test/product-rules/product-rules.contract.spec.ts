/**
 * The four product rules (boot loader 140, section 3) as one contract. The real
 * AppModule runs over HTTP with its real guards and services; only Prisma (the
 * in-memory world.ts, one row of every model) and the JWT check are replaced.
 * Routes come from the Nest router and rows from prisma/schema.prisma, so a new
 * route or model is covered without editing this file.
 *
 * 1. A moved client is gone for the old coach (owner 4): after a move (coach_id
 *    changes and deleteDraftsLeftByMove runs, as every move path does), no GET
 *    the old coach can call answers 2xx with the client in it.
 * 2. History follows the client (139-13, 4b): the new coach gets the same answer
 *    whether the client's rows carry the old coach or the new one, the old
 *    coach's chat, nudges, tags and session notes never reach the new coach, and
 *    the move deletes only drafts (no export step, no wipe).
 * 3. Coachless clients have no Roman (139-15): every Roman, AI and AI-consent
 *    route a client may call answers 403 ROMAN_REQUIRES_COACH.
 * 4. Safety alerts are never lost or merged (57q), run on the real push outbox.
 *
 * KNOWN_GAPS: what fails on main today, skipped. The guard fails if the list
 * grows, and when a gap is fixed (remove it and lower the ceiling). EXEMPT: not
 * a path of the rule, with the reason. Fix a new path instead of listing it.
 */
import 'reflect-metadata';
import { ModelDef, Row, World, defaultFor, isRelation, parseSchema } from './world';
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
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { PushDeliveryService } from '../../src/notifications/push/push-delivery.service';
import { PrismaService } from '../../src/prisma.service';
import { asPrismaDouble } from '../../src/regimes/__tests__/prisma-test-double';
import { ROMAN_REQUIRES_COACH } from '../../src/roman/roman-requires-coach';
import { METRIC_AGGREGATION, METRIC_BUCKET } from '../../src/wearables/samples/metric-bucket.map';

jest.setTimeout(300_000);

type Rule = 1 | 2 | 3 | 4;
const KNOWN_GAPS: Array<{ id: string; rule: Rule; key: string; reason: string }> = [
  { id: 'MOVECLEAN inbox', rule: 1, key: 'GET /notifications', reason: "the old coach's inbox row about the client stays; MOVECLEAN (b#960) deletes it" },
  { id: 'HIST2A meal-plan assignees', rule: 1, key: 'GET /coach/daily-meal-plans/:id/assignments', reason: "the old coach's daily meal plan still lists the client; HIST2A (b#961) filters it" },
  { id: 'HIST2A past session', rule: 1, key: 'GET /scheduling/sessions/:id', reason: 'the old coach still opens a past session with the client; HIST2A (b#961) answers 404' },
  { id: 'HIST-2 program assignees', rule: 1, key: 'GET /workout-plans/:planId/assignments', reason: "a program's assignee list still names the client (HIST2A found, not fixed)" },
  { id: 'MOVE chat list', rule: 1, key: 'GET /v1/coach/me/threads', reason: "the old coach's chat list still shows the client and the last message (read by coach only)" },
  { id: 'CONTRACT-1 attention', rule: 1, key: 'GET /v1/coach/money/attention', reason: 'waiting on owner CONTRACT-1' },
  { id: 'CONTRACT-1 subscribers', rule: 1, key: 'GET /v1/coach/packages/:id/subscribers', reason: 'waiting on owner CONTRACT-1' },
  { id: 'CONTRACT-1 purchases', rule: 1, key: 'GET /v1/coach/payments/purchases', reason: 'waiting on owner CONTRACT-1' },
  { id: 'CONTRACT-1 purchase', rule: 1, key: 'GET /v1/coach/payments/purchases/:id', reason: 'waiting on owner CONTRACT-1' },
  { id: 'CONTRACT-1 sales', rule: 1, key: 'GET /v1/coach/purchases', reason: 'waiting on owner CONTRACT-1' },
  { id: 'BRIEF4B', rule: 2, key: 'GET /coach/brief/today', reason: "the new coach's brief shows the old coach's unread chat lines; BRIEF4B (b#964) fixes it" },
  { id: 'HIST-4b meal plans', rule: 2, key: 'GET /coach/clients/:client_id/meal-plans', reason: "the new coach lists only the meal plans they wrote; waiting on owner HIST-4b" },
  { id: 'HIST-4b past session', rule: 2, key: 'GET /scheduling/sessions/:id', reason: "the new coach can't open the client's past session; waiting on owner HIST-4b" },
  { id: 'CONSENT-2 grant', rule: 3, key: 'POST /me/ai-consent/roman', reason: 'a coachless client can still grant AI consent; CONSENT-2 (b#954) answers 403' },
  { id: 'CONTRACT-2', rule: 3, key: 'GET /roman/sessions/:id/messages', reason: 'waiting on owner CONTRACT-2' },
  { id: 'ROMAN-READ ai context', rule: 3, key: 'GET /ai/context', reason: 'a coachless client still reads what the AI knows about them (62x: no Roman at all)' },
  { id: 'ROMAN-READ ai structured', rule: 3, key: 'GET /ai/structured-context', reason: 'the same read, typed (62x: no Roman at all)' },
  { id: 'ROMAN-READ roman context', rule: 3, key: 'GET /roman/context/me', reason: 'a coachless client still reads what Roman is grounded in (62x: no Roman at all)' },
  { id: 'EDPUSH', rule: 4, key: 'another push never takes over a waiting safety push', reason: 'an ordinary push takes over a waiting eating-disorder push; EDPUSH (b#956) fixes it' },
];
const KNOWN_GAPS_CEILING = 19;
const EXEMPT: Array<{ rule: Rule; key: string; reason: string }> = [
  { rule: 1, key: 'GET /consent/check/:client_id/:scope', reason: 'it echoes the ids it was asked about and answers granted: false' },
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
// The client's sharing switches as they stand belong to the current coach.
const CURRENT_COACH = new Set(['ClientCoachConsent']);
// Owner 4b: the old coach's chat, nudges, tags and session notes stay with the old coach.
const PRIVATE_4B = new Set(['CoachMessage', 'CoachNudge', 'CoachClientTag']);
const PRIVATE_4B_TEXT = ['s:CoachMessage.', 's:CoachNudge.', 's:CoachClientTag.', 's:CoachingSession.coach_notes_md'];
// A coach's own rows about a client (codes, sales, drafts, alerts, reviews, logs) are not the client's
// history, so rule 2 never restamps them. Every other row with a client in it is the client's history.
const COACH_SIDE = new Set(['AICallLog', 'AIDraft', 'ChurnIntervention', 'ClientPurchase', 'CoachAlert', 'CoachBroadcast', 'CoachGuideline',
  'CoachWelcomeMessageJob', 'ContractEnvelope', 'ConversationReview', 'InviteCode', 'InviteRedemption', 'MessageDraft', 'PackageTrialUsage', 'TeamAuditEvent']);
// Owner 17: a move deletes the drafts other coaches hold, nothing else.
const MOVE_MAY_DELETE = new Set(['AIDraft', 'AiActionDraft', 'MessageDraft', 'ChurnIntervention']);

const { models, enums } = parseSchema();
const world = new World(models, enums);
const db = asPrismaDouble(world.client);
type State = 'before' | 'moved' | 'moved-restamped';

/** One row of every model. A User FK named for a coach (or invited_by, the sub-coach) holds the coach; any other the client. */
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
      const coachSide = /coach|tenant|invited_by/i.test(f.name);
      clients ||= fkTo.get(f.name) === 'User' && !coachSide;
      row[f.name] = fkTo.get(f.name) === 'User' ? (coachSide ? 'COACH' : MOVED) : fkTo.has(f.name) || f.isId ? ROW : defaultFor(m, f, enums);
    }
    const restamped = state === 'moved-restamped' && clients && !PRIVATE_4B.has(m.name) && !COACH_SIDE.has(m.name);
    const coach = state !== 'before' && (restamped || CURRENT_COACH.has(m.name)) ? NEW : OLD;
    for (const k of Object.keys(row)) if (row[k] === 'COACH') row[k] = coach;
    world.table(m.name).push(row);
  }
  // The old coach's own inbox row about the client (the generic row is the client's).
  const note = world.table('Notification')[0];
  world.table('Notification').push({ ...note, id: uuid(7), user_id: OLD, payload: { client_id: MOVED }, deep_link: `/coach/clients/${MOVED}` });
  // Reference rows the app checks at boot (a migration seeds them in production).
  const def = world.table('WearableMetricDef')[0];
  const metrics = Object.keys(METRIC_BUCKET) as Array<keyof typeof METRIC_BUCKET>;
  world.rows.set('WearableMetricDef', metrics.map((m) => ({ ...def, id: m, metric: m, bucket: METRIC_BUCKET[m], aggregation: METRIC_AGGREGATION[m] })));
  if (state !== 'before') await deleteDraftsLeftByMove(db, [MOVED], NEW);
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
    const leak = ok(old.status) && namesMoved(old.text);
    if (leak) found.leaks.push(r.key);
    const stampedOld = await call('new-coach', 'GET', r.path);
    if (ok(stampedOld.status) && PRIVATE_4B_TEXT.some((m) => stampedOld.text.includes(m))) found.private4b.push(r.key);
    await seed('moved-restamped');
    const stampedNew = await call('new-coach', 'GET', r.path);
    if (stampedOld.status !== stampedNew.status || normal(stampedOld.text) !== normal(stampedNew.text)) found.hidden.push(r.key);
    const at = Math.max(0, old.text.indexOf(MOVED) - 100);
    outcomes[r.key] = `old ${old.status} | new ${stampedOld.status}->${stampedNew.status}${leak ? ` | ${old.text.slice(at, at + 160)}` : ''}`;
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

  it('the same read names the client before the move (the check can fail)', async () => {
    await seed('before');
    const roster = await call('old-coach', 'GET', 'coach/clients');
    expect([roster.status, namesMoved(roster.text)]).toEqual([200, true]);
  });

  it('no route the old coach can call answers with the moved client (404 or left out)', () => {
    expect(unexpected(1, found.leaks)).toEqual([]);
  });
});

describe('Rule 2: history follows the client (139-13, owner 4b)', () => {
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
    await deleteDraftsLeftByMove(db, [MOVED], NEW);
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
  for (const [name, holds] of Object.entries(RULE4)) (listed(4).has(name) ? it.skip : it)(name, async () => expect(await holds()).toBe(true));
});

describe('Known gaps: skipped, and the list may only shrink', () => {
  for (const g of KNOWN_GAPS) it.skip(`${g.id} (rule ${g.rule}) ${g.key}: ${g.reason}`, () => undefined);

  it('the lists never grow', () => {
    expect([KNOWN_GAPS.length, EXEMPT.length]).toEqual([KNOWN_GAPS_CEILING, EXEMPT_CEILING]);
    expect(new Set(KNOWN_GAPS.map((g) => g.id)).size).toBe(KNOWN_GAPS.length);
  });

  it('a fixed gap leaves the list (remove it and lower the ceiling)', async () => {
    const failing: Record<Rule, string[]> = { 1: found.leaks, 2: [...found.hidden, ...found.private4b], 3: [...found.roman, ...found.romanCoached], 4: [] };
    for (const [name, holds] of Object.entries(RULE4)) if (!(await holds())) failing[4].push(name);
    expect([...KNOWN_GAPS, ...EXEMPT].filter((g) => !failing[g.rule].includes(g.key)).map((g) => g.key)).toEqual([]);
  });
});
