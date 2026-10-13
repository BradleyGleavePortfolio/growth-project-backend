/**
 * CoachMessage row security after a client moves (owner 4, GAPS1, migration
 * 20270412000000): the old coach, and a teammate who wrote in the old thread,
 * read nothing of the moved client's chat and can't write into it. The client
 * still reads every row of their own (nothing is deleted) and the new coach
 * reads only the new thread. The old coach keeps reading the client who stayed.
 * InviteCode rows stay with the coach who issued them: the new coach and the
 * client read none of them.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-message-move-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('CoachMessage and InviteCode after a client moves', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const [oldCoach, teammate, newCoach, client, stayer] = [1, 2, 3, 4, 5].map(() => randomUUID());
  const role: Record<string, string> = {
    [oldCoach]: 'coach',
    [teammate]: 'coach',
    [newCoach]: 'coach',
    [client]: 'student',
    [stayer]: 'student',
  };
  // The client has moved from oldCoach to newCoach; stayer is still with oldCoach.
  const coachOf: Record<string, string> = { [client]: newCoach, [stayer]: oldCoach };
  const msg = {
    old: randomUUID(),
    reply: randomUUID(),
    team: randomUUID(),
    fresh: randomUUID(),
    stay: randomUUID(),
  };
  const invite = randomUUID();

  const insertMessage = (tx: Prisma.TransactionClient, row: [string, string, string, string]) =>
    tx.$executeRaw`INSERT INTO "CoachMessage" ("id", "coach_id", "client_id", "sender_id", "body")
      VALUES (${row[0]}, ${row[1]}, ${row[2]}, ${row[3]}, 'RLS row')`;

  beforeAll(async () => {
    for (const id of Object.keys(role)) {
      await prisma.$executeRaw`INSERT INTO "User"
          ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id}, ${id}, ${`cm-rls-${id}`}, 'RLS user', ${role[id]}::"Role",
          ${coachOf[id] ?? null})`;
    }
    await insertMessage(prisma, [msg.old, oldCoach, client, oldCoach]); // before the move
    await insertMessage(prisma, [msg.reply, oldCoach, client, client]); // before the move
    await insertMessage(prisma, [msg.team, oldCoach, client, teammate]); // a teammate wrote
    await insertMessage(prisma, [msg.fresh, newCoach, client, newCoach]); // after the move
    await insertMessage(prisma, [msg.stay, oldCoach, stayer, stayer]);
    await prisma.$executeRaw`INSERT INTO "InviteCode"
        ("id", "code", "coach_id", "accepted_by_user_id", "accepted_at")
      VALUES (${invite}, ${`cm-rls-${invite}`}, ${oldCoach}, ${client}, now())`;
  });
  afterAll(() => prisma.$disconnect());

  // Runs `fn` as the signed-in API role with `reader`'s RLS context.
  const as = <T>(reader: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (reader) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          role[reader],
        );
      }
      return fn(tx);
    });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
  const messagesSeenBy = (reader: string | null) =>
    as(reader, async (tx) =>
      ids(
        await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "CoachMessage" WHERE "id" IN (${Prisma.join(Object.values(msg))})`,
      ),
    );
  const invitesSeenBy = (reader: string) =>
    as(reader, async (tx) =>
      ids(await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "InviteCode" WHERE "id" = ${invite}`),
    );

  it("the old coach reads only the client who stayed, not the moved client's old thread", async () => {
    expect(await messagesSeenBy(oldCoach)).toEqual([msg.stay]);
  });

  it('a teammate who wrote in the old thread reads nothing of it', async () => {
    expect(await messagesSeenBy(teammate)).toEqual([]);
  });

  it('the old coach cannot write into the old thread', async () => {
    await expect(
      as(oldCoach, (tx) => insertMessage(tx, [randomUUID(), oldCoach, client, oldCoach])),
    ).rejects.toThrow(/42501|row-level security/);
  });

  it('the client reads every row of their own, the old thread included', async () => {
    expect(await messagesSeenBy(client)).toEqual(
      [msg.old, msg.reply, msg.team, msg.fresh].sort(),
    );
  });

  it('the new coach reads only the new thread', async () => {
    expect(await messagesSeenBy(newCoach)).toEqual([msg.fresh]);
  });

  it('no RLS context reads no row', async () => {
    expect(await messagesSeenBy(null)).toEqual([]);
  });

  it('an invite row stays with its coach: the new coach and the client read none', async () => {
    expect(await invitesSeenBy(oldCoach)).toEqual([invite]);
    expect(await invitesSeenBy(newCoach)).toEqual([]);
    expect(await invitesSeenBy(client)).toEqual([]);
  });
});
