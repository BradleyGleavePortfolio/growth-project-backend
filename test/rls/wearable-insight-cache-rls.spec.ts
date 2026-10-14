/**
 * WearableInsightCache row security on the replayed migration chain (owner 4,
 * A1H follow-up): a client's current coach reads the client's own insight row
 * and only the coach-side row cached for them (side 'coach:<their id>', as
 * backend #947 stores it), never the row cached for the client's old coach or
 * a legacy shared 'coach' row. The old coach reads nothing. The client reads
 * only their client-side row and owners read every row, as before.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('wearable-insight-cache-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('WearableInsightCache: a coach reads only their own row', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const oldCoach = randomUUID();
  const newCoach = randomUUID();
  const owner = randomUUID();
  const client = randomUUID();
  const role: Record<string, string> = {
    [oldCoach]: 'coach',
    [newCoach]: 'coach',
    [owner]: 'owner',
    [client]: 'student',
  };
  const allSides = ['client', 'coach', `coach:${oldCoach}`, `coach:${newCoach}`].sort();

  beforeAll(async () => {
    // The client has moved from oldCoach to newCoach; each coach has a cached row.
    for (const id of [oldCoach, newCoach, owner, client]) {
      await prisma.$executeRaw`INSERT INTO "User"
          ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id}, ${id}, ${`wic-rls-${id}`}, 'RLS user', ${role[id]}::"Role",
          ${id === client ? newCoach : null})`;
    }
    for (const side of allSides) {
      await prisma.$executeRaw`INSERT INTO "WearableInsightCache"
          ("id", "user_id", "side", "bucket", "window_days", "payload", "model_used",
           "prompt_version", "expires_at")
        VALUES (${randomUUID()}, ${client}, ${side}, 'HEALTH_FITNESS', 14, '{}'::jsonb,
          'rls-test', 'rls-test', now() + interval '6 hours')`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // The client's rows the signed-in API role sees with `reader`'s RLS context.
  const sidesSeenBy = (reader: string | null) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (reader) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          role[reader],
        );
      }
      const rows = await tx.$queryRaw<{ side: string }[]>`
        SELECT "side" FROM "WearableInsightCache" WHERE "user_id" = ${client}`;
      return rows.map((r) => r.side).sort();
    });

  it('every row exists for the backend connection', async () => {
    const rows = await prisma.wearableInsightCache.findMany({
      where: { user_id: client },
      select: { side: true },
    });
    expect(rows.map((r) => r.side).sort()).toEqual(allSides);
  });

  it("the current coach reads the client's row and their own row, not the old coach's or the shared one", async () => {
    expect(await sidesSeenBy(newCoach)).toEqual(['client', `coach:${newCoach}`].sort());
  });

  it('the old coach reads no row, not even the one cached for them', async () => {
    expect(await sidesSeenBy(oldCoach)).toEqual([]);
  });

  it('the client reads only their client-side row', async () => {
    expect(await sidesSeenBy(client)).toEqual(['client']);
  });

  it('an owner reads every row', async () => {
    expect(await sidesSeenBy(owner)).toEqual(allSides);
  });

  it('no RLS context reads no row', async () => {
    expect(await sidesSeenBy(null)).toEqual([]);
  });
});
