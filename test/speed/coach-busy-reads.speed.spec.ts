/**
 * SPEED-TEST-BE (owner pick 195-S3 op 1): the coach's six busiest screens at
 * the owner's own size, 1 coach x 45 clients x 90 days, on a real Postgres.
 *
 * The real AppModule answers over a real socket (real guards, real services,
 * real PrismaService on the database). Only the JWT signature check is
 * replaced, as in every booted-app spec here (jose is ESM-only under jest);
 * the auth guard still loads the coach row from the database on every call.
 * Every FEATURE_* switch is on, as v1 ships.
 *
 * Each read below is a call the phone makes when the screen opens (growth-
 * project-mobile main ad67c378; the file is named next to each screen). Each
 * read is called once to warm up, then 15 times timed. The test fails if any
 * timed call is not 200, if a read answers without the seeded data (so it
 * cannot pass by being empty), or if a read's median or worst timed call
 * passes half a second. It prints one table: screen, read, status, bytes,
 * median, worst.
 *
 * Runs only when SPEED_TEST_DATABASE_URL is set (the speed-test CI job, a
 * scratch Postgres with every migration applied) and refuses any host other
 * than localhost, so it can never seed a real database.
 */
import 'reflect-metadata';
import { appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import type { INestApplication } from '@nestjs/common';

const DB = process.env.SPEED_TEST_DATABASE_URL;
const BUDGET_MS = 500;
const WARMUP = 1;
const TIMED = 15;
const CLIENTS = 45;
const DAYS = 90;

function localOnly(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const run = DB !== undefined && localOnly(DB);
if (!run) {
  console.log(
    DB === undefined
      ? 'coach-busy-reads speed test skipped: SPEED_TEST_DATABASE_URL is unset (it runs in the speed-test CI job).'
      : 'coach-busy-reads speed test skipped: SPEED_TEST_DATABASE_URL is not a localhost database.',
  );
}

// Every switch on, as v1 ships (the all-switches-on job's rule): each FEATURE_*
// key in the desired-state file, except lists of ids. Set before AppModule loads.
function turnEverySwitchOn(): string[] {
  const file = join(__dirname, '..', '..', '.github', 'fly-env-desired-state.json');
  const d = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  const names = new Set<string>();
  for (const section of ['flags', 'gates', 'excluded'])
    for (const k of Object.keys(d[section] || {})) if (/^FEATURE_[A-Z0-9_]+$/.test(k) && !/_(ALLOWLIST|IDS)$/.test(k)) names.add(k);
  for (const n of names) process.env[n] = 'true';
  return [...names];
}

// Seeded ids: fixed so the checks can look for them in each answer.
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const COACH_ID = '5bee0000-0000-4000-8000-000000000000';
const COACH_SUB = 'speed-coach-supabase-id';
const TOKEN = 'speed-coach-token';
const clientId = (i: number) => `5bee0000-0000-4000-8000-${pad(i + 1, 12)}`;
const CLIENT_IDS = Array.from({ length: CLIENTS }, (_, i) => clientId(i));
const FOOD_NAME = 'Speed test oats';
const DAY_MS = 86_400_000;

type Check = (body: string) => string | null; // null = the answer holds the seeded data
interface Read {
  screen: string;
  path: string;
  check: Check;
}

const idsIn = (body: string) => CLIENT_IDS.filter((id) => body.includes(id)).length;
const allClients: Check = (b) => (idsIn(b) >= CLIENTS ? null : `has ${idsIn(b)} of ${CLIENTS} seeded clients`);
const someClient: Check = (b) => (idsIn(b) > 0 ? null : 'has none of the seeded clients');
const ok: Check = () => null;
const field = (name: string, want: number): Check => (b) => {
  const got = (JSON.parse(b) as Record<string, unknown>)[name];
  return got === want ? null : `${name} is ${JSON.stringify(got)}, want ${want}`;
};
const contains = (s: string): Check => (b) => (b.includes(s) ? null : `does not mention ${s}`);
const listed = (name: string): Check => (b) => {
  const got = (JSON.parse(b) as Record<string, unknown>)[name];
  return Array.isArray(got) && got.length > 0 ? null : `${name} is ${JSON.stringify(got)}, want a non-empty list`;
};

function reads(now: Date): Read[] {
  const C = clientId(0);
  const today = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const to = now.toISOString();
  const cFrom = new Date(now.getTime() - 60 * DAY_MS).toISOString();
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  return [
    // Needs you: the Home tile and list (home-v11/useCoachHomeV11.ts, homeDay.ts, lookup/ClientLookupScreen.tsx view 'needs').
    { screen: 'Needs you', path: '/coach/command-center/overview?include=home', check: field('roster_size', CLIENTS) },
    { screen: 'Needs you', path: '/coach/clients?status=active&take=50', check: allClients },
    { screen: 'Needs you', path: '/coach/messages/unread-count', check: ok },
    { screen: 'Needs you', path: '/users/blocks', check: ok },
    // LO-1224 probe: the Home (Needs you) on-open reads the PR leaves out (mobile c26961a3 useCoachHomeV11.ts:99-106, :34-35, planEndedData.ts:62)
    { screen: 'Needs you', path: '/coach/command-center/ltv-metrics', check: ok },
    { screen: 'Needs you', path: '/coach/command-center/at-risk', check: ok },
    { screen: 'Needs you', path: '/ai/gateway/drafts?status=pending', check: ok },
    { screen: 'Needs you', path: '/notifications/unread-count', check: ok },
    { screen: 'Needs you', path: '/v1/coach/churned-clients?take=50', check: ok },
    // Client list (lookup/ClientLookupScreen.tsx): the active and archived pages and the unread counts.
    { screen: 'Client list', path: '/coach/clients?status=active&take=50', check: allClients },
    { screen: 'Client list', path: '/coach/clients?status=archived&take=50', check: ok },
    { screen: 'Client list', path: '/coach/messages/unread-count', check: ok },
    { screen: 'Client list', path: '/v1/coach/churned-clients?take=50', check: ok }, // LO-1224 probe: ClientLookupScreen.tsx:107 at 45 clients
    // Inbox (MessagesScreen.tsx, CoachInboxV2.tsx): the first page of threads and the unread counts.
    { screen: 'Inbox', path: '/coach/messages/inbox?limit=50', check: allClients },
    { screen: 'Inbox', path: '/coach/messages/unread-count', check: ok },
    // One client's file (ClientDetailScreen.tsx, client-detail/useThisWeek.ts, useClientDetailData.ts).
    { screen: 'Client file', path: `/coach/clients/${C}/summary?date=${today}`, check: ok },
    { screen: 'Client file', path: `/coach/clients/${C}/week`, check: listed('assignments') },
    { screen: 'Client file', path: `/coach/clients/${C}/timeline?days=8`, check: contains(FOOD_NAME) },
    { screen: 'Client file', path: `/coach/clients/${C}/macros/current`, check: contains('calories_kcal') },
    { screen: 'Client file', path: `/coach/clients/${C}/timeline?days=90`, check: contains(FOOD_NAME) },
    // Money (money/MoneyScreen.tsx); payouts and the Stripe status call Stripe and are not timed here.
    { screen: 'Money', path: `/v1/coach/money/summary?${q({ from, to, compare_from: cFrom, compare_to: from })}`, check: ok },
    { screen: 'Money', path: '/v1/coach/money/attention', check: ok },
    { screen: 'Money', path: '/v1/coach/money/charges?filter=all&limit=5', check: ok },
    { screen: 'Money', path: '/coach/connect/metrics', check: field('active_clients', CLIENTS) },
    { screen: 'Money', path: '/coach/connect/status', check: ok }, // LO-1224 probe: MoneyScreen.tsx:222, no Stripe call for a ready account
    { screen: 'Money', path: '/coach/ai/budget', check: ok }, // LO-1224 probe: MoneyScreen.tsx:229
    // Calendar week (CoachBookingInboxScreen.tsx via hooks/useCalendar.ts).
    { screen: 'Calendar', path: '/scheduling/sessions?limit=50&status=requested', check: someClient },
    { screen: 'Calendar', path: '/scheduling/sessions?limit=50&status=scheduled%2Cpending_provider', check: someClient },
    { screen: 'Calendar', path: '/scheduling/sessions?limit=20&scope=past&status=scheduled', check: someClient },
  ];
}

// ─── The 45 x 90 world ──────────────────────────────────────────────────────
type Db = Record<string, { createMany: (a: { data: unknown[] }) => Promise<unknown>; create: (a: { data: unknown }) => Promise<unknown> }>;

async function many(db: Db, model: string, rows: unknown[]): Promise<number> {
  for (let i = 0; i < rows.length; i += 1000) await db[model].createMany({ data: rows.slice(i, i + 1000) });
  return rows.length;
}

async function seed(db: Db, now: Date): Promise<Record<string, number>> {
  const day = (d: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - d * DAY_MS);
  const at = (d: number, h: number) => new Date(now.getTime() - d * DAY_MS - h * 3_600_000);
  const created = new Date(now.getTime() - (DAYS + 5) * DAY_MS);
  const dob = new Date('1990-06-15T00:00:00Z');

  await db.user.create({ data: { id: COACH_ID, supabase_id: COACH_SUB, email: 'speed-coach@example.test', name: 'Speed Coach', role: 'coach', created_at: created } });
  const counts: Record<string, number> = {};
  counts.clients = await many(db, 'user', CLIENT_IDS.map((id, i) => ({
    id, supabase_id: `speed-client-${i}`, email: `speed-client-${i}@example.test`, name: `Client ${pad(i + 1, 2)}`, role: 'student', coach_id: COACH_ID, created_at: created,
  })));
  await many(db, 'userProfile', [COACH_ID, ...CLIENT_IDS].map((user_id) => ({ user_id, date_of_birth: dob })));
  const food = (await db.foodItem.create({ data: { name: FOOD_NAME, serving_description: '1 bowl', serving_size_grams: 80, calories: 300, protein_g: 10, carbs_g: 54, fat_g: 6 } })) as { id: string };

  const meals = ['breakfast', 'lunch', 'dinner'] as const;
  // The coach's program: a strength day assigned on each training day, 90 days back to a week ahead.
  const plan = (await db.workoutPlan.create({ data: { coach_id: COACH_ID, name: 'Full body', type: 'strength' } })) as { id: string };
  const rows: Record<string, unknown[]> = { loggedFoodEntry: [], waterLog: [], weightLog: [], workoutSession: [], checkIn: [], coachMessage: [], clientSignal: [], coachingSession: [], clientWorkoutAssignment: [], macroTarget: [] };
  CLIENT_IDS.forEach((uid, c) => {
    rows.macroTarget.push({ client_id: uid, coach_id: COACH_ID, calories_kcal: 2200, protein_g: 160, carbs_g: 230, fats_g: 70, effective_from: created, created_at: created });
    for (let d = -7; d < DAYS; d++)
      if (((d % 7) + 7) % 7 !== 6)
        rows.clientWorkoutAssignment.push({ workout_plan_id: plan.id, client_id: uid, assigned_by_coach_id: COACH_ID, scheduled_for: at(d, 0), completed_at: d > 0 ? at(d, -1) : null });
    for (let d = 0; d < DAYS; d++) {
      meals.forEach((meal_type, m) => rows.loggedFoodEntry.push({ user_id: uid, date: day(d), meal_type, food_item_id: food.id, quantity_multiplier: 1, logged_at: at(d, 12 - m * 4) }));
      for (let w = 0; w < 4; w++) rows.waterLog.push({ user_id: uid, amount_ml: 500, logged_at: at(d, 14 - w * 3), created_at: at(d, 14 - w * 3) });
      rows.weightLog.push({ user_id: uid, date: day(d), weight_lbs: 180 - d * 0.05 + (c % 7), logged_at: at(d, 14) });
      if (d % 7 !== 6) rows.workoutSession.push({ user_id: uid, date: day(d), workout_name: 'Full body', workout_type: 'strength', duration_minutes: 50, created_at: at(d, 10) });
      rows.checkIn.push({ user_id: uid, coach_id: COACH_ID, date: day(d), mood: 4, energy: 4, soreness: 2, sleep_hours: 7.5, logged_at: at(d, 15), reviewed_by_coach: d > 2, coach_reviewed_at: d > 2 ? at(d, 2) : null });
      rows.coachMessage.push({ coach_id: COACH_ID, client_id: uid, sender_id: uid, body: `Day ${d} update from client ${c + 1}`, created_at: at(d, 9), read_at: d === 0 ? null : at(d, 8) });
      rows.coachMessage.push({ coach_id: COACH_ID, client_id: uid, sender_id: COACH_ID, body: `Nice work on day ${d}`, created_at: at(d, 7), read_at: d === 0 ? null : at(d, 6) });
      for (const signal_type of ['meal_logged', 'meal_logged', 'meal_logged', 'weight_logged', 'checkin_streak', 'message_sent'])
        rows.clientSignal.push({ user_id: uid, signal_type, value: 1, recorded_at: at(d, 11) });
      if (d % 7 !== 6) rows.clientSignal.push({ user_id: uid, signal_type: 'workout_logged', value: 4000, recorded_at: at(d, 10) });
    }
    // One call a week for 13 weeks behind, plus this week's: one confirmed, one requested.
    for (let wk = 1; wk <= 13; wk++) {
      const start = new Date(now.getTime() - wk * 7 * DAY_MS + c * 3_600_000);
      rows.coachingSession.push({ coach_id: COACH_ID, client_id: uid, status: 'scheduled', start_at: start, end_at: new Date(start.getTime() + 1_800_000), title: 'Weekly call', approved_at: start });
    }
    // One coach cannot hold two live calls at once (CoachingSession_no_overlapping_active_booking): an hour apart.
    const soon = new Date(now.getTime() + DAY_MS + c * 3_600_000);
    rows.coachingSession.push({ coach_id: COACH_ID, client_id: uid, status: 'scheduled', start_at: soon, end_at: new Date(soon.getTime() + 1_800_000), title: 'Weekly call', approved_at: now });
    const asked = new Date(now.getTime() + 3 * DAY_MS + c * 3_600_000);
    rows.coachingSession.push({ coach_id: COACH_ID, client_id: uid, status: 'requested', start_at: asked, end_at: new Date(asked.getTime() + 1_800_000), title: 'Extra call', request_expires_at: new Date(now.getTime() + 2 * DAY_MS) });
  });
  for (const [model, list] of Object.entries(rows)) counts[model] = await many(db, model, list);

  // Money: one monthly plan per client, three paid months each, on a Connect account.
  await db.connectAccount.create({ data: { coach_user_id: COACH_ID, stripe_account_id: 'acct_speedtest0000', charges_enabled: true, payouts_enabled: true, details_submitted: true } });
  const pkg = (await db.coachPackage.create({ data: { coach_id: COACH_ID, name: 'Monthly coaching', amount_cents: 20000, billing_type: 'recurring', interval: 'month' } })) as { id: string };
  const purchases = CLIENT_IDS.map((uid, c) => ({
    id: `5bee0001-0000-4000-8000-${pad(c + 1, 12)}`, client_user_id: uid, coach_user_id: COACH_ID, package_id: pkg.id, amount_cents: 20000, billing_type: 'recurring',
    stripe_checkout_session_id: `cs_speed_${c}`, stripe_subscription_id: `sub_speed_${c}`, status: 'active', entitlement_active: true,
    current_period_end: new Date(now.getTime() + (c % 30) * DAY_MS), idempotency_key: `speed-purchase-${c}`, created_at: at(88, c % 24),
  }));
  counts.clientPurchase = await many(db, 'clientPurchase', purchases);
  counts.splitLedgerEntry = await many(db, 'splitLedgerEntry', purchases.flatMap((p, c) => [0, 30, 60].map((d) => ({
    purchase_id: p.id, kind: 'destination', payee_user_id: COACH_ID, payee_stripe_account_id: 'acct_speedtest0000', amount_cents: 18000, status: 'posted',
    stripe_charge_id: `ch_speed_${c}_${d}`, idempotency_key: `speed-ledger-${c}-${d}`, posted_at: at(d + 1, c % 24), created_at: at(d + 1, c % 24),
  }))));
  return counts;
}

// ─── Timing ─────────────────────────────────────────────────────────────────
interface Row extends Read {
  status: number;
  bytes: number;
  median: number;
  worst: number;
  warmWorst: number;
  problem: string | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

(run ? describe : describe.skip)('coach busy reads at 45 clients x 90 days (195-S3)', () => {
  let app: INestApplication;
  let base = '';
  let counts: Record<string, number> = {};
  const results: Row[] = [];
  const now = new Date();

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.DIRECT_URL = DB;
    process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET ||= randomBytes(32).toString('hex');
    // The limiter is not what is timed: 21 reads x 18 calls in a few seconds.
    process.env.RATELIMIT_AUTHED_PER_MIN = '10000';
    process.env.COACH_CMD_CENTER_PER_MIN = '1000';
    const switches = turnEverySwitchOn();
      console.log(`FEATURE_* switches on: ${switches.length}`);

    const { ValidationPipe } = require('@nestjs/common');
    const { Test } = require('@nestjs/testing');
    const { SchedulerRegistry } = require('@nestjs/schedule');
    const { AppModule } = require('../../src/app.module');
    const { JwksVerifierService } = require('../../src/auth/jwks.service');
    const { PrismaService } = require('../../src/prisma.service');
    const { HttpExceptionFilter } = require('../../src/filters/http-exception.filter');
    const { ThrottlerExceptionFilter } = require('../../src/filters/throttler-exception.filter');
    const { CacheControlInterceptor } = require('../../src/common/cache-control.interceptor');
    const { MetricsService } = require('../../src/observability/metrics.service');
    const { featureFlagNotFoundMiddleware } = require('../../src/common/feature-flag/feature-flag-not-found.middleware');

    const verify = async (token: string) => {
      if (token !== TOKEN) throw new Error('unknown speed-test token');
      return { sub: COACH_SUB };
    };
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JwksVerifierService)
      .useValue({ verify, verifyForDeletionReceipt: verify })
      .compile();
    // The request pipeline main.ts builds, minus Sentry, metrics export, Swagger and the
    // helmet response headers (headers only; no read depends on them).
    app = ref.createNestApplication({ rawBody: true, logger: ['error'] });
    app.use(featureFlagNotFoundMiddleware);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter(), new ThrottlerExceptionFilter(app.get(MetricsService, { strict: false })));
    app.useGlobalInterceptors(new CacheControlInterceptor());
    app.setGlobalPrefix('api');
    await app.init();
    // No cron or interval may run against the seeded rows while they are timed.
    const jobs = ref.get(SchedulerRegistry);
    jobs.getCronJobs().forEach((job: { stop: () => void }) => void job.stop());
    jobs.getIntervals().forEach((name: string) => jobs.deleteInterval(name));
    jobs.getTimeouts().forEach((name: string) => jobs.deleteTimeout(name));

    const db = app.get(PrismaService) as unknown as Db & { $executeRawUnsafe: (sql: string) => Promise<unknown> };
    counts = await seed(db, now);
    await db.$executeRawUnsafe('ANALYZE');
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;

    for (const r of reads(now)) {
      const call = async () => {
        const t0 = performance.now();
        const res = await fetch(base + r.path, { headers: { authorization: `Bearer ${TOKEN}` } });
        const body = await res.text();
        return { ms: performance.now() - t0, status: res.status, body };
      };
      const warm: number[] = [];
      for (let i = 0; i < WARMUP; i++) warm.push((await call()).ms);
      const times: number[] = [];
      let last = { ms: 0, status: 0, body: '' };
      let problem: string | null = null;
      for (let i = 0; i < TIMED; i++) {
        last = await call();
        times.push(last.ms);
        if (last.status !== 200 && !problem) problem = `answered ${last.status}: ${last.body.slice(0, 200)}`;
      }
      if (!problem) problem = r.check(last.body);
      results.push({ ...r, status: last.status, bytes: Buffer.byteLength(last.body), median: median(times), worst: Math.max(...times), warmWorst: Math.max(...warm), problem });
    }

    const lines = [
      `Coach busy reads, 1 coach x ${CLIENTS} clients x ${DAYS} days, real Postgres; budget ${BUDGET_MS} ms for the median and the worst of ${TIMED} timed calls, after ${WARMUP} warm-up call.`,
      `Seeded rows: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
      '',
      '| Screen | Read (GET /api...) | Status | Bytes | Median ms | Worst ms | Warm-up ms | Result |',
      '|---|---|---|---|---|---|---|---|',
      ...results.map((x) => `| ${x.screen} | ${x.path.replace(clientId(0), ':id').replace(/\?from=.*$/, '?from=..&to=..&compare_from=..&compare_to=..')} | ${x.status} | ${x.bytes} | ${x.median.toFixed(1)} | ${x.worst.toFixed(1)} | ${x.warmWorst.toFixed(1)} | ${x.problem ? `FAIL: ${x.problem}` : x.median > BUDGET_MS || x.worst > BUDGET_MS ? 'FAIL: over budget' : 'ok'} |`),
    ];
      console.log(lines.join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }, 600_000);

  afterAll(async () => {
    await app?.close();
  });

  it('seeds 45 clients with 90 days of workouts, food, water, weight, check-ins and messages', () => {
    expect(counts.clients).toBe(CLIENTS);
    expect(counts.loggedFoodEntry).toBe(CLIENTS * DAYS * 3);
    expect(counts.waterLog).toBe(CLIENTS * DAYS * 4);
    expect(counts.weightLog).toBe(CLIENTS * DAYS);
    expect(counts.checkIn).toBe(CLIENTS * DAYS);
    expect(counts.coachMessage).toBe(CLIENTS * DAYS * 2);
    expect(counts.workoutSession).toBeGreaterThan(CLIENTS * 70);
    expect(counts.clientWorkoutAssignment).toBeGreaterThan(CLIENTS * 80);
    expect(counts.macroTarget).toBe(CLIENTS);
  });

  it('times every read of the six screens', () => {
    expect(new Set(results.map((r) => r.screen))).toEqual(new Set(['Needs you', 'Client list', 'Inbox', 'Client file', 'Money', 'Calendar']));
    expect(results).toHaveLength(reads(now).length);
  });

  it('every read answers 200 with the seeded data in it', () => {
    expect(results.filter((r) => r.problem).map((r) => `${r.screen} ${r.path}: ${r.problem}`)).toEqual([]);
  });

  it(`every read's median and worst timed call are within ${BUDGET_MS} ms`, () => {
    const slow = results.filter((r) => r.median > BUDGET_MS || r.worst > BUDGET_MS);
    expect(slow.map((r) => `${r.screen} ${r.path}: median ${r.median.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms`)).toEqual([]);
  });
});
