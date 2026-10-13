/**
 * The four product rules as one contract (boot loader 140, section 3). The real
 * AppModule is booted over HTTP with the real guards and services; only
 * PrismaService (the in-memory world in contract-world.ts, one row of every
 * model) and the JWT check are replaced. Paths are not hand-listed: the routes
 * come from the Nest router, the rows from prisma/schema.prisma.
 *
 * 1. A moved client is gone for the old coach (owner 4): after a real move
 *    (coach_id changes and deleteDraftsLeftByMove runs, as every move path
 *    does), no route the old coach can read answers with the client.
 * 2. History follows the client (139-13, 4b): the new coach reads the same
 *    client history whether a row was stamped by the old coach or the new one,
 *    except the old coach's chat, notes, nudges and tags, which never reach
 *    the new coach. A move deletes only drafts. No route offers a fresh start
 *    or a wipe.
 * 3. Coachless clients have no Roman (139-15): every Roman and AI-consent route
 *    a client may call answers 403 ROMAN_REQUIRES_COACH, except the routes the
 *    owner kept open (62x: delete prior data; withdraw; read the consent state).
 * 4. Safety alerts are never lost or merged (57q): an urgent push goes at once,
 *    an eating-disorder push waits until 08:00 and is still delivered, and no
 *    other push folds into a waiting safety push.
 *
 * KNOWN_GAPS lists what fails on main today, each with an id and a reason. A
 * gap is skipped; the guard at the bottom fails if the list grows, and fails
 * when a gap is fixed so its entry must be removed. Never add a gap to make
 * this file green: fix the path.
 */
import 'reflect-metadata';
import { Row, World, defaultFor, isRelation, parseSchema } from './contract-world';
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
import { ROMAN_REQUIRES_COACH } from '../../src/roman/roman-requires-coach';

jest.setTimeout(300_000);

interface Gap {
  id: string;
  rule: 1 | 2 | 3 | 4;
  key: string;
  reason: string;
}
// Fails on main today. May only shrink (KNOWN_GAPS_CEILING).
const KNOWN_GAPS: Gap[] = [];
const KNOWN_GAPS_CEILING = 0;
// Not a path of the rule, with the reason. May only shrink (EXEMPT_CEILING).
const EXEMPT: Array<{ rule: 1 | 2 | 3; key: string; reason: string }> = [];
const EXEMPT_CEILING = 0;

const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const OLD = uuid(1); // the coach the client left
const NEW = uuid(2); // the coach the client joined
const MOVED = uuid(3);
const COACHLESS = uuid(4);
const COACHED = uuid(5);
const ROW = uuid(6); // the id of the one stored row of every other model
const USERS: Array<[id: string, role: string, label: string]> = [
  [OLD, 'coach', 'old-coach'],
  [NEW, 'coach', 'new-coach'],
  [MOVED, 'student', 'moved'],
  [COACHLESS, 'student', 'coachless'],
  [COACHED, 'student', 'coached'],
];
// Rows that decide who coaches whom: no team or sub-coach seat is stored.
const AUTHORITY = new Set(['SubCoachAssignment', 'TeamSubCoachAssignment', 'SubCoachInvite']);
// The client's sharing switches, as they stand, belong to the current coach.
const CURRENT_COACH = new Set(['ClientCoachConsent']);
// Owner 4b: the old coach's chat, notes, nudges and tags stay with the old coach.
const PRIVATE_4B = new Set(['CoachMessage', 'CoachNudge', 'CoachClientTag']);
const PRIVATE_4B_MARKERS = ['s:CoachMessage.', 's:CoachNudge.', 's:CoachClientTag.', 's:CoachingSession.coach_notes_md'];
// Owner 17: a move deletes the drafts other coaches hold. Nothing else.
const MOVE_MAY_DELETE = new Set(['AIDraft', 'AiActionDraft', 'MessageDraft', 'ChurnIntervention']);

const { models, enums } = parseSchema();
const world = new World(models, enums);
type State = 'before' | 'moved' | 'moved-restamped';

/** One stored row of every model. `moved-restamped`: the client's rows carry the new coach. */
async function seed(state: State): Promise<void> {
  world.rows.clear();
  for (const [id, role, label] of USERS) {
    const m = models.get('User');
    if (!m) throw new Error('no User model');
    const row: Row = {};
    for (const f of m.fields.values()) {
      if (isRelation(f, models)) continue;
      const v = defaultFor(m, f, enums);
      row[f.name] = typeof v === 'string' && v.startsWith('s:') ? `${label}:${f.name}` : v;
    }
    const coach = id === MOVED ? (state === 'before' ? OLD : NEW) : id === COACHED ? NEW : null;
    Object.assign(row, { id, role, coach_id: coach, supabase_id: label, deleted_at: null, deletion_scheduled_at: null });
    world.table('User').push(row);
  }
  for (const m of models.values()) {
    if (m.name === 'User' || AUTHORITY.has(m.name)) continue;
    const fkTarget = new Map<string, string>();
    for (const f of m.fields.values()) if (isRelation(f, models) && f.fk) f.fk.forEach((k) => fkTarget.set(k, f.type));
    const row: Row = {};
    let clientRow = false;
    for (const f of m.fields.values()) {
      if (isRelation(f, models)) continue;
      const target = fkTarget.get(f.name);
      const coachSide = /coach|tenant/i.test(f.name);
      if (target === 'User' && !coachSide) clientRow = true;
      row[f.name] = target === 'User' ? (coachSide ? 'COACH' : MOVED) : target || f.isId ? ROW : defaultFor(m, f, enums);
    }
    const restamp = state === 'moved-restamped' && clientRow && !PRIVATE_4B.has(m.name);
    const coach = state === 'before' ? OLD : restamp || CURRENT_COACH.has(m.name) ? NEW : OLD;
    for (const k of Object.keys(row)) if (row[k] === 'COACH') row[k] = coach;
    world.table(m.name).push(row);
  }
  // The old coach's own inbox row about the client (the generic row is the client's).
  world.table('Notification').push({
    ...world.table('Notification')[0],
    id: uuid(7),
    user_id: OLD,
    payload: { client_id: MOVED },
    deep_link: `/coach/clients/${MOVED}`,
  });
  if (state !== 'before') await deleteDraftsLeftByMove(world.client as never, [MOVED], NEW);
}

interface Route {
  key: string;
  method: string;
  path: string;
  roles: string[];
}
const CLIENT_PARAM = /^(client|student)(_?id)?$|^(clientId|studentId)$/i;
function url(path: string): string {
  const segs = path.split('/');
  const filled = segs.map((s, i) => {
    if (!s.startsWith(':')) return s;
    const name = s.slice(1).replace(/\?$/, '');
    return CLIENT_PARAM.test(name) || (name === 'id' && /^(clients|students)$/.test(segs[i - 1] ?? '')) ? MOVED : ROW;
  });
  return `/api/${filled.join('/')}?client_id=${MOVED}&clientId=${MOVED}`;
}
const mentionsMoved = (t: string) => t.includes(MOVED) || t.includes('moved:');
const normal = (t: string) =>
  t.split(OLD).join('COACH').split(NEW).join('COACH').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/gen-\d+/g, 'gen');
const ok = (status: number) => status >= 200 && status < 300;
const gaps = (rule: number) => new Set(KNOWN_GAPS.filter((g) => g.rule === rule).map((g) => g.key));
const exempt = (rule: number) => new Set(EXEMPT.filter((e) => e.rule === rule).map((e) => e.key));
const unexpected = (rule: number, keys: string[]) => keys.filter((k) => !gaps(rule).has(k) && !exempt(rule).has(k));

let app: INestApplication;
let base = '';
let routes: Route[] = [];
const found = { leaks: [] as string[], hidden: [] as string[], private4b: [] as string[], roman: [] as string[], romanCoached: [] as string[] };
const outcomes: Record<string, string> = {};

async function call(user: string, method: string, path: string): Promise<{ status: number; text: string }> {
  try {
    const r = await fetch(`${base}${url(path)}`, {
      method,
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ content: 'Plan my week', message: 'Plan my week', surface: 'client' }),
      signal: AbortSignal.timeout(4000),
    });
    return { status: r.status, text: await r.text() };
  } catch {
    return { status: 0, text: '' };
  }
}

beforeAll(async () => {
  const ref = await Test.createTestingModule({ imports: [DiscoveryModule, AppModule] })
    .overrideProvider(PrismaService)
    .useValue(world.client)
    .overrideProvider(JwksVerifierService)
    .useValue({ verify: async (token: string) => ({ sub: token }), verifyForDeletionReceipt: async (token: string) => ({ sub: token }) })
    .compile();
  app = ref.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0, '127.0.0.1');
  // No cron or interval may touch the world between a seed and its call.
  const jobs = ref.get(SchedulerRegistry);
  jobs.getCronJobs().forEach((job) => void job.stop());
  jobs.getIntervals().forEach((name) => jobs.deleteInterval(name));
  jobs.getTimeouts().forEach((name) => jobs.deleteTimeout(name));
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const reflector = ref.get(Reflector);
  const scanner = ref.get(MetadataScanner);
  const seen = new Map<string, Route>();
  for (const w of ref.get(DiscoveryService).getControllers()) {
    if (!w.metatype || !w.instance) continue;
    const proto = Object.getPrototypeOf(w.instance) as Record<string, (...a: unknown[]) => unknown>;
    const prefixes = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, w.metatype) ?? '');
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name];
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (sub === undefined) continue;
      if (reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, w.metatype])) continue;
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

  // Rules 1 and 2: every route a coach can read.
  const coachReads = routes.filter(
    (r) => r.method === 'GET' && !/^(v1\/)?admin\b|^internal\b/.test(r.path) && !(r.roles.length && r.roles.every((x) => x === 'owner')),
  );
  for (const r of coachReads) {
    await seed('moved');
    const old = await call('old-coach', 'GET', r.path);
    if (ok(old.status) && mentionsMoved(old.text)) found.leaks.push(r.key);
    const before = await call('new-coach', 'GET', r.path);
    if (ok(before.status) && PRIVATE_4B_MARKERS.some((m) => before.text.includes(m))) found.private4b.push(r.key);
    await seed('moved-restamped');
    const after = await call('new-coach', 'GET', r.path);
    if (normal(before.text) !== normal(after.text) || before.status !== after.status) found.hidden.push(r.key);
    outcomes[r.key] = `old ${old.status}${found.leaks.includes(r.key) ? ' LEAK' : ''} | new ${before.status}->${after.status}`;
    if (found.leaks.includes(r.key)) outcomes[r.key] += ` | ${old.text.slice(Math.max(0, old.text.indexOf(MOVED) - 120), old.text.indexOf(MOVED) + 60)}`;
  }

  // Rule 3: every Roman and AI-consent route a client may call.
  for (const r of routes.filter((x) => /(^|\/)roman\b|^ai\/(?!gateway)|^me\/ai-consent/.test(x.path) && x.roles.includes('student'))) {
    await seed('moved');
    const res = await call('coachless', r.method, r.path);
    let code: unknown;
    try {
      code = (JSON.parse(res.text) as Row).code;
    } catch {
      code = undefined;
    }
    if (!(res.status === 403 && code === ROMAN_REQUIRES_COACH)) found.roman.push(r.key);
    outcomes[r.key] = `coachless ${res.status} ${String(code)}`;
    if (r.method === 'GET') {
      const coached = await call('coached', r.method, r.path);
      if (coached.text.includes(ROMAN_REQUIRES_COACH)) found.romanCoached.push(r.key);
    }
  }
  console.log(`product-rules contract: ${routes.length} routes\n${JSON.stringify(outcomes, null, 1)}`);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Rule 1: a moved client is gone for the old coach (owner 4)', () => {
  it('the router has the coach routes the rule covers (the harness is live)', () => {
    expect(routes.length).toBeGreaterThan(500);
    for (const k of ['GET /coach/clients', 'GET /coach/alerts', 'GET /notifications', 'GET /coach/clients/:id/summary'])
      expect(Object.keys(outcomes)).toContain(k);
  });

  it('no route the old coach can read answers with the moved client (404 or left out)', () => {
    expect(unexpected(1, found.leaks)).toEqual([]);
  });

  it('before the move the same routes do answer with the client (the check can fail)', async () => {
    await seed('before');
    const roster = await call('old-coach', 'GET', 'coach/clients');
    expect(roster.status).toBe(200);
    expect(mentionsMoved(roster.text)).toBe(true);
    await seed('moved');
    expect(mentionsMoved((await call('old-coach', 'GET', 'coach/clients')).text)).toBe(false);
  });
});

describe('Rule 2: history follows the client (139-13, owner 4b)', () => {
  it("the new coach reads the client's history whatever coach stamped it", () => {
    expect(unexpected(2, found.hidden)).toEqual([]);
  });

  it("the old coach's chat, notes, nudges and tags never reach the new coach", () => {
    expect(found.private4b).toEqual([]);
  });

  it('a move deletes only drafts: every other row about the client stays', async () => {
    await seed('before');
    const count = () => new Map([...world.rows].map(([m, rows]) => [m, rows.length]));
    const was = count();
    await deleteDraftsLeftByMove(world.client as never, [MOVED], NEW);
    const lost = [...count()].filter(([m, n]) => n < (was.get(m) ?? 0)).map(([m]) => m);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.filter((m) => !MOVE_MAY_DELETE.has(m))).toEqual([]);
  });

  it('no route offers an export step, a fresh start or a wipe on a move', () => {
    expect(routes.map((r) => r.key).filter((k) => /fresh|wipe|start-?over|start-?new|reset-history|clear-history/i.test(k))).toEqual([]);
  });
});

describe('Rule 3: coachless clients have no Roman (139-15, 62x)', () => {
  it('every Roman and AI-consent route answers a coachless client 403 ROMAN_REQUIRES_COACH', () => {
    expect(Object.keys(outcomes).filter((k) => k.includes('roman') || k.includes('/ai')).length).toBeGreaterThan(5);
    expect(unexpected(3, found.roman)).toEqual([]);
  });

  it('a client with a coach is never told Roman needs a coach', () => {
    expect(found.romanCoached).toEqual([]);
  });
});

// Rule 4 runs the real push outbox over the world, at 22:00 in New York.
const NIGHT = new Date('2026-10-13T02:00:00.000Z');
const MORNING = new Date('2026-10-13T12:00:00.000Z');
class PushAt extends PushDeliveryService {
  protected now(): Date {
    return NIGHT;
  }
}
function outbox(): PushAt {
  world.rows.clear();
  const svc = new PushAt(world.client as unknown as PrismaService);
  svc.autoDrain = false;
  return svc;
}
const alertPush = (alertId: string | null, urgent = false, body = `Safety alert ${alertId}`) => ({
  userId: NEW,
  kind: NotificationKind.COACH_ALERT,
  title: 'Coach alert',
  body,
  data: { alertId },
  dedupeKey: alertId ? `coach_alert:${alertId}` : null,
  collapseKey: `${NotificationKind.COACH_ALERT}:/coach/notifications`,
  urgent,
  timeZone: 'America/New_York',
});
const RULE4: Record<string, () => Promise<boolean>> = {
  'an urgent safety push goes at once': async () => {
    const r = await outbox().enqueue(alertPush('alert-urgent', true));
    return r.code === 'queued' && r.notBefore.getTime() === NIGHT.getTime();
  },
  'an eating-disorder push waits until 08:00 and is still delivered': async () => {
    const r = await outbox().enqueue(alertPush('alert-ed'));
    const [row] = world.table('PushOutbox');
    return r.code === 'deferred' && (row?.not_before as Date).getTime() === MORNING.getTime() && row?.status === 'pending';
  },
  'two safety alerts for one client are two pushes, never merged': async () => {
    const svc = outbox();
    await svc.enqueue(alertPush('alert-ed'));
    await svc.enqueue(alertPush('alert-ed-2'));
    return world.table('PushOutbox').map((r) => r.body).join('|') === 'Safety alert alert-ed|Safety alert alert-ed-2';
  },
  'another push never takes over a waiting safety push': async () => {
    const svc = outbox();
    await svc.enqueue(alertPush('alert-ed'));
    await svc.enqueue(alertPush(null, false, 'Ordinary alert'));
    const safety = world.table('PushOutbox').find((r) => r.dedupe_key === 'coach_alert:alert-ed');
    return safety?.body === 'Safety alert alert-ed' && world.table('PushOutbox').some((r) => r.body === 'Ordinary alert');
  },
  "Roman's urgent-medical and eating-disorder replies raise a coach alert": async () =>
    Object.values(NotificationKind).some((k) => /roman.*(urgent|eating|safety)/i.test(String(k))),
};

describe('Rule 4: safety alerts are never lost or merged (57q)', () => {
  for (const [name, holds] of Object.entries(RULE4)) {
    (gaps(4).has(name) ? it.skip : it)(name, async () => expect(await holds()).toBe(true));
  }
});

describe('Known gaps: skipped, and the list may only shrink', () => {
  for (const g of KNOWN_GAPS) it.skip(`${g.id} (rule ${g.rule}) ${g.key}: ${g.reason}`, () => undefined);

  it('the lists never grow', () => {
    expect(KNOWN_GAPS.length).toBeLessThanOrEqual(KNOWN_GAPS_CEILING);
    expect(EXEMPT.length).toBeLessThanOrEqual(EXEMPT_CEILING);
    expect(new Set(KNOWN_GAPS.map((g) => g.id)).size).toBe(KNOWN_GAPS.length);
  });

  it('a gap that is fixed leaves the list (remove its entry and lower the ceiling)', async () => {
    const still: Record<number, string[]> = { 1: found.leaks, 2: found.hidden, 3: found.roman };
    const rule4 = await Promise.all(Object.entries(RULE4).map(async ([k, holds]) => ((await holds()) ? null : k)));
    still[4] = rule4.filter((k): k is string => k !== null);
    expect(KNOWN_GAPS.filter((g) => !still[g.rule].includes(g.key)).map((g) => g.id)).toEqual([]);
    expect(EXEMPT.filter((e) => !still[e.rule].includes(e.key)).map((e) => e.key)).toEqual([]);
  });
});
