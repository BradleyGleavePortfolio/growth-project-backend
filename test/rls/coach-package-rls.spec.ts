/**
 * CoachPackage row security on the replayed migration chain: the public (anon)
 * and signed-in (authenticated) app keys read zero package rows, even with the
 * owning coach's own token. The backend reads packages through Prisma, which
 * bypasses RLS.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-package-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('CoachPackage: no direct reads with the app keys', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const coachId = randomUUID();

  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name")
      VALUES (${coachId}, ${coachId}, ${`${coachId}@example.test`}, 'RLS coach')`;
    await prisma.$executeRaw`INSERT INTO "CoachPackage" ("id", "coach_id", "name", "amount_cents", "updated_at", "share_token")
      VALUES (${randomUUID()}, ${coachId}, 'RLS package', 1000, now(), ${randomUUID()})`;
  });
  afterAll(() => prisma.$disconnect());

  // Rows the API role sees, as PostgREST would run the request.
  const visible = (role: 'anon' | 'authenticated', claims: object) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify(claims));
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "CoachPackage"`;
      return n;
    });

  it('the package exists for the backend connection', async () => {
    expect(await prisma.coachPackage.count({ where: { coach_id: coachId } })).toBe(1);
  });

  it('anon reads zero rows', async () => {
    expect(await visible('anon', { role: 'anon' })).toBe(0);
  });

  it("authenticated reads zero rows, even with the owning coach's token", async () => {
    expect(await visible('authenticated', { role: 'authenticated', sub: coachId })).toBe(0);
  });
});
