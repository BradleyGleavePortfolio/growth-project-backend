/**
 * MEDIA-ARCHIVE-BUYER (#COACH-GONE-FILES: clients keep what they paid for), live on the replayed
 * migration chain. Coach K sells PDF V: client B holds an active grant through a drop of B's
 * purchase from K, client R a revoked one, client N none. Coach L's client Z holds a grant on V
 * through a drop of Z's purchase from L (cross-tenant). K's PDF W is sold to nobody. K archives V
 * and W through the real CoachMediaService.softDelete; buyers read through the real
 * getBuyerSignedUrl (GET /v1/client/media/:id/signed-url), the only read path of these
 * server-only tables. The storage stub records deleted objects and refuses to sign one, so a URL
 * for a gone file fails loudly. Every refusal is the unknown-id 404 body; every 0 follows a read
 * of the same row that returned 1. The tests run in order. Gate: TEST_DATABASE_URL; no URL ->
 * skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { CoachMediaService } from '../../src/coach-media/coach-media.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('media-archive-buyer-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

type Svc = ConstructorParameters<typeof CoachMediaService>;
function stub<T>(value: unknown): T {
  return value as T;
}

(DB_URL ? describe : describe.skip)('MEDIA-ARCHIVE-BUYER: a buyer keeps paid media after the archive', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const [K, L, B, R, N, Z, T] = ['K', 'L', 'B', 'R', 'N', 'Z', 'T'].map((tag) => `${tag}-${run}`);
  const [V, W] = [randomUUID(), randomUUID()];
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

  beforeAll(async () => {
    const people = [[K, null], [L, null], [B, K], [R, K], [N, K], [Z, L], [T, K]] as const;
    for (const [id, coach_id] of people) {
      const role = coaches.has(id) ? 'coach' : 'student';
      await prisma.user.create({ data: { id, supabase_id: id, email: `archive-${id}`, name: 'Live person', role, coach_id } });
    }
    for (const id of [V, W]) {
      await prisma.coachMediaAsset.create({
        data: { id, coach_id: K, kind: 'pdf', title: 'Guide', status: 'ready', provider: 'supabase', storage_key: `${K}/${id}.pdf` },
      });
    }
    // B bought V from K; Z's purchase is from L, yet a grant on K's V hangs off its drop.
    for (const [buyer, coach] of [[B, K], [Z, L]] as const) {
      const pkg = await prisma.coachPackage.create({ data: { coach_id: coach, name: 'Plan', amount_cents: 5000 } });
      const purchase = await prisma.clientPurchase.create({
        data: {
          client_user_id: buyer, coach_user_id: coach, package_id: pkg.id, amount_cents: 5000,
          status: 'paid', entitlement_active: true,
          stripe_checkout_session_id: `cs_${buyer}`, idempotency_key: `idem_${buyer}`,
        },
      });
      const drop = await prisma.scheduledDrop.create({
        data: {
          client_purchase_id: purchase.id, content_id: purchase.id, asset_type: 'pdf', asset_id: V,
          cadence_kind: 'offset_days', cadence_payload: {}, status: 'fired',
        },
      });
      await prisma.clientAssetGrant.create({ data: { client_id: buyer, media_asset_id: V, granted_via_drop_id: drop.id } });
    }
    await prisma.clientAssetGrant.create({ data: { client_id: R, media_asset_id: V, revoked_at: new Date() } });
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
  const rowV = Prisma.sql`SELECT "id" FROM "CoachMediaAsset" WHERE "id" = ${V}`;
  const grantB = Prisma.sql`SELECT "id" FROM "ClientAssetGrant" WHERE "client_id" = ${B}`;

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(B, Prisma.sql`SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`))
      .toEqual([{ bypass: false }]);
  });

  it('before the archive: B opens V; the revoked, the ungranted, the cross-tenant buyer and coach L are refused', async () => {
    expect(await prisma.coachMediaAsset.count({ where: { id: V } })).toBe(1);
    expect(await prisma.clientAssetGrant.count({ where: { client_id: B } })).toBe(1);
    for (const who of [B, Z]) expect(DENIED).toContain(await direct(who, rowV));
    expect(DENIED).toContain(await direct(B, grantB));
    expect(await open(B, V)).toBe(`signed:${K}/${V}.pdf`);
    for (const who of [R, N, Z, L]) expect(await open(who, V)).toBe('refused');
  });

  it('K archives V: the file stays and B still opens it; everyone else gets the unknown-id 404', async () => {
    expect(await media.softDelete(K, V)).toMatchObject({ id: V, object_deleted: false });
    expect(await prisma.coachMediaAsset.count({ where: { id: V, archived_at: { not: null } } })).toBe(1);
    expect(deleted.size).toBe(0);
    expect(await open(B, V)).toBe(`signed:${K}/${V}.pdf`);
    for (const who of [R, N, Z, L, K]) expect(await open(who, V)).toBe('refused');
    expect(await open(B, randomUUID())).toBe('refused');
    for (const who of [B, Z]) expect(DENIED).toContain(await direct(who, rowV));
  });

  it('K archives unsold W: the file is deleted, and a grant minted after the archive is refused, never signed', async () => {
    const archived = await media.softDelete(K, W);
    expect(archived).toMatchObject({ id: W, object_deleted: true });
    expect([...deleted]).toEqual([`${K}/${W}.pdf`]);
    const late = new Date(archived.archived_at.getTime() + 1000);
    await prisma.clientAssetGrant.create({ data: { client_id: T, media_asset_id: W, granted_at: late } });
    expect(await prisma.clientAssetGrant.count({ where: { client_id: T, media_asset_id: W, revoked_at: null } })).toBe(1);
    expect(await open(T, W)).toBe('refused');
    expect(await open(B, V)).toBe(`signed:${K}/${V}.pdf`);
  });
});
