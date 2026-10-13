// READTESTS (decision 141-5): no other coach, no sub-coach outside their
// scope and no former coach can read what the coach Home, the client lookup
// and the client's coach banner read. The app is built from the real
// controllers of the nine routes, behind the real JwtAuthGuard (only the JWKS
// check is a double: the bearer token is the caller's supabase id), the
// global RolesGuard and each route's own guards, over the real services and
// one stateful store. The guard re-reads the caller on every request, so a
// move or an archived seat takes effect on the next call, as in production.
// Row-layer evidence for the same tables: test/rls/coach-home-reads-rls.spec.ts.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { JwksVerifierService } from '../src/auth/jwks.service';
import { RolesGuard } from '../src/auth/roles.guard';
import { PtmService } from '../src/ptm/ptm.service';
import { PrismaService } from '../src/prisma.service';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { CoachConnectController } from '../src/coach-connect/coach-connect.controller';
import { CoachConnectService } from '../src/coach-connect/coach-connect.service';
import { ConnectService } from '../src/connect/connect.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { ConnectModuleState } from '../src/connect/connect.module-state';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { AdminAnalyticsService } from '../src/checkout/admin-analytics.service';
import { ClientPackagesController, CoachPackagesController } from '../src/packages/packages.controller';
import { PackagesService } from '../src/packages/packages.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { CoachMoneyController } from '../src/coach-money/coach-money.controller';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { LtvMetricsController } from '../src/coach/command-center/ltv-metrics.controller';
import { LtvMetricsService } from '../src/coach/command-center/ltv-metrics.service';
import { CommandCenterController } from '../src/coach/command-center/command-center.controller';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import { CoachAlertsService } from '../src/coach/coach-alerts.service';
import { ConsentService } from '../src/consent/consent.service';
import { CoachMacrosController } from '../src/macros/macros.controller';
import { MacrosService } from '../src/macros/macros.service';
import { CoachAiController } from '../src/ai-credits/coach-ai.controller';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { CoachAiCreditPackService } from '../src/ai-credits/coach-ai-credit-pack.service';
import { matchWhere, type Model, StatefulPrisma } from './support/stateful-prisma';
import { findMany } from './support/money-read-double';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
// Fictional cast. A1 and A2 are coach A's clients; A2 is delegated to A's
// sub-coach S. B1 is coach B's client. Coach C has no data at all.
const [A, B, C, S] = ['coach-a', 'coach-b', 'coach-c', 'sub-s'];
const [A1, A2, B1] = ['client-a1', 'client-a2', 'client-b1'];

type Row = Record<string, any>;
const db = new StatefulPrisma();
for (const m of ['user', 'userProfile', 'teamSubCoachAssignment', 'subCoachAssignment', 'coachSubscription']) db.model(m);
for (const m of ['payoutSnapshot', 'coachPackage', 'clientPurchase', 'chargeRefund', 'chargeDispute', 'splitLedgerEntry']) db.model(m);
for (const m of ['clientSignal', 'macroTarget']) db.model(m);
db.model('connectAccount', [['id'], ['coach_user_id']]);
db.model('coachLtvPeak', [['id'], ['coach_id']]);
db.model('coachAIBudget', [['id'], ['coach_user_id']], () => ({
  pack_paid_cents: 0,
  pack_displayed_cents: 0,
  actual_used_cents: 0,
  actual_used_micro_cents: 0,
  total_pack_actual_cents: 0,
}));
db.relations.profile = (u: Row) => db.state.userProfile.find((p: Row) => p.user_id === u.id) ?? null;
// Purchase reads carry relation selects and filters (client, package,
// refunds, disputes, splits); the money read double answers them.
db.clientPurchase.findMany = async (args: Row) => findMany(db, 'clientPurchase', args);
db.clientPurchase.findFirst = async (args: Row) => findMany(db, 'clientPurchase', { ...args, take: 1 })[0] ?? null;
db.clientSignal.groupBy = async (args: { by: string[]; where: Row }) => {
  const byUser = new Map<string, Date[]>();
  for (const r of db.state.clientSignal.filter((x: Row) => matchWhere(x, args.where))) {
    byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.recorded_at]);
  }
  return [...byUser].map(([user_id, at]) => ({
    user_id,
    _count: { _all: at.length },
    _min: { recorded_at: new Date(Math.min(...at.map((d) => d.getTime()))) },
  }));
};
const targetReads = jest.spyOn(db.macroTarget as Model, 'findMany');

function seed(): void {
  for (const name of Object.keys(db.state)) db.state[name] = [];
  const person = (id: string, role: string, coach_id: string | null, name: string) =>
    db.state.user.push({ id, supabase_id: id, email: `${id}@example.test`, name, role, coach_id, deleted_at: null });
  person(A, 'coach', null, 'Ava Coach');
  person(B, 'coach', null, 'Ben Coach');
  person(C, 'coach', null, 'Cal Coach');
  person(S, 'coach', A, 'Sam Sub');
  person(A1, 'student', A, 'Ada Client');
  person(A2, 'student', A, 'Abe Client');
  person(B1, 'student', B, 'Bea Client');
  db.state.userProfile.push({ user_id: A, avatar_url: 'https://example.test/ava.png' });
  db.state.userProfile.push({ user_id: B, avatar_url: 'https://example.test/ben.png' });
  db.state.teamSubCoachAssignment.push({ id: 'seat-s', head_coach_id: A, sub_coach_id: S, archived_at: null, created_at: ago(60) });
  db.state.subCoachAssignment.push({ id: 'del-s', head_coach_id: A, sub_coach_id: S, client_id: A2, unassigned_at: null });
  for (const [coach, acct, payout, cents] of [[A, 'acct_a', 'po_a', 12300], [B, 'acct_b', 'po_b', 4500]] as const) {
    db.state.connectAccount.push({
      id: `ca-${coach}`, coach_user_id: coach, stripe_account_id: acct, default_currency: 'usd', charges_enabled: true,
      payouts_enabled: true, details_submitted: true, requirements_due: null, disabled_reason: null, deauthorized_at: null,
      updated_at: ago(30),
    });
    db.state.payoutSnapshot.push({
      id: `ps-${coach}`, coach_user_id: coach, stripe_account_id: acct, currency: 'usd', last_payout_stripe_id: payout,
      last_payout_amount_cents: cents, last_payout_status: 'paid', last_payout_arrival_at: ago(2),
    });
  }
  const pkg = (id: string, coach_id: string, archived_at: Date | null) =>
    db.state.coachPackage.push({
      id, coach_id, name: `Plan ${id}`, amount_cents: 10000, currency: 'usd', billing_type: 'recurring', interval: 'month',
      interval_count: 1, recurring_amount_cents: null, recurring_interval: null, recurring_interval_count: null,
      is_active: archived_at === null, archived_at, created_at: ago(90),
    });
  pkg('pkg-a', A, null);
  pkg('pkg-a-old', A, ago(10));
  pkg('pkg-b', B, null);
  const sale = (id: string, client: string, coach: string, packageId: string, cents: number, days: number) =>
    db.state.clientPurchase.push({
      id, client_user_id: client, coach_user_id: coach, package_id: packageId, amount_cents: cents, currency: 'usd',
      billing_type: 'recurring', status: 'active', entitlement_active: true, source: null, canceled_at: null,
      stripe_subscription_id: `sub_${id}`, created_at: ago(days), updated_at: ago(days),
    });
  sale('p-a1', A1, A, 'pkg-a', 10000, 20);
  sale('p-b1', B1, B, 'pkg-b', 7000, 10);
  // A peak row per coach at or above their revenue per client, so the read
  // never takes the raw-SQL peak write the store cannot run.
  for (const [coach, peak] of [[A, 50000], [B, 70000], [C, 0], [S, 0]] as const) {
    db.state.coachLtvPeak.push({ id: `peak-${coach}`, coach_id: coach, all_time_peak_rpcm: peak, zero_churn_streak: 0 });
  }
  for (const [client, days] of [[A1, 6], [A2, 5], [B1, 4]] as const) {
    db.state.clientSignal.push({ id: `sig-${client}`, user_id: client, signal_type: 'checkin_streak', value: days, recorded_at: ago(1) });
  }
  for (const [client, coach] of [[A1, A], [B1, B]] as const) {
    db.state.macroTarget.push({
      id: `t-${client}`, client_id: client, coach_id: coach, calories_kcal: 2200, protein_g: 150, carbs_g: 220, fats_g: 70,
      effective_from: ago(5), created_at: ago(5), archived_at: null,
    });
  }
  for (const [coach, used, pack] of [[A, 1000, 2500], [B, 200, 0]] as const) {
    db.state.coachAIBudget.push({
      id: `budget-${coach}`, coach_user_id: coach, period_start: ago(5), period_end: ago(-25), base_actual_cents: 4000,
      value_multiplier: new Prisma.Decimal('3.125'), base_displayed_cents: 12500, pack_paid_cents: pack,
      pack_displayed_cents: pack, actual_used_cents: used, actual_used_micro_cents: 0, total_pack_actual_cents: pack,
    });
  }
}

const row = (model: string, id: string): Row => db.state[model].find((r: Row) => r.id === id);
const move = (client: string, to: string | null) => (row('user', client).coach_id = to);
const archiveSeat = () => (row('teamSubCoachAssignment', 'seat-s').archived_at = new Date());

let stripeOn = true;
const livePayouts: Record<string, Row[]> = {
  acct_a: [{ id: 'po_a_live', amount: 12300, currency: 'usd', status: 'paid', arrival_date: 1_790_000_000 }],
  acct_b: [{ id: 'po_b_live', amount: 4500, currency: 'usd', status: 'paid', arrival_date: 1_790_000_000 }],
};
const stripeConnect = {
  isConfigured: () => stripeOn,
  listPayouts: jest.fn(async (args: { connectedAccountId: string }) => ({ data: livePayouts[args.connectedAccountId] ?? [] })),
};

describe('READTESTS: the coach Home and client lookup reads stay inside the caller', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [
        CoachConnectController, CoachPackagesController, ClientPackagesController, CoachMoneyController,
        LtvMetricsController, CommandCenterController, CoachMacrosController, CoachAiController,
      ],
      providers: [
        { provide: PrismaService, useValue: db },
        { provide: JwksVerifierService, useValue: { verify: async (token: string) => ({ sub: token }) } },
        { provide: PtmService, useValue: { emit: jest.fn() } },
        SubCoachScopeService, CoachConnectService, PackagesService, CoachMoneyService, LtvMetricsService,
        CommandCenterService, MacrosService, CoachAIBudgetService,
        { provide: StripeConnectApiService, useValue: stripeConnect },
        // Every client shares every scope with any coach: the roster scope is the only filter left.
        {
          provide: ConsentService,
          useValue: {
            grantedScopesByClient: async (_coach: string, ids: readonly string[], scopes: readonly string[]) =>
              new Map(ids.map((id) => [id, new Set(scopes)])),
          },
        },
        ...[ConnectService, ConnectModuleState, PayoutReadinessService, AdminAnalyticsService, TrialUsageService,
          ChurnInterventionService, AdminPtmService, CoachAlertsService, CoachAiCreditPackService,
        ].map((provide) => ({ provide, useValue: {} })),
        // Same global order as AppModule: auth first, then RolesGuard.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());
  beforeEach(() => {
    seed();
    stripeOn = true;
    jest.clearAllMocks();
  });

  const get = async (as: string, path: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${as}` } });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const ok = async (as: string, path: string) => {
    const r = await get(as, path);
    expect({ path, as, status: r.status }).toEqual({ path, as, status: 200 });
    return r.body;
  };
  const ids = (list: Row[]) => list.map((x) => x.id);
  const status = (as: string) => ok(as, '/coach/connect/status').then((b) => b.account_id);
  const payouts = (as: string) => ok(as, '/coach/connect/payouts').then(ids);
  const packages = (as: string) => ok(as, '/v1/coach/packages?include_archived=true').then((b) => ids(b.packages));
  const charges = (as: string, q = 'status=paid&limit=1') => ok(as, `/v1/coach/money/charges?${q}`).then((b) => ids(b.charges));
  const ltv = (as: string) =>
    ok(as, '/coach/command-center/ltv-metrics').then((b) => [b.active_client_count, b.mrr_cents, b.all_time_peak_rpcm_cents]);
  const streaks = (as: string) =>
    ok(as, '/coach/command-center/win-streaks').then((b) => b.items.map((i: Row) => i.user_id).sort());
  const budget = (as: string) =>
    ok(as, '/coach/ai/budget').then((b) => [b.actual_used_cents, b.pack_displayed_cents]);
  const macros = (as: string, client: string) => get(as, `/coach/clients/${client}/macros/current`);
  const FINANCIAL = [
    '/coach/connect/status', '/coach/connect/payouts', '/v1/coach/money/charges?status=paid&limit=1',
    '/coach/command-center/ltv-metrics',
  ];

  describe('coach B never gets coach A\'s rows; coach A still gets their own', () => {
    it('GET /coach/connect/status: each coach reads their own Connect account; a coach with none gets not_started', async () => {
      expect(await status(A)).toBe('acct_a');
      expect(await status(B)).toBe('acct_b');
      const c = await ok(C, '/coach/connect/status?coach_user_id=coach-a');
      expect([c.account_id, c.state, c.configured]).toEqual([null, 'not_started', false]);
    });

    it('GET /coach/connect/payouts: Stripe is asked for the caller\'s account only; the cached snapshot is the caller\'s too', async () => {
      expect(await payouts(A)).toEqual(['po_a_live']);
      expect(await payouts(B)).toEqual(['po_b_live']);
      expect(stripeConnect.listPayouts.mock.calls.map(([a]) => a.connectedAccountId)).toEqual(['acct_a', 'acct_b']);
      expect(await payouts(C)).toEqual([]);
      stripeOn = false;
      expect(await payouts(B)).toEqual(['po_b']);
      expect(await payouts(C)).toEqual([]);
    });

    it('GET /v1/coach/packages?include_archived=true: coach B\'s list leaves out coach A\'s packages, archived ones too', async () => {
      expect((await packages(A)).sort()).toEqual(['pkg-a', 'pkg-a-old']);
      expect(await packages(B)).toEqual(['pkg-b']);
      expect(await packages(C)).toEqual([]);
    });

    it('GET /v1/coach/money/charges: coach B\'s list leaves out coach A\'s charges, whatever the filter or cursor', async () => {
      expect(await charges(A)).toEqual(['p-a1']);
      expect(await charges(B)).toEqual(['p-b1']);
      expect(await charges(B, 'status=all')).toEqual(['p-b1']);
      expect(await charges(B, 'status=paid&limit=1&cursor=p-a1')).not.toContain('p-a1');
      expect(await charges(C, 'status=all')).toEqual([]);
    });

    it('GET /coach/command-center/ltv-metrics: B\'s clients, revenue and peak leave out A\'s purchases and A\'s peak row', async () => {
      expect(await ltv(A)).toEqual([1, 10000, 50000]);
      expect(await ltv(B)).toEqual([1, 7000, 70000]);
      expect(await ltv(C)).toEqual([0, 0, 0]);
    });

    it('GET /coach/command-center/win-streaks: another coach\'s clients never appear', async () => {
      expect(await streaks(A)).toEqual([A1, A2]);
      expect(await streaks(B)).toEqual([B1]);
      expect(await streaks(C)).toEqual([]);
    });

    it('GET /coach/clients/:clientId/macros/current: another coach gets 404 and no target row is read', async () => {
      expect((await macros(A, A1)).body.id).toBe('t-client-a1');
      targetReads.mockClear();
      for (const as of [B, C]) expect((await macros(as, A1)).status).toBe(404);
      expect(targetReads).not.toHaveBeenCalled();
    });

    it('GET /coach/ai/budget: B gets only B\'s envelope and C only their own new one, never A\'s', async () => {
      expect(await budget(A)).toEqual([1000, 2500]);
      expect(await ok(B, '/coach/ai/budget?coach_user_id=coach-a').then((b) => b.actual_used_cents)).toBe(200);
      expect(await budget(C)).toEqual([0, 0]);
      expect(db.state.coachAIBudget.map((r: Row) => r.coach_user_id).sort()).toEqual([A, B, C]);
      expect(row('coachAIBudget', 'budget-coach-a').actual_used_cents).toBe(1000);
    });
  });

  describe('a sub-coach of coach A', () => {
    it('while their seat is active: 403 on every money route; A\'s catalog and A\'s AI envelope (intended); only the delegated client\'s streak', async () => {
      for (const path of FINANCIAL) expect([path, (await get(S, path)).status]).toEqual([path, 403]);
      expect((await packages(S)).sort()).toEqual(['pkg-a', 'pkg-a-old']);
      expect(await budget(S)).toEqual([1000, 2500]);
      expect(await streaks(S)).toEqual([A2]);
      targetReads.mockClear();
      expect((await macros(S, A1)).status).toBe(404);
      expect(targetReads).not.toHaveBeenCalled();
    });

    it('after the seat is archived: their own AI envelope, never A\'s, and only their own (empty) money records', async () => {
      archiveSeat();
      expect(await budget(S)).toEqual([0, 0]);
      expect(db.state.coachAIBudget.find((r: Row) => r.coach_user_id === S)).toBeDefined();
      expect(await status(S)).toBeNull();
      expect(await payouts(S)).toEqual([]);
      expect(await charges(S, 'status=all')).toEqual([]);
      expect(await ltv(S)).toEqual([0, 0, 0]);
    });

    it('after leaving the team (seat archived, delegation closed): no catalog and no streaks of A\'s', async () => {
      archiveSeat();
      row('subCoachAssignment', 'del-s').unassigned_at = new Date();
      expect(await packages(S)).toEqual([]);
      expect(await streaks(S)).toEqual([]);
    });
  });

  describe('a former coach after the client moves to coach B', () => {
    it('macros/current: the former coach gets 404 with no target read; the new coach reads the client\'s target', async () => {
      move(A1, B);
      targetReads.mockClear();
      expect((await macros(A, A1)).status).toBe(404);
      expect(targetReads).not.toHaveBeenCalled();
      expect((await macros(B, A1)).body.id).toBe('t-client-a1');
    });

    it('win-streaks: the moved client leaves A\'s list and the sub-coach\'s delegation ends with the move', async () => {
      move(A1, B);
      move(A2, B);
      expect(await streaks(A)).toEqual([]);
      expect(await streaks(S)).toEqual([]);
      expect(await streaks(B)).toEqual([A1, A2, B1]);
    });

    it('charges and ltv: A keeps their own sale (CONTRACT-1); B never gets it', async () => {
      move(A1, B);
      expect(await charges(A)).toEqual(['p-a1']);
      expect(await charges(B, 'status=all')).toEqual(['p-b1']);
      expect((await ltv(B))[1]).toBe(7000);
    });
  });

  describe('GET /v1/clients/me/coach', () => {
    it('a client gets only their own coach, whatever the query carries, and the new one right after a move', async () => {
      expect(await ok(A1, '/v1/clients/me/coach?coach_id=coach-b')).toEqual({
        id: A, name: 'Ava Coach', avatar_url: 'https://example.test/ava.png',
      });
      expect((await ok(B1, '/v1/clients/me/coach')).id).toBe(B);
      move(A1, B);
      expect((await ok(A1, '/v1/clients/me/coach')).id).toBe(B);
      move(A1, null);
      expect((await get(A1, '/v1/clients/me/coach')).status).toBe(404);
    });

    it('a client is refused on every coach route', async () => {
      for (const path of [...FINANCIAL, '/v1/coach/packages', '/coach/command-center/win-streaks', '/coach/ai/budget']) {
        expect([path, (await get(A1, path)).status]).toEqual([path, 403]);
      }
      expect((await macros(A1, A1)).status).toBe(403);
    });
  });
});
