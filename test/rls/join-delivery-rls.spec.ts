/**
 * FX-JOIN: a client who joins a coach by paying gets every item of the package, live on the
 * replayed migration chain. A paid join, a code join's free package and a guest checkout write the
 * client's coach inside the purchase transaction and deliver the due-now items in that same
 * transaction, so the scope check must read the attach there. Coach K sells package PK (a video,
 * a meal plan, a workout and a welcome message, all due at once); coach L is the other tenant.
 *   S  coachless, pays for PK in the app: the paid join attaches S to K in the fan-out
 *   G  a guest checkout: the account is created with coach K inside the conversion transaction
 *   A  already K's client, buys PK (today's path, unchanged)
 *   Z  L's client: K is outside Z's scope, so the purchase is still refused
 * The real fan-out, the four real resolvers (real MessagingService and WorkoutBuilderService) and
 * the real DripDispatcherCron run on the superuser connection, as the API does, with a 5-connection
 * pool because the delegates read and write on their own connections. Row reads run as the
 * non-bypass `authenticated` role; the video is read through CoachMediaService.getBuyerSignedUrl,
 * the only read path of that server-only table. Every 0 follows a 1 on the same row.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import { CoachMediaService } from '../../src/coach-media/coach-media.service';
import { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { SubCoachOutOfScopeError } from '../../src/packages/asset-resolvers/assignable-asset-resolver.errors';
import { AutoMessageAssetResolver } from '../../src/packages/asset-resolvers/auto-message.resolver';
import { MealPlanAssetResolver } from '../../src/packages/asset-resolvers/meal-plan.resolver';
import { MediaAssetResolver } from '../../src/packages/asset-resolvers/media-asset.resolver';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';
import { WorkoutAssetResolver } from '../../src/packages/asset-resolvers/workout.resolver';
import { DripDispatcherCron } from '../../src/packages/drip-dispatcher.cron';
import { PurchaseFanoutService, type FanoutContext } from '../../src/packages/purchase-fanout.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { ProgramDeliveryService } from '../../src/workout-builder/program-delivery.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { stub } from '../utils/trial-fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('join-delivery-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('FX-JOIN: paid-join content reaches the new client', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL.replace('connection_limit=1', 'connection_limit=5') } } });
  const run = randomUUID().slice(0, 8);
  const [K, L, S, G, A, Z, PK, V, MP, W] = ['K', 'L', 'S', 'G', 'A', 'Z', 'PK', 'V', 'MP', 'W'].map((t) => `${t}-${run}`);
  const WELCOME = 'Welcome aboard. Your first week is ready.';

  const scope = new SubCoachScopeService(prisma);
  const rscope = new ResolverSubCoachScope(scope);
  const quiet = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => undefined) });
  const realtime = { channel: () => ({ httpSend: async () => ({ success: true }) }), removeChannel: async () => 'ok' };
  const supabase = Object.assign(Object.create(SupabaseService.prototype) as SupabaseService, { getClient: () => realtime });
  const messaging = new MessagingService(prisma, supabase, ...stub<[never, never, never, never, never]>(Array(5).fill(quiet)));
  const registry = new AssignableAssetResolverRegistry([
    new MediaAssetResolver(prisma, rscope),
    new MealPlanAssetResolver(prisma, rscope),
    new WorkoutAssetResolver(new WorkoutBuilderService(prisma, undefined, scope), rscope, new ProgramDeliveryService(prisma)),
    new AutoMessageAssetResolver(messaging, rscope, prisma),
  ]);
  const fanout = new PurchaseFanoutService(registry, undefined, undefined, prisma);
  const cron = new DripDispatcherCron(prisma, registry, stub<never>(quiet));
  const media = new CoachMediaService(
    prisma,
    stub<never>({ isConfigured: () => true }),
    stub<never>({ mintPlaybackUrl: ({ playbackId }: { playbackId: string }) => `mux:${playbackId}` }),
    scope,
    stub<never>({ get: () => undefined }),
  );

  const person = (id: string, role: 'coach' | 'student', coach_id: string | null, db: Prisma.TransactionClient = prisma) =>
    db.user.create({ data: { id, supabase_id: id, email: `fxjoin-${id}`, name: 'Live person', role, coach_id } });
  /** `who` pays for PK; `before` runs first in the same transaction (the guest checkout's account). */
  const pay = async (who: string, entrypoint: FanoutContext['entrypoint'], before?: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const id = randomUUID();
    const sale = {
      id, client_user_id: who, coach_user_id: K, package_id: PK, amount_cents: 4900, status: 'paid' as const,
      entitlement_active: true, stripe_checkout_session_id: `cs_${id}`, idempotency_key: `idem-${id}`,
    };
    await prisma.$transaction(async (tx) => {
      await before?.(tx);
      const purchase = await tx.clientPurchase.create({ data: sale });
      await fanout.onPurchaseEntitled(purchase, { entrypoint, coachId: K, clientId: who, purchaseTime: new Date() }, tx);
    }, { timeout: 20_000 });
    return id;
  };
  /** Replays the entitlement for an existing purchase (a Stripe webhook redelivery re-enters the fan-out). */
  const replay = (purchaseId: string, who: string) =>
    prisma.$transaction((tx) => fanout.onPurchaseEntitled({ id: purchaseId }, { entrypoint: 'in_app_hosted', coachId: K, clientId: who }, tx), { timeout: 20_000 });
  /** Each drop of the purchase: '<type> <status>'. */
  const drops = async (purchaseId: string) =>
    (await prisma.scheduledDrop.findMany({ where: { client_purchase_id: purchaseId } })).map((d) => `${d.asset_type} ${d.status}`).sort();
  /** How many of each item `who` holds (superuser count: exactly once). */
  const holds = async (who: string) => [
    await prisma.clientAssetGrant.count({ where: { client_id: who, media_asset_id: V } }),
    await prisma.dailyMealPlanAssignment.count({ where: { client_id: who, daily_meal_plan_id: MP } }),
    await prisma.clientWorkoutAssignment.count({ where: { client_id: who, workout_plan_id: W } }),
    await prisma.coachMessage.count({ where: { client_id: who, coach_id: K, body: WELCOME } }),
  ];
  const as = <T>(who: string, role: string, read: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return read(tx);
    });
  /** What `reader` sees of `client`'s meal plan, workout and welcome message, signed in (row security on). */
  const sees = (reader: string, role: string, client: string) =>
    as(reader, role, async (tx) => [
      await tx.dailyMealPlanAssignment.count({ where: { client_id: client, daily_meal_plan_id: MP } }),
      await tx.clientWorkoutAssignment.count({ where: { client_id: client, workout_plan_id: W } }),
      await tx.coachMessage.count({ where: { client_id: client, coach_id: K, body: WELCOME } }),
    ]);
  const video = (who: string) => media.getBuyerSignedUrl(who, V).then((r) => r.url, () => 'refused');
  const coachOf = async (who: string) => (await prisma.user.findUnique({ where: { id: who } }))?.coach_id ?? null;
  /** The dispatcher's next tick: it delivers the drops the purchase left due. */
  const tick = () => cron.runOnce(new Date(Date.now() + 1000));
  const inline = ['auto_message fired', 'meal_plan fired', 'video fired', 'workout_plan fired'];
  const deferred = ['auto_message pending', 'meal_plan fired', 'video fired', 'workout_plan pending'];
  const afterTick = ['auto_message delivered', 'meal_plan fired', 'video fired', 'workout_plan delivered'];
  const purchases: Record<string, string> = {};

  beforeAll(async () => {
    await person(K, 'coach', null);
    await person(L, 'coach', null);
    await person(S, 'student', null);
    await person(A, 'student', K);
    await person(Z, 'student', L);
    await prisma.coachPackage.create({ data: { id: PK, coach_id: K, name: 'Getting started', amount_cents: 4900 } });
    await prisma.coachMediaAsset.create({
      data: { id: V, coach_id: K, kind: 'video', title: 'Week 1', status: 'ready', provider: 'mux', storage_key: `mux-${V}`, mux_playback_id: `play-${V}` },
    });
    await prisma.dailyMealPlan.create({ data: { id: MP, coach_id: K, name: 'Meals' } });
    await prisma.workoutPlan.create({ data: { id: W, coach_id: K, name: 'Day 1', type: 'strength' } });
    const item = { package_id: PK, cadence_kind: 'immediate', cadence_payload: {}, display_title: 'Week 1' };
    await prisma.coachPackageContent.createMany({
      data: [
        { ...item, asset_type: 'video', asset_id: V },
        { ...item, asset_type: 'meal_plan', asset_id: MP },
        { ...item, asset_type: 'workout_plan', asset_id: W },
        { ...item, asset_type: 'auto_message', asset_id: randomUUID(), display_caption: WELCOME },
      ],
    });
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    const [row] = await as(S, 'student', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`);
    expect(row.bypass).toBe(false);
  });

  it('a coachless client pays in the app: the purchase commits, the join attaches, every item arrives once', async () => {
    expect([await coachOf(S), await holds(S)]).toEqual([null, [0, 0, 0, 0]]);
    purchases.S = await pay(S, 'in_app_hosted');
    expect(await coachOf(S)).toBe(K);
    expect((await prisma.purchaseFanout.findUniqueOrThrow({ where: { purchase_id: purchases.S } })).state).toBe('succeeded');
    // The video and meal plan arrive in the purchase transaction; the workout and welcome message
    // (their services check and write on their own connection) wait for the dispatcher's tick.
    expect([await drops(purchases.S), await holds(S)]).toEqual([deferred, [1, 1, 0, 0]]);
    await tick();
    expect([await drops(purchases.S), await holds(S)]).toEqual([afterTick, [1, 1, 1, 1]]);
    expect(await video(S)).toBe(`mux:play-${V}`);
    expect(await sees(S, 'student', S)).toEqual([1, 1, 1]);
  });

  it('the other coach reads none of it; the client\'s coach does', async () => {
    expect(await sees(K, 'coach', S)).toEqual([1, 1, 1]);
    expect(await sees(L, 'coach', S)).toEqual([0, 0, 0]);
    expect([await video(S), await video(Z)]).toEqual([`mux:play-${V}`, 'refused']);
  });

  it('a replay of the same purchase event delivers nothing new', async () => {
    await replay(purchases.S, S);
    await tick();
    expect([await drops(purchases.S), await holds(S)]).toEqual([afterTick, [1, 1, 1, 1]]);
  });

  it('a guest checkout that creates the account with the coach: every item arrives once', async () => {
    purchases.G = await pay(G, 'storefront_guest', (tx) => person(G, 'student', K, tx));
    expect([await drops(purchases.G), await holds(G)]).toEqual([deferred, [1, 1, 0, 0]]);
    await tick();
    expect([await drops(purchases.G), await holds(G), await sees(G, 'student', G)]).toEqual([afterTick, [1, 1, 1, 1], [1, 1, 1]]);
    expect(await video(G)).toBe(`mux:play-${V}`);
  });

  it('a client already with the coach: everything arrives in the purchase transaction, as before', async () => {
    purchases.A = await pay(A, 'in_app_hosted');
    expect([await drops(purchases.A), await holds(A), await sees(A, 'student', A)]).toEqual([inline, [1, 1, 1, 1], [1, 1, 1]]);
  });

  it('a coach outside the client\'s scope is still refused: nothing commits', async () => {
    await expect(pay(Z, 'in_app_hosted')).rejects.toBeInstanceOf(SubCoachOutOfScopeError);
    expect(await coachOf(Z)).toBe(L);
    expect(await prisma.clientPurchase.count({ where: { client_user_id: Z } })).toBe(0);
    expect(await holds(Z)).toEqual([0, 0, 0, 0]);
  });
});
