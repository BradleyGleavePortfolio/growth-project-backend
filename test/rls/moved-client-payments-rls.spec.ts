// CONTRACT-1 (a former coach keeps only their own money records) over every coach client payments read and action: real guards
// and service (service_role, as the API runs), Stripe, refund and cancel recorders, a control before the move, and the sale read
// as the signed-in API role (non-bypass; a control of 1 before each 0). Runs in rls-live-tests.
import { randomUUID } from 'crypto';
import type { User } from '@prisma/client';
import { CoachClientPaymentsService } from '../../src/checkout/coach-client-payments.service';
import { CoachOrOwnerGuard } from '../../src/common/guards/coach-or-owner.guard';
import { NoActiveSubCoachGuard } from '../../src/common/guards/no-active-sub-coach.guard';
import { FeePolicyService } from '../../src/connect/fees/fee-policy.service';
import { PrismaService } from '../../src/prisma.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') throw new Error('moved-client-payments: CI=true, no TEST_DATABASE_URL.');
const NF = '404 PLAN_NOT_FOUND', OK = 'ok', NONE = [NF, NF, NF, NF, NF];
// [row, actor, seller of the sale, guards, list, [refund, by sale, pause, resume, cancel], calls sent, row read]
type Row = [string, string, string, string, string[], string[], string[], number];
(DB_URL ? describe : describe.skip)('coach client payments after a move: the money record only', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const [K, F, S, L, A] = Array.from({ length: 5 }, () => randomUUID()); // A moves from coach F to coach K
  const sale: Record<string, string> = {}, user: Record<string, User> = {};
  let sent: string[] = []; // every call that reaches Stripe, the refund path or cancelPlan
  const rec = (name: string, out: object) => async () => (sent.push(name), out);
  const stripe = { retrieveSubscription: async () => ({ pause_collection: null }), resumeSubscriptionCollection: rec('resume', {}),
    pauseSubscriptionCollection: rec('pause', { pause_collection: { behavior: 'void' } }) };
  const svc: CoachClientPaymentsService = Reflect.construct(CoachClientPaymentsService, [prisma, stripe,
    { createAdminRefund: rec('refund', { id: randomUUID(), amount_cents: 100, status: 'pending' }) },
    { cancelPlan: rec('cancel', { outcome: 'scheduled', access_ends_at: null }) },
    new FeePolicyService(prisma), { write: async () => undefined }]);
  const outcome = (run: () => Promise<unknown>) => run().then(() => OK, (e) =>
    [e.getStatus?.(), e.getResponse?.().code ?? e.getResponse?.().kind].filter(Boolean).join(' ') || String(e));
  const gate = (u: User) => outcome(async () => {
    const http = { switchToHttp: () => ({ getRequest: () => ({ user: u }) }) };
    for (const g of [new CoachOrOwnerGuard(), new NoActiveSubCoachGuard(prisma)]) await Reflect.apply(g.canActivate, g, [http]);
  });
  const acts = (u: User, id: string, key = randomUUID(), body = { idempotency_key: key, amount_cents: 100 }) => [
    () => svc.refund(u, A, id, body), () => svc.refundSale(u, id, body), () => svc.pause(u, A, id, key),
    () => svc.resume(u, A, id, key), () => svc.cancel(u, A, id, key)];
  const seen = (u: User, id: string) => prisma.$transaction([prisma.$queryRawUnsafe(`SELECT set_config('role', 'authenticated', true),
    set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true), set_config('request.jwt.claims', $3, true)`,
    u.id, u.role, `{"sub":"${u.id}"}`), prisma.clientPurchase.count({ where: { id } })]).then(([, n]) => n);
  beforeAll(async () => {
    for (const [id, role, coach_id] of [[K, 'coach', null], [F, 'coach', null], [L, 'coach', null], [S, 'coach', K], [A, 'student', F]] as const) {
      user[id] = await prisma.user.create({ data: { id, supabase_id: id, email: `pay-${id}`, name: 'Live person', role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S } });
    for (const coach of [K, F]) {
      const { id: package_id } = await prisma.coachPackage.create({ data: { coach_id: coach, name: 'Monthly', amount_cents: 4900 } });
      sale[coach] = (await prisma.clientPurchase.create({ data: { client_user_id: A, coach_user_id: coach, package_id,
        amount_cents: 4900, billing_type: 'recurring', status: 'active', entitlement_active: true, idempotency_key: randomUUID(),
        stripe_subscription_id: `sub_${randomUUID()}`, stripe_checkout_session_id: `cs_${randomUUID()}` } })).id;
      await prisma.chargeSettlement.create({ data: { purchase_id: sale[coach], coach_user_id: coach,
        stripe_charge_id: `ch_${randomUUID()}`, platform_bps: 200, gross_cents: 4900 } });
    }
    expect(await outcome(async () => svc.pause(user[F], A, sale[F], randomUUID()))).toBe(OK);
    await prisma.user.update({ where: { id: A }, data: { coach_id: K } });
  });
  afterAll(() => prisma.$disconnect());
  it.each<Row>([
    ['current coach K, own sale', K, K, OK, ['plan'], [OK, OK, OK, OK, OK], ['refund', 'refund', 'pause', 'cancel'], 1],
    ['former coach F, own sale', F, F, OK, ['record'], [OK, OK, NF, NF, NF], ['refund', 'refund'], 1],
    ['current coach K, the sale F made', K, F, OK, ['plan'], NONE, [], 0],
    ["K's sub-coach S", S, K, '403 sub_coach_billing_blocked', [], NONE, [], 0],
    ['other coach L', L, K, OK, [], NONE, [], 0],
    ['client A', A, K, '403', [], NONE, [], 1],
  ])('%s', async (_row, actorId, seller, guard, list, results, calls, rows) => {
    const u = user[actorId];
    sent = [];
    const plans = (await svc.list(u, A)).plans.map((p) => ('billing' in p ? 'plan' : 'record'));
    const done: string[] = []; // in order: each action sees the one before it
    for (const act of acts(u, sale[seller])) done.push(await outcome(act));
    expect([await gate(u), plans, done, sent, await seen(u, sale[seller])]).toEqual([guard, list, results, calls, rows]);
  });
});
