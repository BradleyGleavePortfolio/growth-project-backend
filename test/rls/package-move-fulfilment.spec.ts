/**
 * PKG-MOVE-FULFILMENT (owner 4, 137-8: the old coach loses a moved client's
 * history at once; and a buyer gets what they paid for, or a truthful outcome
 * at once). A package takes only the coach's own workouts, and a day an older
 * build attached from a client's copy ("retained") never stalls a paid sale.
 * One row per path that writes or delivers a package workout, each with a
 * fresh client C of coach A (C's copy day) and a fresh buyer X of A:
 *   attach          a saved workout and a master's day attach; a client's copy
 *                   day (staying, moved, or a legacy clone) is refused
 *   checkout (immediate and delayed), push to existing buyers: C moves to
 *                   coach B, then the sale commits, A's saved workout reaches
 *                   X, the retained day fails at the dispatcher's first tick
 *                   with one coach alert, and X never gets C's day
 *   package push    the coach's push of the retained day is refused at once
 * A reads C's day signed in (non-bypass role): 1 before the move, 0 after; X
 * signed in sees the saved workout's assignment (1) and none of C's day (0).
 * Real services on the superuser connection (service_role, as the API runs).
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { CoachPackage, Prisma } from '@prisma/client';
import type { AuditService } from '../../src/audit/audit.service';
import type {
  CreateNotificationInput,
  NotificationsService,
} from '../../src/notifications/notifications.service';
import { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';
import { WorkoutAssetResolver } from '../../src/packages/asset-resolvers/workout.resolver';
import { DripDispatcherCron } from '../../src/packages/drip-dispatcher.cron';
import { PackageContentsService } from '../../src/packages/package-contents.service';
import { PackagePushService } from '../../src/packages/package-push.service';
import type { PackagesService } from '../../src/packages/packages.service';
import { PurchaseFanoutService } from '../../src/packages/purchase-fanout.service';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { ProgramDeliveryService } from '../../src/workout-builder/program-delivery.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('package-move-fulfilment: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('A paid package after its source client moves', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  const scope = new SubCoachScopeService(prisma);
  const registry = new AssignableAssetResolverRegistry([
    new WorkoutAssetResolver(
      new WorkoutBuilderService(prisma, undefined, scope),
      new ResolverSubCoachScope(scope),
      new ProgramDeliveryService(prisma),
    ),
  ]);
  const push = {
    createNotification: jest.fn(async (_n: CreateNotificationInput) => null),
    sendPush: jest.fn(async () => null),
  };
  const sink: Partial<NotificationsService> = push;
  const packages = stub<PackagesService>({ requireOwnedPackage: async () => stub<CoachPackage>({}) });
  const audit = stub<AuditService>({ write: async () => undefined });
  const contents = new PackageContentsService(prisma, packages, scope, audit);
  const fanout = new PurchaseFanoutService(registry, undefined, undefined, prisma);
  const cron = new DripDispatcherCron(prisma, registry, sink as NotificationsService);
  const pusher = new PackagePushService(prisma, packages, registry, sink as NotificationsService);
  // Fictional people, fresh ids per run. Coaches a and b.
  const [a, b] = [randomUUID(), randomUUID()];
  const now = { cadence_kind: 'immediate', cadence_payload: {} };
  const later = { cadence_kind: 'relative_to_purchase', cadence_payload: { offset_days: 1 } };
  const DAY = 86_400_000;

  const person = (id: string, role: 'coach' | 'student', coach_id: string | null) =>
    prisma.user.create({
      data: { id, supabase_id: id, email: `pkgmove-${id}`, name: 'Live person', role, coach_id },
    });
  /** A workout of `coach`: saved (no program), or day 1 of a program. */
  const workout = async (coach: string, program?: { is_template: boolean; client_id: string | null }) => {
    const shape = { coach_id: coach, owner_user_id: coach, name: 'Block', weeks: 1, days_per_week: 1 };
    const p = program && (await prisma.workoutProgram.create({ data: { ...shape, ...program } }));
    const at = p ? { program_id: p.id, week_index: 0, day_index: 0 } : {};
    const data = { coach_id: coach, name: 'Private day of C', type: 'strength' as const, ...at };
    return (await prisma.workoutPlan.create({ data })).id;
  };
  /** 'ok', or the existing refusal code. */
  type Refusal = { getResponse?: () => { error?: string } };
  const outcome = (call: Promise<unknown>) =>
    call.then(
      () => 'ok',
      (e: Refusal) => e.getResponse?.()?.error ?? String(e),
    );
  const attach = (pkg: string, asset_id: string, cadence = now) =>
    outcome(contents.attach(a, a, pkg, { asset_type: 'workout_plan', asset_id, ...cadence }));
  /** The row as `user` signed in through the API role (row security applies). */
  const signedIn = <T>(user: string, role: string, read: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, user);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: user }));
      return read(tx);
    });
  const coachSees = (day: string) => signedIn(a, 'coach', (tx) => tx.workoutPlan.count({ where: { id: day } }));

  /** Fresh C (A's client, with a copy day), buyer X and A's package. */
  const fixture = async () => {
    const [c, x] = [randomUUID(), randomUUID()];
    await person(c, 'student', a);
    await person(x, 'student', a);
    const pkg = (await prisma.coachPackage.create({ data: { coach_id: a, name: 'Block', amount_cents: 4900 } })).id;
    return { c, x, pkg, copy: await workout(a, { is_template: false, client_id: c }) };
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const move = (c: string) => prisma.user.update({ where: { id: c }, data: { coach_id: b } });
  /** X pays: the checkout webhook's fan-out, in its own transaction. */
  const buy = async ({ x, pkg }: Fixture) => {
    const key = randomUUID();
    const p = await prisma.clientPurchase.create({
      data: {
        client_user_id: x, coach_user_id: a, package_id: pkg, amount_cents: 4900, status: 'paid',
        entitlement_active: true, stripe_checkout_session_id: `cs_${key}`, idempotency_key: key,
      },
    });
    const ctx = { entrypoint: 'in_app_hosted' as const, coachId: a, clientId: x };
    await prisma.$transaction((tx) => fanout.onPurchaseEntitled(p, ctx, tx), { timeout: 20_000 });
    return (await prisma.purchaseFanout.findUniqueOrThrow({ where: { purchase_id: p.id } })).state;
  };
  /** A content row an older build attached from C's copy day, before the move. */
  const retain = (f: Fixture, cadence: typeof now) =>
    prisma.coachPackageContent.create({
      data: { package_id: f.pkg, asset_type: 'workout_plan', asset_id: f.copy, display_title: 'Week 1', ...cadence },
    });
  /** The sale, then A's saved workout and C's day as delivered to X. */
  const sale = async (f: Fixture, cadence: typeof now, after: (content: string) => Promise<unknown>, tick: number) => {
    const saved = await workout(a);
    expect(await attach(f.pkg, saved, cadence)).toBe('ok');
    const content = (await retain(f, cadence)).id;
    expect(await coachSees(f.copy)).toBe(1);
    await move(f.c);
    expect(await coachSees(f.copy)).toBe(0);
    const state = await buy(f);
    await after(content);
    await cron.runOnce(new Date(Date.now() + tick));
    const drop = async (asset_id: string) => {
      const d = await prisma.scheduledDrop.findFirstOrThrow({ where: { asset_id } });
      return `${d.status} after ${d.attempt_count}`;
    };
    const alerts = push.createNotification.mock.calls.map(([n]) => n).filter((n) => n.kind === 'coach_alert');
    expect(JSON.stringify(alerts)).not.toContain('Private day of C');
    const assigned = (tx: Prisma.TransactionClient, day: string) =>
      tx.clientWorkoutAssignment.count({ where: { client_id: f.x, workout_plan_id: day } });
    const xSees = await signedIn(f.x, 'student', async (tx) => [await assigned(tx, saved), await assigned(tx, f.copy)]);
    return [state, await drop(saved), await drop(f.copy), `${alerts.length} coach alert`, `X sees ${xSees}`];
  };
  const kept = async () => undefined;
  const sold = (saved: string, xSaved = 1) =>
    ['succeeded', saved, 'failed after 1', '1 coach alert', `X sees ${xSaved},0`];

  // [path, run the path on a fresh fixture, what A, X and the system see]
  const paths: Array<[string, (f: Fixture) => Promise<unknown[]>, unknown[]]> = [
    ['attach a saved workout', async (f) => [await attach(f.pkg, await workout(a))], ['ok']],
    [
      "attach a master's day",
      async (f) => [await attach(f.pkg, await workout(a, { is_template: true, client_id: null }))],
      ['ok'],
    ],
    ["attach a staying client's copy day", async (f) => [await attach(f.pkg, f.copy)], ['ASSET_NOT_FOUND']],
    [
      "attach a moved client's copy day",
      async (f) => [await coachSees(f.copy), await move(f.c).then(() => attach(f.pkg, f.copy)), await coachSees(f.copy)],
      [1, 'ASSET_NOT_FOUND', 0],
    ],
    [
      'attach a legacy clone day (no client on the program)',
      async (f) => [await attach(f.pkg, await workout(a, { is_template: false, client_id: null }))],
      ['ASSET_NOT_FOUND'],
    ],
    ['checkout, immediate (inline fan-out)', (f) => sale(f, now, kept, 0), sold('fired after 1')],
    ['checkout, delayed (drip dispatcher)', (f) => sale(f, later, kept, 2 * DAY), sold('delivered after 1')],
    [
      'push to existing buyers (rescheduled to now)',
      (f) =>
        sale(f, later, async (content) => {
          await prisma.coachPackageContent.update({ where: { id: content }, data: now });
          expect(await contents.pushToExisting(a, f.pkg, content, { push: true })).toMatchObject({ drops_updated: 1 });
        }, 0),
      sold('pending after 0', 0),
    ],
    [
      'package push of the retained day, due now',
      async (f) => {
        await buy(f);
        const content = (await retain(f, now)).id;
        await move(f.c);
        const opts = { audience: 'all' as const, mode: 'push_existing' as const, fireAt: new Date(), notify: false };
        const refused = await pusher
          .pushContentToExistingBuyers(a, f.pkg, content, opts)
          .then(() => 'ok', (e: Error) => e.message);
        return [refused, await prisma.scheduledDrop.count({ where: { content_id: content } })];
      },
      ['Workout plan not found', 0],
    ],
  ];

  beforeAll(async () => {
    await person(a, 'coach', null);
    await person(b, 'coach', null);
  });
  beforeEach(() => push.createNotification.mockClear());
  afterAll(() => prisma.$disconnect());

  it.each(paths)('%s', async (_path, run, expected) => {
    expect(await run(await fixture())).toEqual(expected);
  });
});
