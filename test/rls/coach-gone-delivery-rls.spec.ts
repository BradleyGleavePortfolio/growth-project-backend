/**
 * COACH-GONE-DELIVERY: a client keeps what he paid for when his coach deletes his account, live on
 * the replayed migration chain. Coach K sells package PK; his client S bought it (one-time PS) and
 * holds a monthly plan PR, which delivered video V2; K's client N bought nothing. Coach L and his
 * client Z are the other tenant. PS delivered workout WP (assignment WA) and video V; meal plan MP
 * is still due by drop MD. N was also given V by hand. The real AccountDeletionService request and
 * cancel run, the real CheckoutService answers the in-app purchase, the real ClientBillingService
 * sweep turns renewal off and on and takes S's own cancel, the real SubscriptionCheckoutService
 * answers Keep plan, the erasure manifest's steps for these tables run as the finalizer does, and
 * the real DripDispatcherCron delivers MD through the real meal-plan resolver. Reads run as the
 * non-bypass `authenticated` role; media reads go through CoachMediaService.getBuyerSignedUrl, the
 * only read path of that server-only table. Every 0 or refusal follows a read that returned 1. The
 * tests run in order. Gate: TEST_DATABASE_URL; no URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import type { Prisma, ScheduledDrop } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { CoachMediaService } from '../../src/coach-media/coach-media.service';
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { ERASURE_MANIFEST, executeErasureManifest } from '../../src/account-deletion/account-deletion.manifest';
import { CheckoutService } from '../../src/checkout/checkout.service';
import { ClientBillingService } from '../../src/checkout/client-billing.service';
import { SubscriptionCheckoutService } from '../../src/checkout/subscription-checkout.service';
import { DripDispatcherCron } from '../../src/packages/drip-dispatcher.cron';
import { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { MealPlanAssetResolver } from '../../src/packages/asset-resolvers/meal-plan.resolver';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-gone-delivery-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

function stub<T>(value: unknown): T {
  return value as T;
}
/** Any method resolves to undefined (audit, logs, Apple). */
const quiet = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => 'not_configured') });

(DB_URL ? describe : describe.skip)('COACH-GONE-DELIVERY: paid content outlives the coach', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const [K, L, S, N, Z, PK, PL, PS, PR, WP, V, V2, MP, MD] = ['K', 'L', 'S', 'N', 'Z', 'PK', 'PL', 'PS', 'PR', 'WP', 'V', 'V2', 'MP', 'MD']
    .map((tag) => `${tag}-${run}`);
  const coaches = new Set([K, L]);
  const deletion = new AccountDeletionService(
    prisma,
    stub<ConstructorParameters<typeof AccountDeletionService>[1]>(quiet),
    stub<ConstructorParameters<typeof AccountDeletionService>[2]>({ get: () => undefined }),
    stub<ConstructorParameters<typeof AccountDeletionService>[3]>(quiet),
    stub<ConstructorParameters<typeof AccountDeletionService>[4]>(quiet),
    stub<ConstructorParameters<typeof AccountDeletionService>[5]>(quiet),
    stub<ConstructorParameters<typeof AccountDeletionService>[6]>(quiet),
    stub<ConstructorParameters<typeof AccountDeletionService>[7]>(quiet),
  );
  const checkout = new CheckoutService(
    prisma,
    stub<ConstructorParameters<typeof CheckoutService>[1]>({}),
    stub<ConstructorParameters<typeof CheckoutService>[2]>({
      getById: (id: string) => prisma.coachPackage.findUnique({ where: { id } }),
    }),
    stub<ConstructorParameters<typeof CheckoutService>[3]>({ ready: true }),
    stub<ConstructorParameters<typeof CheckoutService>[4]>({}),
    stub<ConstructorParameters<typeof CheckoutService>[5]>({}),
  );
  const stripe = {
    setCancelAtPeriodEnd: jest.fn(async (_args: { subscriptionId: string }) => ({})),
    resumeSubscription: jest.fn(async (_args: { subscriptionId: string }) => ({})),
  };
  const billing = new ClientBillingService(prisma, stub<ConstructorParameters<typeof ClientBillingService>[1]>(stripe));
  const plans = new SubscriptionCheckoutService(prisma, stub<never>(stripe), stub<never>({}), stub<never>({ ready: true }), stub<never>({}), stub<never>({}));
  const meal = new MealPlanAssetResolver(prisma, new ResolverSubCoachScope(new SubCoachScopeService(prisma)));
  const cron = stub<{
    claim(id: string, prior: 'pending', now: Date): Promise<ScheduledDrop | null>;
    dispatch(drop: ScheduledDrop, now: Date): Promise<string>;
    dueWhere(now: Date): Prisma.ScheduledDropWhereInput;
  }>(new DripDispatcherCron(prisma, new AssignableAssetResolverRegistry([meal])));
  const media = new CoachMediaService(
    stub<ConstructorParameters<typeof CoachMediaService>[0]>(prisma),
    stub<ConstructorParameters<typeof CoachMediaService>[1]>({ isConfigured: () => true }),
    stub<ConstructorParameters<typeof CoachMediaService>[2]>({
      mintPlaybackUrl: ({ playbackId }: { playbackId: string }) => `mux:${playbackId}`,
    }),
    stub<ConstructorParameters<typeof CoachMediaService>[3]>({}),
    stub<ConstructorParameters<typeof CoachMediaService>[4]>({ get: () => undefined }),
  );
  /** The in-app purchase as `who`: the refusal code, or the first check past the package gate. */
  const buy = (who: string, packageId: string) =>
    checkout.createCheckoutForClient(who, { package_id: packageId }).then(
      () => 'created',
      (e: unknown) => String((e as { response?: { error?: string } }).response?.error ?? e),
    );
  const open = (who: string, id = V) =>
    media.getBuyerSignedUrl(who, id).then(
      (r) => r.url,
      (e: unknown) => {
        if (e instanceof NotFoundException) return 'refused';
        throw e;
      },
    );
  /** `query` as the signed-in API role (app.current_user_id = who), or as anon when who is ''. */
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (!who) {
        await tx.$executeRawUnsafe('SET LOCAL ROLE anon');
        return query(tx);
      }
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, coaches.has(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return query(tx);
    });
  /** Rows of `table` with id `id` that `who` reads; a refused read (anon) counts as 0. */
  const reads = (who: string, table: string, column: string, id: string) =>
    as(who, (tx) => tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, id))
      .then((rows) => rows[0].n, (e: unknown) => (/permission denied/.test(String(e)) ? 0 : Promise.reject(e)));
  const plan = () => prisma.clientPurchase.findUniqueOrThrow({ where: { id: PR } });

  beforeAll(async () => {
    const people = [[K, null], [L, null], [S, K], [N, K], [Z, L]] as const;
    for (const [id, coach_id] of people) {
      const role = coaches.has(id) ? 'coach' : 'student';
      await prisma.user.create({ data: { id, supabase_id: id, email: `gone-${id}`, name: 'Live person', role, coach_id } });
    }
    for (const [id, coach_id] of [[PK, K], [PL, L]] as const) {
      await prisma.coachPackage.create({ data: { id, coach_id, name: 'Programme', amount_cents: 10000, published_at: new Date() } });
    }
    const sale = { client_user_id: S, coach_user_id: K, package_id: PK, amount_cents: 10000, entitlement_active: true };
    const keys = (id: string) => ({ id, idempotency_key: id, stripe_checkout_session_id: `cs_${id}` });
    await prisma.clientPurchase.create({ data: { ...sale, ...keys(PS), status: 'paid' } });
    await prisma.clientPurchase.create({
      data: { ...sale, ...keys(PR), status: 'active', billing_type: 'recurring', stripe_subscription_id: `sub_${PR}` },
    });
    await prisma.workoutPlan.create({ data: { id: WP, coach_id: K, name: 'Day 1', type: 'strength' } });
    const wa = await prisma.clientWorkoutAssignment.create({
      data: { workout_plan_id: WP, client_id: S, assigned_by_coach_id: K, scheduled_for: new Date() },
    });
    for (const id of [V, V2]) {
      await prisma.coachMediaAsset.create({
        data: { id, coach_id: K, kind: 'video', title: 'Media', status: 'ready', provider: 'mux', storage_key: `mux-${id}`, mux_playback_id: `play-${id}` },
      });
    }
    await prisma.clientAssetGrant.createMany({
      data: [{ client_id: S, media_asset_id: V }, { client_id: N, media_asset_id: V }, { client_id: S, media_asset_id: V2 }],
    });
    await prisma.dailyMealPlan.create({ data: { id: MP, coach_id: K, name: 'Meals' } });
    const drop = { client_purchase_id: PS, cadence_kind: 'offset_days', cadence_payload: {}, alert_dispatched_at: new Date() };
    await prisma.scheduledDrop.createMany({
      data: [
        { ...drop, content_id: WP, asset_type: 'workout_plan', asset_id: WP, status: 'delivered', materialised_ref: wa.id },
        { ...drop, content_id: V, asset_type: 'video', asset_id: V, status: 'delivered', materialised_ref: V },
        { ...drop, client_purchase_id: PR, content_id: V2, asset_type: 'video', asset_id: V2, status: 'delivered', materialised_ref: V2 },
        { ...drop, id: MD, content_id: MP, asset_type: 'meal_plan', asset_id: MP, status: 'pending', fire_at: new Date(Date.now() + 864e5) },
      ],
    });
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(S, (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('the deletion request takes his packages off sale and his plans off renewal; another coach is untouched', async () => {
    // No Connect account in this database: a sale on sale stops at the next check.
    expect(await buy(S, PK)).toBe('COACH_NOT_CONNECTED');
    expect(await buy(Z, PL)).toBe('COACH_NOT_CONNECTED');
    await deletion.requestDeletion(K);
    expect(await buy(S, PK)).toBe('PACKAGE_NOT_FOUND');
    expect(await buy(Z, PL)).toBe('COACH_NOT_CONNECTED');
    expect((await plan()).cancel_at_period_end).toBe(false);
    await billing.syncPlansOfLeavingCoaches();
    expect(stripe.setCancelAtPeriodEnd).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: `sub_${PR}` }));
    expect(await plan()).toEqual(expect.objectContaining({ cancel_at_period_end: true, entitlement_active: true }));
  });

  it('cancelling the deletion puts back on sale and on renewal exactly what it took off', async () => {
    await deletion.cancelDeletion(K);
    expect(await buy(S, PK)).toBe('COACH_NOT_CONNECTED');
    await billing.syncPlansOfLeavingCoaches();
    expect(stripe.resumeSubscription).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: `sub_${PR}` }));
    expect(await plan()).toEqual(expect.objectContaining({ cancel_at_period_end: false, renewal_off_for_deletion_at: null }));
  });

  it("S's own cancel of a plan the deletion is ending wins: Keep plan is refused, and the coach staying never resumes it", async () => {
    await deletion.requestDeletion(K);
    await billing.syncPlansOfLeavingCoaches();
    expect((await plan()).renewal_off_for_deletion_at).not.toBeNull();
    expect((await billing.cancelPlan(S, PR)).message).toMatch(/you will not be charged again/);
    expect((await plan()).renewal_off_for_deletion_at).toBeNull();
    expect((await plans.getPlan(S, PR)).can_resume).toBe(false);
    const kept = await plans.resumePlan(S, PR, run).catch((e: { response?: { code?: string } }) => e.response?.code);
    expect(kept).toBe('PLAN_ALREADY_ENDED');
    await deletion.cancelDeletion(K);
    stripe.resumeSubscription.mockClear();
    await billing.syncPlansOfLeavingCoaches();
    expect(stripe.resumeSubscription).not.toHaveBeenCalled();
    expect(await plan()).toEqual(expect.objectContaining({ cancel_at_period_end: true, renewal_off_for_deletion_at: null }));
  });

  it('after the purge S reads what he was delivered, his ended monthly plan included; N, another coach and the public read none of it', async () => {
    await deletion.requestDeletion(K);
    await billing.syncPlansOfLeavingCoaches();
    // PR runs out inside the grace.
    await prisma.clientPurchase.update({ where: { id: PR }, data: { status: 'canceled', entitlement_active: false } });
    expect(await open(N)).toBe(`mux:play-${V}`);
    const steps = ERASURE_MANIFEST.filter((e) => ['User', 'WorkoutPlan', 'ClientWorkoutAssignment', 'DailyMealPlan',
      'DailyMealPlanAssignment', 'CoachMediaAsset', 'ClientAssetGrant', 'ScheduledDrop', 'ClientPurchase', 'CoachPackage'].includes(e.model));
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await executeErasureManifest(tx, { userId: K, email: `gone-${K}`, tombstoneEmail: `deleted-${K}`, now: new Date() }, steps);
      await tx.user.update({ where: { id: K }, data: { deleted_at: new Date(), deletion_confirmed_at: null } });
    }, { timeout: 30_000 });
    expect(await reads(S, 'ClientWorkoutAssignment', 'workout_plan_id', WP)).toBe(1);
    expect(await reads(S, 'WorkoutPlan', 'id', WP)).toBe(1);
    for (const who of [N, L, Z, '']) {
      expect(await reads(who, 'ClientWorkoutAssignment', 'workout_plan_id', WP)).toBe(0);
      expect(await reads(who, 'WorkoutPlan', 'id', WP)).toBe(0);
    }
    expect(await open(S)).toBe(`mux:play-${V}`);
    expect(await open(S, V2)).toBe(`mux:play-${V2}`);
    for (const who of [N, L, Z]) expect([await open(who), await open(who, V2)]).toEqual(['refused', 'refused']);
    expect(await buy(S, PK)).toBe('PACKAGE_NOT_FOUND');
  });

  it('a drop not yet delivered still fires on its schedule, to S only', async () => {
    const due = (now: Date) => prisma.scheduledDrop.count({ where: { AND: [cron.dueWhere(now), { id: MD }] } });
    expect(await due(new Date())).toBe(0);
    const at = new Date(Date.now() + 2 * 864e5);
    expect(await due(at)).toBe(1);
    const claimed = await cron.claim(MD, 'pending', at);
    expect(await cron.dispatch(claimed as ScheduledDrop, at)).toBe('delivered');
    expect(await reads(S, 'DailyMealPlanAssignment', 'daily_meal_plan_id', MP)).toBe(1);
    expect(await reads(S, 'DailyMealPlan', 'id', MP)).toBe(1);
    for (const who of [N, L, Z, '']) {
      expect(await reads(who, 'DailyMealPlanAssignment', 'daily_meal_plan_id', MP)).toBe(0);
      expect(await reads(who, 'DailyMealPlan', 'id', MP)).toBe(0);
    }
  });
});
