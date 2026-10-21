/**
 * RENEWAL-BE (20270502008100): the plan-renewal sequence on real Postgres
 * (owner #RENEWAL-PUSH: Day 0 and Day 1 pop-ups, one Day 7 app notification
 * with two buttons, the client's local days). The real PlanRenewalService
 * sweep runs on the superuser connection, as the API does; the push enqueue
 * is recorded (the outbox has its own suites). Row access runs as the API
 * role `authenticated` (no RLS bypass) on the replayed chain; every 0 comes
 * right after a 1 for the same caller on a row of the same kind.
 * Coach K coaches A, B, E, G, I, W, Y and the excluded clients; coach L
 * coaches C; H is TGP's house coach (HOUSE_COACH_USER_ID) and coaches Q.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { PlanRenewalService } from '../../src/checkout/plan-renewal/plan-renewal.service';
import { planRenewalPushStillDue, readPlanRenewal } from '../../src/checkout/plan-renewal/plan-renewal.state';
import { PLAN_RENEWAL_DAY_MS } from '../../src/checkout/plan-renewal/plan-renewal.cadence';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { stub } from '../utils/trial-fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('plan-renewal-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const HOUR = 60 * 60 * 1000;
const DAY = PLAN_RENEWAL_DAY_MS;

(DB_URL ? describe : describe.skip)('RENEWAL-BE: plan renewal sequence', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  type Push = { user_id: string; kind: string; deep_link?: string; dedupe_key?: string | null; data?: Record<string, string> };
  const pushes: Push[] = [];
  const notifications = { sendPush: jest.fn(async (input: Push) => { pushes.push(input); return null; }) };
  const service = new PlanRenewalService(prisma, stub<NotificationsService>(notifications));
  const keys = [...'KLHABCEFGIRDVXZOPQWY'];
  const u: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const supa: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = Object.fromEntries(
    [...'ABEFGIRDVXZOPWY'].map((k) => [k, 'K']).concat([['C', 'L'], ['Q', 'H']]),
  );
  const isCoach = (k: string) => 'KLH'.includes(k);
  // Noon UTC today: 07:00-08:00 in New York (A's zone), so every offset below lands on a known local day.
  const T0 = Math.floor(Date.now() / DAY) * DAY + 12 * HOUR;
  const at = (ms: number) => new Date(T0 + ms);
  const sweep = (ms: number) => service.runSweep(at(ms));
  const env = { flag: process.env.FEATURE_PLAN_RENEWAL, house: process.env.HOUSE_COACH_USER_ID };

  const pushesTo = (who: string) => pushes.filter((p) => p.user_id === u[who]);
  const rows = (who: string) => prisma.planRenewal.findMany({ where: { client_user_id: u[who] } });
  const row = async (who: string) => (await rows(who))[0];
  const view = (who: string, ms = 0, coach?: string) => readPlanRenewal(prisma, u[who], coach ? u[coach] : undefined, at(ms));

  let n = 0;
  const purchase = async (who: string, fields: Record<string, unknown>) => {
    const id = randomUUID();
    const pkg = randomUUID();
    n += 1;
    await prisma.coachPackage.create({ data: { id: pkg, coach_id: u[coachOf[who]], name: 'Coaching', amount_cents: 15000 } });
    await prisma.clientPurchase.create({
      data: {
        id, client_user_id: u[who], coach_user_id: u[coachOf[who]], package_id: pkg, amount_cents: 15000,
        stripe_checkout_session_id: `cs-renew-${id}`, idempotency_key: `idem-renew-${id}-${n}`, ...fields,
      },
    });
    return id;
  };
  const packageRanOut = (who: string, endedMsAgo: number, extra: Record<string, unknown> = {}) =>
    purchase(who, { billing_type: 'one_time', status: 'paid', entitlement_active: true, access_expires_at: at(-endedMsAgo), ...extra });

  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: supa[who], role: 'authenticated' }));
      return query(tx);
    });
  /** `owner`'s renewal rows that `who` reads. */
  const seen = async (who: string, owner: string) => (await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "PlanRenewal" WHERE "client_user_id" = $1`, u[owner])))[0].n;
  const api = (who: string, sql: string, ...params: string[]) => as(who, (tx) => tx.$executeRawUnsafe(sql, ...params))
    .then((count) => count, (e: unknown) => /Code: `([0-9A-Z]{5})`/.exec(String(e))?.[1] ?? 'refused');

  beforeAll(async () => {
    process.env.FEATURE_PLAN_RENEWAL = 'true';
    process.env.HOUSE_COACH_USER_ID = u.H;
    const names: Record<string, string> = { K: 'Kim Coach', L: 'Lee Coach', H: 'Hal House', A: 'Ann Client' };
    for (const k of keys) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${supa[k]}, ${`renew-${u[k]}@example.test`}, ${names[k] ?? `Person ${k}`},
          ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    // A lives in New York (the zone the phone supplied); everyone else's zone is unknown (UTC days).
    await prisma.notificationPreferences.create({
      data: { user_id: u.A, timezone: 'America/New_York', timezone_updated_at: at(-30 * DAY) },
    });
    // A once had a card declined at checkout (a one-off attempt, never a plan): it does not count as a failed payment.
    await purchase('A', { billing_type: 'one_time', status: 'payment_failed', entitlement_active: false, created_at: at(-40 * DAY) });
    await packageRanOut('A', HOUR);
    // B: a free trial cancelled at period end (counts as ended, ruling 6325498308); the trial ended two hours ago.
    await purchase('B', { billing_type: 'recurring', status: 'canceled', entitlement_active: false, cancel_at_period_end: true,
      trial_days: 14, trial_started_at: at(-14 * DAY), trial_ends_at: at(-2 * HOUR), canceled_at: at(-5 * DAY), current_period_end: at(-2 * HOUR) });
    await packageRanOut('C', HOUR);
    await packageRanOut('Q', HOUR);
    // E: first seen on its local Day 8 (it ended 7 days 23 hours ago, at 13:00 UTC): its Day 7 is gone.
    await packageRanOut('E', 7 * DAY + 23 * HOUR);
    // G: cancelled at period end (the period ended an hour ago). LO B1: a card decline months ago was recovered
    // (resolved_at kept when the cancel relabelled the cycle abandoned).
    const g = await purchase('G', { billing_type: 'recurring', status: 'canceled', entitlement_active: false, cancel_at_period_end: true,
      canceled_at: at(-10 * DAY), current_period_end: at(-HOUR) });
    await prisma.dunningState.create({ data: { purchase_id: g, status: 'abandoned', resolved_at: at(-60 * DAY) } });
    // LS B2: I was cancelled at once 20 days ago; the unused period's old end passed yesterday.
    await purchase('I', { billing_type: 'recurring', status: 'canceled', entitlement_active: false,
      canceled_at: at(-20 * DAY), current_period_end: at(-DAY) });
    // LS B1: W and Y renewed a weekly package; the replacement was active until an hour ago. Both orders.
    await packageRanOut('W', 7 * DAY + HOUR, { created_at: at(-14 * DAY) });
    await packageRanOut('W', HOUR, { created_at: at(-7 * DAY) });
    await packageRanOut('Y', HOUR, { created_at: at(-14 * DAY) });
    await packageRanOut('Y', 7 * DAY + HOUR, { created_at: at(-7 * DAY) });
    // Never a sequence: a failed payment (dunning owns it), a refund, a dispute, a revoked grant,
    // an archived client, a deleting account, a plan that ended 9 days ago, a client with another live plan.
    const failed = await purchase('F', { billing_type: 'recurring', status: 'canceled', entitlement_active: false,
      cancel_at_period_end: true, canceled_at: at(-DAY), current_period_end: at(-HOUR) });
    await prisma.dunningState.create({ data: { purchase_id: failed, status: 'abandoned' } });
    const refunded = await packageRanOut('R', HOUR);
    await prisma.chargeRefund.create({ data: { purchase_id: refunded, stripe_refund_id: `re-${refunded}`, stripe_charge_id: 'ch', amount_cents: 100 } });
    const disputed = await packageRanOut('D', HOUR);
    await prisma.chargeDispute.create({ data: { purchase_id: disputed, stripe_dispute_id: `dp-${disputed}`, stripe_charge_id: 'ch', amount_cents: 100 } });
    await packageRanOut('V', 2 * DAY);
    // The coach revoked V's newer grant.
    await purchase('V', { billing_type: 'one_time', status: 'revoked', entitlement_active: false, created_at: at(1000) });
    await packageRanOut('X', HOUR);
    await prisma.user.update({ where: { id: u.X }, data: { archived_at: at(-HOUR) } });
    await packageRanOut('Z', HOUR);
    await prisma.user.update({ where: { id: u.Z }, data: { deletion_scheduled_at: at(DAY) } });
    await packageRanOut('O', 9 * DAY);
    await packageRanOut('P', HOUR);
    await purchase('P', { billing_type: 'recurring', status: 'active', entitlement_active: true, access_expires_at: at(20 * DAY) });
  });
  afterAll(async () => {
    for (const [name, before] of [['FEATURE_PLAN_RENEWAL', env.flag], ['HOUSE_COACH_USER_ID', env.house]] as const) {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
    await prisma.$disconnect();
  });

  it('runs as a role that does not bypass row security, on a table with RLS forced', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    expect(await prisma.$queryRaw`SELECT relrowsecurity AND relforcerowsecurity AS forced FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = 'PlanRenewal'`).toEqual([{ forced: true }]);
  });

  it('flag off: a sweep opens and sends nothing', async () => {
    process.env.FEATURE_PLAN_RENEWAL = 'false';
    expect(await sweep(0)).toEqual({ opened: 0, pushed: 0, stopped: 0 });
    expect(await prisma.planRenewal.count({ where: { client_user_id: { in: Object.values(u) } } })).toBe(0);
    expect(await planRenewalPushStillDue(prisma, u.A)).toBe(false);
    process.env.FEATURE_PLAN_RENEWAL = 'true';
  });

  it('Day 0: plans that ended normally open a sequence and show the pop-up; no app notification', async () => {
    await sweep(0);
    const opened = await prisma.planRenewal.findMany({ where: { client_user_id: { in: Object.values(u) } }, select: { client_user_id: true } });
    expect(opened.map((r) => keys.find((k) => u[k] === r.client_user_id)).sort()).toEqual(['A', 'B', 'C', 'E', 'G', 'Q', 'W', 'Y']);
    expect(pushes).toEqual([]);
    const house = { id: u.H, first_name: 'Hal' };
    expect(await view('A')).toEqual({ state: 'ended', ended_at: at(-HOUR).toISOString(), popup_due: true, popup_step: 0,
      coach: { id: u.K, first_name: 'Kim' }, house_coach: house });
    // The house coach is never offered to the house coach's own client.
    expect(await view('Q')).toMatchObject({ state: 'ended', popup_step: 0, coach: { id: u.H }, house_coach: null });
    expect((await view('C')).house_coach).toEqual(house);
    // LO B1: a recovered card decline never blocks; LS B2: an immediate cancel keeps its own (old) end.
    expect([(await view('G')).popup_due, (await view('I')).state]).toEqual([true, 'none']);
    // E is on its local Day 8: no pop-up.
    expect(await view('E')).toMatchObject({ state: 'ended', popup_due: false, popup_step: null });
    for (const who of 'FRDXZOPI') expect([who, await view(who)]).toEqual([who, expect.objectContaining({ state: 'none' })]);
    expect(await view('V')).toEqual({ ...(await view('F')), state: 'revoked', coach: { id: u.K, first_name: expect.any(String) } });
    // Asking about another coach than the current one says nothing.
    expect((await view('A', 0, 'L')).state).toBe('none');
  });

  it('LS B1: a renewed weekly package opens one sequence, for the latest end, in either order, never the older one', async () => {
    for (const who of 'WY') {
      const [only] = await rows(who);
      expect([who, (await rows(who)).length, only.ended_at.toISOString()]).toEqual([who, 1, at(-HOUR).toISOString()]);
    }
    await sweep(HOUR);
    await sweep(2 * HOUR);
    expect([(await rows('W')).length, (await rows('Y')).length, pushes.length]).toEqual([1, 1, 0]);
  });

  it('the pop-up ack: only a reached pop-up day, idempotent, and only the caller\'s own row', async () => {
    await expect(service.ackPopup(u.A, 3, at(0))).rejects.toMatchObject({ response: { code: 'PLAN_RENEWAL_STEP_INVALID' } });
    await expect(service.ackPopup(u.A, 1, at(0))).rejects.toMatchObject({ response: { code: 'PLAN_RENEWAL_STEP_NOT_REACHED' } });
    await expect(service.ackPopup(u.F, 0, at(0))).rejects.toMatchObject({ response: { code: 'PLAN_RENEWAL_NOT_FOUND' } });
    expect((await service.ackPopup(u.A, 0, at(0))).renewal).toMatchObject({ state: 'ended', popup_due: false, popup_step: null });
    expect((await service.ackPopup(u.A, 0, at(0))).renewal).toMatchObject({ popup_due: false });
    expect((await view('B')).popup_due).toBe(true);
  });

  it('Day 1 shows its own pop-up; days the client skipped are not stacked; nothing is sent before Day 7', async () => {
    expect(await view('A', DAY)).toMatchObject({ popup_due: true, popup_step: 1 });
    expect((await service.ackPopup(u.A, 1, at(DAY))).renewal).toMatchObject({ popup_due: false });
    // B never opened the app on Day 0 or Day 1: on Day 2 there is no pop-up to catch up on.
    expect(await view('B', 2 * DAY)).toMatchObject({ state: 'ended', popup_due: false, popup_step: null });
    // B buys again from coach K: the sequence stops at once, and a push still queued would not be sent.
    expect(await planRenewalPushStillDue(prisma, u.B)).toBe(true);
    await purchase('B', { billing_type: 'recurring', status: 'active', entitlement_active: true, access_expires_at: at(40 * DAY) });
    expect([(await view('B', DAY)).state, await planRenewalPushStillDue(prisma, u.B)]).toEqual(['none', false]);
    for (const ms of [DAY, 3 * DAY, 6 * DAY + 11 * HOUR]) await sweep(ms);
    expect(pushes).toEqual([]);
    expect([(await row('B')).status, (await row('B')).stop_reason]).toEqual(['stopped', 'active_plan']);
  });

  it('Day 7: one app notification per sequence with its two buttons, once; Day 8 never sends late', async () => {
    await sweep(7 * DAY);
    await sweep(7 * DAY);
    await sweep(7 * DAY + HOUR);
    await sweep(8 * DAY);
    await sweep(30 * DAY);
    expect(pushes.map((p) => keys.find((k) => u[k] === p.user_id)).sort()).toEqual(['A', 'C', 'G', 'Q', 'W', 'Y']);
    const a = await row('A');
    expect(pushesTo('A')).toEqual([{ user_id: u.A, kind: 'plan_renewal', body: 'Your plan has ended.', deep_link: 'tgp://home',
      dedupe_key: `plan_renewal:${a.id}`, data: { categoryId: 'PLAN_RENEWAL', coach_id: u.K, house_coach_id: u.H } }]);
    expect(pushesTo('Q')[0].data).toEqual({ categoryId: 'PLAN_RENEWAL_COACH', coach_id: u.H });
    // Never urgent, so quiet hours always apply (test/plan-renewal.spec.ts).
    expect(notifications.sendPush.mock.calls.some(([p]) => 'urgent' in p)).toBe(false);
    expect([a.status, (await row('E')).status, pushesTo('E'), pushesTo('B')]).toEqual(['done', 'done', [], []]);
    // After Day 7 the renewal page still reads the ended state; no pop-up.
    expect(await view('A', 8 * DAY)).toMatchObject({ state: 'ended', popup_due: false, house_coach: { id: u.H } });
  });

  it('row security: a client reads only their own sequence; a coach only while still that client\'s coach', async () => {
    expect([await seen('A', 'A'), await seen('A', 'C')]).toEqual([1, 0]);
    expect([await seen('C', 'C'), await seen('C', 'A')]).toEqual([1, 0]);
    expect([await seen('K', 'A'), await seen('K', 'C')]).toEqual([1, 0]);
    expect([await seen('L', 'C'), await seen('L', 'A')]).toEqual([1, 0]);
    expect([await seen('H', 'Q'), await seen('H', 'A')]).toEqual([1, 0]);
    const id = (await row('A')).id;
    for (const who of 'AK') {
      for (const sql of [
        `INSERT INTO "PlanRenewal" ("id", "purchase_id", "client_user_id", "coach_user_id", "ended_at", "updated_at") VALUES ($1, $1, $2, $2, now(), now())`,
        `UPDATE "PlanRenewal" SET "popup_acked_step" = 3 WHERE "id" = $1 OR "client_user_id" = $2`,
        `DELETE FROM "PlanRenewal" WHERE "id" = $1 OR "client_user_id" = $2`,
      ]) expect(await api(who, sql, id, u[who])).not.toBe(1);
    }
    expect((await row('A')).popup_acked_step).toBe(1); // the Day 1 ack, unchanged
  });

  it('after A moves from coach K to coach L: K reads A\'s sequence no more, L never reads it, and it stops', async () => {
    await prisma.user.update({ where: { id: u.A }, data: { coach_id: u.L } });
    expect([await seen('K', 'E'), await seen('K', 'A')]).toEqual([1, 0]);
    expect([await seen('L', 'C'), await seen('L', 'A')]).toEqual([1, 0]);
    expect(await seen('A', 'A')).toBe(1);
    expect([(await view('A')).state, await planRenewalPushStillDue(prisma, u.A)]).toEqual(['none', false]);
  });
});
