/**
 * RENEWAL-BE (20270502008100): the plan-renewal sequence on real Postgres.
 * The real PlanRenewalService sweep runs on the superuser connection, as the
 * API does; the push enqueue and the coach send are recorded (the outbox and
 * the messaging pipeline have their own suites). Row access runs as the API
 * role `authenticated` (no RLS bypass) on the replayed chain; every 0 comes
 * right after a 1 for the same caller on a row of the same kind.
 * Coach K coaches A, B, E and the excluded clients; coach L coaches C.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { PlanRenewalService } from '../../src/checkout/plan-renewal/plan-renewal.service';
import { planRenewalPushStillDue, readPlanRenewal } from '../../src/checkout/plan-renewal/plan-renewal.state';
import { PLAN_RENEWAL_DAY_MS } from '../../src/checkout/plan-renewal/plan-renewal.cadence';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { MessagingService } from '../../src/messaging/messaging.service';
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
  const pushes: Array<{ user_id: string; kind: string; deep_link?: string; dedupe_key?: string | null }> = [];
  const sent = new Map<string, { coach: string; client: string; body: string }>();
  let failOnceFor: string | null = null;
  const notifications = { sendPush: jest.fn(async (input: (typeof pushes)[number]) => { pushes.push(input); return null; }) };
  const messaging = {
    sendAsCoach: jest.fn(async (coach: string, client: string, payload: { body: string; client_message_id: string }) => {
      if (failOnceFor === client) {
        failOnceFor = null;
        throw new Error('provider down');
      }
      // The real insert is idempotent on (sender, client_message_id): a repeat key replays the one row.
      if (!sent.has(payload.client_message_id)) sent.set(payload.client_message_id, { coach, client, body: payload.body });
      return { id: `msg-${payload.client_message_id}` };
    }),
  };
  const service = new PlanRenewalService(prisma, stub<NotificationsService>(notifications), stub<MessagingService>(messaging));
  const keys = [...'KLAMBCEFRDVXZOP'];
  const u: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const supa: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = Object.fromEntries([...'ABEFRDVXZOP'].map((k) => [k, 'K']).concat([['C', 'L']]));
  const isCoach = (k: string) => 'KLM'.includes(k);
  const T0 = Date.now();
  const at = (ms: number) => new Date(T0 + ms);
  const sweep = (ms: number) => service.runSweep(at(ms));
  const flagBefore = process.env.FEATURE_PLAN_RENEWAL;

  const pushKeys = (who: string) => pushes.filter((p) => p.user_id === u[who]).map((p) => p.dedupe_key);
  const messagesTo = (who: string) => [...sent.values()].filter((m) => m.client === u[who]).map((m) => m.body);
  const row = (who: string) => prisma.planRenewal.findFirst({ where: { client_user_id: u[who] } });
  const view = (who: string, coach?: string) => readPlanRenewal(prisma, u[who], coach ? u[coach] : undefined);

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
    const names: Record<string, string> = { K: 'Kim Coach', L: 'Lee Coach', A: 'Ann Client' };
    for (const k of keys) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${supa[k]}, ${`renew-${u[k]}@example.test`}, ${names[k] ?? `Person ${k}`},
          ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    // A once had a card declined at checkout (a one-off attempt, never a plan): it does not count as a failed payment.
    await purchase('A', { billing_type: 'one_time', status: 'payment_failed', entitlement_active: false, created_at: at(-40 * DAY) });
    await packageRanOut('A', HOUR);
    // B: a subscription cancelled weeks ago at period end; the period ended two hours ago.
    await purchase('B', { billing_type: 'recurring', status: 'canceled', entitlement_active: false,
      canceled_at: at(-20 * DAY), current_period_end: at(-2 * HOUR) });
    await packageRanOut('C', HOUR);
    // E: first seen late, 2 days 23 hours after the end.
    await packageRanOut('E', 2 * DAY + 23 * HOUR);
    // Never a sequence: a failed payment (dunning owns it), a refund, a dispute, a revoked grant,
    // an archived client, a deleting account, a plan that ended 9 days ago, a client with another live plan.
    const failed = await purchase('F', { billing_type: 'recurring', status: 'canceled', entitlement_active: false,
      canceled_at: at(-HOUR), current_period_end: at(-HOUR) });
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
    // Coach L turns renewal messages off before the first sweep.
    expect(await service.setCoachSettings(u.L, false)).toEqual({ messages_enabled: false });
  });
  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.FEATURE_PLAN_RENEWAL;
    else process.env.FEATURE_PLAN_RENEWAL = flagBefore;
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
    expect(await sweep(0)).toEqual({ opened: 0, claimed: 0, stopped: 0, messages: 0 });
    expect(await prisma.planRenewal.count({ where: { client_user_id: { in: Object.values(u) } } })).toBe(0);
    expect(await planRenewalPushStillDue(prisma, u.A)).toBe(false);
    process.env.FEATURE_PLAN_RENEWAL = 'true';
  });

  it('Day 0: a package that ran out and a subscription that ended at period end open a sequence; nothing else does', async () => {
    await sweep(0);
    const opened = await prisma.planRenewal.findMany({ where: { client_user_id: { in: Object.values(u) } }, select: { client_user_id: true } });
    expect(opened.map((r) => keys.find((k) => u[k] === r.client_user_id)).sort()).toEqual(['A', 'B', 'C', 'E']);
    expect([pushKeys('A'), pushKeys('B'), pushKeys('C')]).toEqual([
      [`plan_renewal:${(await row('A'))!.id}:0`], [`plan_renewal:${(await row('B'))!.id}:0`], [`plan_renewal:${(await row('C'))!.id}:0`]]);
    expect(pushes.find((p) => p.user_id === u.A)).toMatchObject({ kind: 'plan_renewal', deep_link: 'tgp://home' });
    // Never urgent, so quiet hours always apply (test/plan-renewal.spec.ts).
    expect(notifications.sendPush.mock.calls.some(([p]) => 'urgent' in p)).toBe(false);
    expect(messagesTo('A')).toEqual([
      'Hi Ann, your plan with me has ended. If you want to keep going, you can pick a new plan in the app. Message me here with any questions.']);
    // Coach L turned renewal messages off: C gets the pop-up and the push, no message.
    expect([messagesTo('C'), (await row('C'))!.message_status]).toEqual([[], 'skipped']);
    expect(await view('A')).toEqual({ state: 'ended', ended_at: at(-HOUR).toISOString(), step: 0, popup_due: true,
      popup_step: 0, coach: { id: u.K, first_name: 'Kim' } });
    for (const who of 'FRDXZOP') expect([who, await view(who)]).toEqual([who, expect.objectContaining({ state: 'none' })]);
    expect(await view('V')).toEqual({ state: 'revoked', ended_at: null, step: null, popup_due: false, popup_step: null,
      coach: { id: u.K, first_name: expect.any(String) } });
    // Asking about another coach than the current one says nothing.
    expect((await view('A', 'L')).state).toBe('none');
  });

  it('a repeat sweep (a second machine, a retry) sends nothing twice', async () => {
    await sweep(60_000);
    await sweep(60_000);
    expect([pushKeys('A').length, messagesTo('A').length, pushKeys('C').length]).toEqual([1, 1, 1]);
  });

  it('first seen late: only the latest due step goes out, then at most one step in 24 hours', async () => {
    const e = (await row('E'))!;
    expect([e.step_index, e.popup_step, e.message_status]).toEqual([1, 0, null]);
    expect(pushKeys('E')).toEqual([`plan_renewal:${e.id}:1`]);
    await sweep(HOUR); // Day 3 is due now, but Day 1 went out an hour ago.
    expect(pushKeys('E')).toHaveLength(1);
  });

  it('the pop-up ack: only a due pop-up step, idempotent, and it never hides a later one', async () => {
    await expect(service.ackPopup(u.A, 1)).rejects.toMatchObject({ response: { code: 'PLAN_RENEWAL_STEP_INVALID' } });
    await expect(service.ackPopup(u.A, 3)).rejects.toMatchObject({ response: { code: 'PLAN_RENEWAL_STEP_NOT_REACHED' } });
    await expect(service.ackPopup(u.F, 0)).rejects.toMatchObject({ response: { code: 'PLAN_RENEWAL_NOT_FOUND' } });
    expect((await service.ackPopup(u.A, 0)).renewal).toMatchObject({ state: 'ended', step: 0, popup_due: false, popup_step: null });
    expect((await service.ackPopup(u.A, 0)).renewal).toMatchObject({ popup_due: false });
    // A's ack touched only A's row.
    expect((await view('B')).popup_due).toBe(true);
  });

  it('Day 1, 3 and 7: one push each, the Day 3 and Day 7 pop-ups, the Day 7 message; nothing after Day 7', async () => {
    const a = (await row('A'))!.id;
    await sweep(12 * HOUR);
    expect(pushKeys('A')).toHaveLength(1);
    await sweep(DAY);
    expect([pushKeys('A'), (await view('A')).popup_due]).toEqual([[`plan_renewal:${a}:0`, `plan_renewal:${a}:1`], false]);
    // B buys again from coach K after Day 1: the sequence stops at once, and a push still queued is not sent.
    expect(await planRenewalPushStillDue(prisma, u.B)).toBe(true);
    await purchase('B', { billing_type: 'recurring', status: 'active', entitlement_active: true, access_expires_at: at(40 * DAY) });
    expect([(await view('B')).state, await planRenewalPushStillDue(prisma, u.B)]).toEqual(['none', false]);
    await sweep(3 * DAY);
    expect(await view('A')).toMatchObject({ step: 3, popup_due: true, popup_step: 3 });
    const b = (await row('B'))!;
    expect([b.status, b.stop_reason, pushKeys('B')]).toEqual(['stopped', 'active_plan', [0, 1].map((k) => `plan_renewal:${b.id}:${k}`)]);
    await service.ackPopup(u.A, 3);
    failOnceFor = u.A; // A's Day 7 send fails once and is retried with the same key
    await sweep(7 * DAY);
    expect([(await row('A'))!.status, messagesTo('A')]).toEqual(['done', [expect.stringContaining('Hi Ann')]]);
    await sweep(7 * DAY + 2 * 60_000);
    await sweep(8 * DAY);
    await sweep(30 * DAY);
    expect(pushKeys('A')).toEqual([0, 1, 2, 3].map((s) => `plan_renewal:${a}:${s}`));
    expect(messagesTo('A')).toEqual([expect.stringContaining('has ended'),
      'Hi Ann, one last note about your plan. If you want to keep working together, you can pick a plan in the app any time.']);
    expect(await view('A')).toMatchObject({ state: 'ended', step: 7, popup_due: true, popup_step: 7 });
    // E went one step a day at most; B, stopped, got nothing more.
    expect(pushKeys('E').map((k) => k?.split(':')[2])).toEqual(['1', '2', '3']);
    expect([pushKeys('B').length, messagesTo('B').length]).toEqual([2, 1]);
  });

  it('row security: a client reads only their own sequence; a coach only while still that client\'s coach', async () => {
    expect([await seen('A', 'A'), await seen('A', 'C')]).toEqual([1, 0]);
    expect([await seen('C', 'C'), await seen('C', 'A')]).toEqual([1, 0]);
    expect([await seen('K', 'A'), await seen('K', 'C')]).toEqual([1, 0]);
    expect([await seen('L', 'C'), await seen('L', 'A')]).toEqual([1, 0]);
    const id = (await row('A'))!.id;
    for (const who of 'AK') {
      for (const sql of [
        `INSERT INTO "PlanRenewal" ("id", "purchase_id", "client_user_id", "coach_user_id", "ended_at", "updated_at") VALUES ($1, $1, $2, $2, now(), now())`,
        `UPDATE "PlanRenewal" SET "popup_acked_step" = 3 WHERE "id" = $1 OR "client_user_id" = $2`,
        `DELETE FROM "PlanRenewal" WHERE "id" = $1 OR "client_user_id" = $2`,
      ]) expect(await api(who, sql, id, u[who])).not.toBe(1);
    }
    expect((await row('A'))!.popup_acked_step).toBe(2); // the Day 3 ack (step index 2), unchanged
  });

  it('after A moves from coach K to coach L: K reads A\'s sequence no more, L never reads it, and it stops', async () => {
    await prisma.user.update({ where: { id: u.A }, data: { coach_id: u.L } });
    expect([await seen('K', 'E'), await seen('K', 'A')]).toEqual([1, 0]);
    expect([await seen('L', 'C'), await seen('L', 'A')]).toEqual([1, 0]);
    expect(await seen('A', 'A')).toBe(1);
    expect([(await view('A')).state, await planRenewalPushStillDue(prisma, u.A)]).toEqual(['none', false]);
  });
});
