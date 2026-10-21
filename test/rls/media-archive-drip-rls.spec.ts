/**
 * MEDIA-ARCHIVE-DRIP (paid drip files survive an archive; #162-2 op 1: a refund stops only what
 * has not shipped), live on the replayed migration chain. Coach K drips PDF D: client P (paid)
 * and client F (refunded, the purchase flipped by a refund writer that cancels nothing) each hold
 * a drop of D that has not fired; coach L's client Z holds a drop of K's D through Z's purchase
 * from L (cross-tenant). F also got PDF E before the refund (shipped drop + grant). PDF C is held
 * only by drops that will never ship (refund-canceled, failed). K archives D, E and C through the
 * real CoachMediaService.softDelete; client Q's drop of D is written after the archive (a later
 * buyer). The real DripDispatcherCron then runs with the real MediaAssetResolver and the real
 * SubCoachScopeService; buyers read through the real getBuyerSignedUrl (GET
 * /v1/client/media/:id/signed-url), the only read path of these server-only tables. The storage
 * stub records deleted objects and refuses to sign one. Every refusal is the unknown-id 404 body;
 * every denied direct read follows a read of the same row that returned 1. The tests run in
 * order. Gate: TEST_DATABASE_URL; no URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { CoachMediaService } from '../../src/coach-media/coach-media.service';
import { DripDispatcherCron } from '../../src/packages/drip-dispatcher.cron';
import { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { MediaAssetResolver } from '../../src/packages/asset-resolvers/media-asset.resolver';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('media-archive-drip-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

type Svc = ConstructorParameters<typeof CoachMediaService>;
function stub<T>(value: unknown): T {
  return value as T;
}

(DB_URL ? describe : describe.skip)('MEDIA-ARCHIVE-DRIP: a drip file archived before its drop still reaches the buyer', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const [K, L, P, F, Q, Z] = ['K', 'L', 'P', 'F', 'Q', 'Z'].map((tag) => `${tag}-${run}`);
  const [D, E, C] = [randomUUID(), randomUUID(), randomUUID()];
  const coaches = new Set([K, L]);
  const deleted = new Set<string>();
  const media = new CoachMediaService(
    stub<Svc[0]>(prisma),
    stub<Svc[1]>({
      isConfigured: () => true,
      deleteObject: async (key: string) => deleted.add(key).has(key),
      createSignedDownloadUrl: async (key: string) => {
        if (deleted.has(key)) throw new Error(`signed a deleted object: ${key}`);
        return `signed:${key}`;
      },
    }),
    stub<Svc[2]>({}),
    stub<Svc[3]>({}),
    stub<Svc[4]>({}),
  );
  const dispatcher = new DripDispatcherCron(
    prisma,
    new AssignableAssetResolverRegistry([
      new MediaAssetResolver(prisma, new ResolverSubCoachScope(new SubCoachScopeService(prisma))),
    ]),
  );
  /** The URL `who` gets for `asset`, or 'refused' for the unknown-id 404 body (any other error throws). */
  const open = (who: string, asset: string) =>
    media.getBuyerSignedUrl(who, asset).then(
      (r) => r.url,
      (e: unknown) => {
        const body = e instanceof NotFoundException ? e.getResponse() : null;
        if (JSON.stringify(body) === JSON.stringify({ error: 'ASSET_NOT_FOUND', message: `No media asset with id ${asset}` })) {
          return 'refused';
        }
        throw e;
      },
    );
  const purchases = new Map<string, string>();
  const drops = new Map<string, string>();
  const buy = async (buyer: string, coach: string, status: string, entitlement_active: boolean) => {
    const pkg = await prisma.coachPackage.create({ data: { coach_id: coach, name: 'Plan', amount_cents: 5000 } });
    const purchase = await prisma.clientPurchase.create({
      data: {
        client_user_id: buyer, coach_user_id: coach, package_id: pkg.id, amount_cents: 5000, status, entitlement_active,
        stripe_checkout_session_id: `cs_${buyer}`, idempotency_key: `idem_${buyer}`,
      },
    });
    purchases.set(buyer, purchase.id);
  };
  const drop = async (key: string, buyer: string, asset: string, data: Partial<Prisma.ScheduledDropUncheckedCreateInput>) => {
    const row = await prisma.scheduledDrop.create({
      data: {
        client_purchase_id: purchases.get(buyer)!, content_id: randomUUID(), asset_type: 'pdf', asset_id: asset,
        cadence_kind: 'offset_days', cadence_payload: {}, fire_at: new Date(Date.now() - 60_000), status: 'pending', ...data,
      },
    });
    drops.set(key, row.id);
    return row.id;
  };
  const dropRow = (key: string) => prisma.scheduledDrop.findUniqueOrThrow({ where: { id: drops.get(key)! } });
  const grants = (who: string, asset: string) => prisma.clientAssetGrant.count({ where: { client_id: who, media_asset_id: asset } });

  beforeAll(async () => {
    const people = [[K, null], [L, null], [P, K], [F, K], [Q, K], [Z, L]] as const;
    for (const [id, coach_id] of people) {
      const role = coaches.has(id) ? 'coach' : 'student';
      await prisma.user.create({ data: { id, supabase_id: id, email: `drip-${id}`, name: 'Live person', role, coach_id } });
    }
    for (const id of [D, E, C]) {
      await prisma.coachMediaAsset.create({
        data: { id, coach_id: K, kind: 'pdf', title: 'Guide', status: 'ready', provider: 'supabase', storage_key: `${K}/${id}.pdf` },
      });
    }
    await buy(P, K, 'paid', true);
    await buy(F, K, 'refunded', false);
    await buy(Q, K, 'paid', true);
    await buy(Z, L, 'paid', true);
    await drop('P-D', P, D, {});
    await drop('F-D', F, D, {});
    await drop('Z-D', Z, D, {});
    const shipped = await drop('F-E', F, E, { status: 'delivered', fired_at: new Date() });
    await prisma.clientAssetGrant.create({ data: { client_id: F, media_asset_id: E, granted_via_drop_id: shipped } });
    await drop('F-C', F, C, { status: 'canceled', failure_reason: 'canceled:refund' });
    await drop('P-C', P, C, { status: 'failed', failure_reason: 'gave up' });
  });
  afterAll(() => prisma.$disconnect());

  /** `sql` run as the signed-in API role (app.current_user_id = who). */
  const as = <T>(who: string, sql: Prisma.Sql) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, coaches.has(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return tx.$queryRaw<T[]>(sql);
    });
  /** A server-only row read directly as `who`: the row count, or the SQLSTATE of a refused read. */
  const direct = (who: string, sql: Prisma.Sql) =>
    as(who, sql).then(
      (rows): number | string => rows.length,
      (e: unknown) => {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        return String(err.code === 'P2010' ? err.meta?.code : /\b42501\b/.exec(String(err.message))?.[0] ?? err.message);
      },
    );
  // Server-only tables (20261224000000): zero rows (RESTRICTIVE false) or 42501, both a denial.
  const DENIED: Array<number | string> = [0, '42501'];
  const ownDrops = (who: string) => Prisma.sql`SELECT d."id" FROM "ScheduledDrop" d JOIN "ClientPurchase" p ON p."id" = d."client_purchase_id" WHERE p."client_user_id" = ${who}`;
  const ownGrants = (who: string) => Prisma.sql`SELECT "id" FROM "ClientAssetGrant" WHERE "client_id" = ${who}`;

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(P, Prisma.sql`SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`))
      .toEqual([{ bypass: false }]);
  });

  it('before the archive: drops and grants are server-only (no direct read for the buyer or another tenant)', async () => {
    expect(await prisma.scheduledDrop.count({ where: { id: drops.get('P-D') } })).toBe(1);
    expect(await prisma.clientAssetGrant.count({ where: { client_id: F } })).toBe(1);
    for (const who of [P, Z, L]) expect(DENIED).toContain(await direct(who, ownDrops(P)));
    for (const who of [F, Z, L]) expect(DENIED).toContain(await direct(who, ownGrants(F)));
    expect(await open(P, D)).toBe('refused'); // nothing shipped yet
    expect(await open(F, E)).toBe(`signed:${K}/${E}.pdf`);
  });

  it('K archives D, E and C: the drops still owed keep D, the grant keeps E, only C (never shipping) is deleted', async () => {
    expect(await media.softDelete(K, D)).toMatchObject({ id: D, object_deleted: false });
    expect(await media.softDelete(K, E)).toMatchObject({ id: E, object_deleted: false });
    const archivedC = await media.softDelete(K, C);
    expect(archivedC).toMatchObject({ id: C, object_deleted: true });
    expect([...deleted]).toEqual([`${K}/${C}.pdf`]);
    expect(await prisma.coachMediaAsset.count({ where: { id: { in: [D, E, C] }, archived_at: { not: null } } })).toBe(3);
  });

  it('the drop fires after the archive: P gets D; the refunded F, the later buyer Q and the cross-tenant Z do not', async () => {
    const { archived_at } = await prisma.coachMediaAsset.findUniqueOrThrow({ where: { id: D } });
    await drop('Q-D', Q, D, { created_at: new Date(archived_at!.getTime() + 1000) });
    await dispatcher.runOnce(new Date());

    const p = await dropRow('P-D');
    expect(p).toMatchObject({ status: 'delivered' });
    const grantP = await prisma.clientAssetGrant.findUniqueOrThrow({ where: { client_id_media_asset_id: { client_id: P, media_asset_id: D } } });
    expect(grantP).toMatchObject({ granted_via_drop_id: drops.get('P-D'), revoked_at: null, id: p.materialised_ref });
    expect(grantP.granted_at.getTime()).toBeGreaterThan(archived_at!.getTime());
    // #162-2: F's refund stops the drop that had not shipped; nothing is granted.
    expect(await dropRow('F-D')).toMatchObject({ status: 'canceled', failure_reason: 'canceled:refund', materialised_ref: null });
    for (const key of ['Q-D', 'Z-D']) {
      expect(await dropRow(key)).toMatchObject({ status: 'pending', materialised_ref: null });
    }
    for (const who of [F, Q, Z]) expect(await grants(who, D)).toBe(0);
  });

  it('after: P opens D, F still opens E (shipped before the refund); everyone else is refused and nothing deleted is signed', async () => {
    expect(await open(P, D)).toBe(`signed:${K}/${D}.pdf`);
    expect(await open(F, E)).toBe(`signed:${K}/${E}.pdf`);
    for (const who of [F, Q, Z, L, K]) expect(await open(who, D)).toBe('refused');
    for (const who of [P, F]) expect(await open(who, C)).toBe('refused');
    expect(await prisma.clientAssetGrant.count({ where: { client_id: P } })).toBe(1);
    for (const who of [P, Z, L]) expect(DENIED).toContain(await direct(who, ownGrants(P)));
    for (const who of [P, Z]) expect(DENIED).toContain(await direct(who, ownDrops(P)));
  });
});
