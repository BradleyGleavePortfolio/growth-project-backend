/**
 * STORE-1TO1 (owner #183-S1): every package includes 1:1 coaching with the coach who sells it, live
 * on the replayed migration chain. Coach K sells PK to his client S: an ordinary coach, so his
 * package publishes and every in-app purchase path passes the package gate. Then one coach per state
 * that cannot coach one to one, each with a published package and a client of his own: D was a coach
 * and is now a client account (role student), X has his account locked for deletion
 * (deletion_scheduled_at), E has no name, and B is an ordinary coach whom his client SB has blocked.
 * The real package routes (create, publish, PATCH back on sale) refuse D, X and E; every real
 * in-app buy path (the client list and detail, hosted checkout, payment intent, subscription intent,
 * free claim) refuses all four, while K sells on. Reads run as the non-bypass `authenticated` role;
 * every 0 follows a read that returned 1. Gate: TEST_DATABASE_URL; no URL -> skip, except under
 * CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { PrismaService } from '../../src/prisma.service';
import { CheckoutService } from '../../src/checkout/checkout.service';
import { SubscriptionCheckoutService } from '../../src/checkout/subscription-checkout.service';
import { PackagesService } from '../../src/packages/packages.service';
import { ClientPackagesController, CoachPackagesController } from '../../src/packages/packages.controller';
import { InviteGrantService } from '../../src/invite-grant/invite-grant.service';
import { TrialUsageService } from '../../src/packages/trials/trial-usage.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('store-1to1-coaching-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

const stub = <T>(value: unknown): T => value as T;
const quiet = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => 'not_configured') });

(DB_URL ? describe : describe.skip)('STORE-1TO1: a package sells only with its coach\'s 1:1 coaching', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const [K, D, X, E, B, S, SD, SX, SE, SB] = ['K', 'D', 'X', 'E', 'B', 'S', 'SD', 'SX', 'SE', 'SB'].map((t) => `${t}-${run}`);
  const pkgOf = (coach: string) => `P${coach}`;
  /** coach -> his client; D is created as a student (a former coach). */
  const pairs = [[K, S], [D, SD], [X, SX], [E, SE], [B, SB]] as const;
  const packages = new PackagesService(prisma, new SubCoachScopeService(prisma));
  const authoring = new CoachPackagesController(packages);
  const catalog = new ClientPackagesController(packages, prisma, new TrialUsageService(prisma));
  const checkout = new CheckoutService(
    prisma,
    stub<ConstructorParameters<typeof CheckoutService>[1]>({}),
    packages,
    stub<ConstructorParameters<typeof CheckoutService>[3]>({ ready: true }),
    stub<ConstructorParameters<typeof CheckoutService>[4]>({}),
    stub<ConstructorParameters<typeof CheckoutService>[5]>({}),
  );
  const plans = new SubscriptionCheckoutService(prisma, stub<never>({}), packages, stub<never>({ ready: true }), stub<never>({}), stub<never>({}));
  const grants = new InviteGrantService(prisma, stub<never>(quiet));
  /** A route's refusal code (or 'done'): for a purchase, the first check past the package gate. */
  const answer = (call: Promise<unknown>) =>
    call.then(
      () => 'done',
      (e: unknown) => String((e as { response?: { error?: string } }).response?.error ?? e),
    );
  const client = (who: string, coach: string) => stub<AuthedRequest>({ user: { id: who, role: 'student', coach_id: coach } });
  /** Every in-app way `who` sees or starts paying for (or claims) `coach`'s package. */
  const everyBuy = async (who: string, coach: string) => {
    const id = pkgOf(coach);
    const listed = await catalog.list(client(who, coach));
    return [
      listed.packages.map((p) => p.id).join(',') || 'none',
      await answer(catalog.detail(client(who, coach), id)),
      await answer(checkout.createCheckoutForClient(who, { package_id: id })),
      await answer(checkout.createPaymentIntentForClient(who, { package_id: id, idempotency_key: randomUUID() })),
      await answer(plans.createSubscriptionIntent(who, stub<never>({ package_id: id }))),
      await answer(grants.claimFreePackage({ id: who, role: 'student', coach_id: coach }, id)),
    ];
  };
  /** `coach`'s package routes: create, publish his package, PATCH it back on sale. */
  const everyWrite = async (coach: string) => {
    const req = stub<AuthedRequest>({ user: { id: coach } });
    const out = [
      await answer(authoring.create(req, stub<never>({ name: 'New', amount_cents: 10000 }), undefined, { setHeader: () => undefined })),
      await answer(authoring.publish(req, pkgOf(coach))),
      await answer(authoring.update(req, pkgOf(coach), stub<never>({ is_active: true }))),
    ];
    await prisma.coachPackage.deleteMany({ where: { coach_id: coach, id: { not: pkgOf(coach) } } });
    return out;
  };
  /** Put `coach`'s package back to published + on sale whatever a write did, so a buy is tested on its own. */
  const onSale = (coach: string) =>
    prisma.coachPackage.update({ where: { id: pkgOf(coach) }, data: { is_active: true, published_at: new Date() } });
  /** Rows of CoachPackage with id `id` that `who` reads as the signed-in API role. */
  const reads = (who: string, coachRole: boolean, id: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, coachRole ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "CoachPackage" WHERE "id" = $1`, id);
      return rows[0].n;
    });
  // No Connect account in this database: a package past the gate stops at the next check.
  const selling = (coach: string) => [pkgOf(coach), 'done', 'COACH_NOT_CONNECTED', 'COACH_NOT_CONNECTED', 'ONE_TIME_REQUIRES_PAYMENT_INTENT', 'PACKAGE_NOT_FREE'];
  const refused = ['none', 'PACKAGE_NOT_FOUND', 'PACKAGE_NOT_FOUND', 'PACKAGE_NOT_FOUND', 'PACKAGE_NOT_FOUND', 'PACKAGE_NOT_FOUND'];

  beforeAll(async () => {
    for (const [coach, who] of pairs) {
      await prisma.user.create({
        data: {
          id: coach,
          supabase_id: coach,
          email: `s1to1-${coach}`,
          name: coach === E ? '' : 'Coach Live',
          role: coach === D ? 'student' : 'coach',
          deletion_scheduled_at: coach === X ? new Date(Date.now() + 864e5) : null,
        },
      });
      await prisma.user.create({ data: { id: who, supabase_id: who, email: `s1to1-${who}`, name: 'Client Live', role: 'student', coach_id: coach } });
      await prisma.coachPackage.create({
        data: { id: pkgOf(coach), coach_id: coach, name: 'Programme', amount_cents: 10000, published_at: new Date() },
      });
    }
    await prisma.userBlock.create({ data: { blocker_id: SB, blocked_id: B } });
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security; a coach reads only his own packages', async () => {
    expect(await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      return tx.$queryRaw<{ bypass: boolean }[]>`SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`;
    })).toEqual([{ bypass: false }]);
    expect(await reads(K, true, pkgOf(K))).toBe(1);
    expect(await reads(B, true, pkgOf(K))).toBe(0);
    expect(await reads(S, false, pkgOf(K))).toBe(0);
  });

  it('an ordinary coach publishes and sells, by every route', async () => {
    expect(await everyWrite(K)).toEqual(['done', 'done', 'done']);
    expect(await everyBuy(S, K)).toEqual(selling(K));
  });

  it.each([
    ['a former coach (now a client account)', D],
    ['a coach whose account is locked for deletion', X],
    ['a coach with no name', E],
  ])('%s cannot publish or put back on sale, and nothing of his sells in the app', async (_state, coach) => {
    expect(await everyWrite(coach)).toEqual(['Forbidden', 'Forbidden', 'Forbidden']);
    await expect(packages.resolveSellingCoachId(coach)).rejects.toThrow(
      coach === X ? 'Account is scheduled for deletion; cancel the deletion to regain access' : 'Coach access required',
    );
    await onSale(coach);
    const who = pairs.find(([c]) => c === coach)![1];
    expect(await everyBuy(who, coach)).toEqual(refused);
  });

  it('a coach his client has blocked still publishes, but sells that client nothing; his other buyers and K are untouched', async () => {
    expect(await everyWrite(B)).toEqual(['done', 'done', 'done']);
    expect(await everyBuy(SB, B)).toEqual(refused);
    await prisma.userBlock.deleteMany({ where: { blocker_id: SB, blocked_id: B } });
    expect(await everyBuy(SB, B)).toEqual(selling(B));
    expect(await everyBuy(S, K)).toEqual(selling(K));
  });
});
