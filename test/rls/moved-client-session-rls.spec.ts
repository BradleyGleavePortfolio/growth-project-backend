/**
 * CoachingSession row security after a move (owner 4, HIST-2b) on the
 * replayed migration chain. The client moved from oldCoach to newCoach, who
 * delegates them to sub. The old coach reads and writes no session with the
 * client, cancelled or past; the new coach reads only the sessions they run,
 * never the old coach's; an unrelated coach or client reads none of them; the
 * client keeps every session but none of the coach-only columns; the sub-coach
 * reads theirs only while the team seat is live.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-client-session-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('CoachingSession: a moved client leaves the old coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const [oldCoach, newCoach, sub, otherCoach, client, otherClient, owner] = Array.from({ length: 7 }, () =>
    randomUUID(),
  );
  const role: Record<string, string> = {
    [oldCoach]: 'coach', [newCoach]: 'coach', [sub]: 'coach', [otherCoach]: 'coach',
    [client]: 'student', [otherClient]: 'student', [owner]: 'owner',
  };
  const coachOf: Record<string, string> = { [client]: newCoach, [otherClient]: otherCoach, [sub]: newCoach };
  const run = randomUUID().slice(0, 8);
  // tag: [coach, client, status, days from now]; each coach's times are apart.
  const sessions: Record<string, [string, string | null, string, number]> = {
    moved: [oldCoach, client, 'canceled', 3],
    oldPast: [oldCoach, client, 'completed', -3],
    oldBlock: [oldCoach, null, 'scheduled', 4],
    newAhead: [newCoach, client, 'scheduled', 5],
    subAhead: [sub, client, 'scheduled', 6],
    other: [otherCoach, otherClient, 'scheduled', 7],
  };
  const id = (tag: string) => `${tag}-${run}`;

  beforeAll(async () => {
    for (const user of [oldCoach, newCoach, sub, otherCoach, client, otherClient, owner]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${user}, ${user}, ${`msr-${user}`}, 'RLS user', ${role[user]}::"Role", ${coachOf[user] ?? null})`;
    }
    await prisma.$executeRaw`INSERT INTO "TeamSubCoachAssignment" ("id", "head_coach_id", "sub_coach_id")
      VALUES (${randomUUID()}, ${newCoach}, ${sub})`;
    await prisma.$executeRaw`INSERT INTO "SubCoachAssignment" ("id", "head_coach_id", "sub_coach_id", "client_id")
      VALUES (${randomUUID()}, ${newCoach}, ${sub}, ${client})`;
    for (const [tag, [coach, who, status, days]] of Object.entries(sessions)) {
      const start = new Date(Date.now() + days * 86_400_000);
      await prisma.$executeRaw`INSERT INTO "CoachingSession"
          ("id", "coach_id", "client_id", "status", "start_at", "end_at", "title", "coach_notes_md")
        VALUES (${id(tag)}, ${coach}, ${who}, ${status}::"SessionStatus", ${start},
          ${new Date(start.getTime() + 3_600_000)}, ${`msr-${run}`}, 'Private note')`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // Runs `query` as the signed-in API role with `reader`'s RLS context.
  const asUser = <T>(reader: string | null, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (reader) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[reader]);
      }
      return query(tx);
    });
  const seen = (reader: string | null) =>
    asUser(reader, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "CoachingSession" WHERE "title" = ${`msr-${run}`}`;
      return rows.map((r) => r.id.slice(0, -run.length - 1)).sort();
    });

  it('the old coach reads only their session with no client', async () => {
    expect(await seen(oldCoach)).toEqual(['oldBlock']);
  });

  it("the new coach reads only the sessions they run, never the old coach's", async () => {
    expect(await seen(newCoach)).toEqual(['newAhead']);
  });

  it('an unrelated coach and client read only their own session', async () => {
    expect(await seen(otherCoach)).toEqual(['other']);
    expect(await seen(otherClient)).toEqual(['other']);
  });

  it('the client keeps every session, cancelled and past included', async () => {
    expect(await seen(client)).toEqual(['moved', 'newAhead', 'oldPast', 'subAhead']);
  });

  it('an owner reads every session; no RLS context reads none', async () => {
    expect(await seen(owner)).toEqual(Object.keys(sessions).sort());
    expect(await seen(null)).toEqual([]);
  });

  it('the old coach can no longer change, delete or add a session with the client', async () => {
    expect(await asUser(oldCoach, (tx) => tx.$executeRaw`
      UPDATE "CoachingSession" SET "status" = 'scheduled' WHERE "id" = ${id('moved')}`)).toBe(0);
    expect(await asUser(oldCoach, (tx) => tx.$executeRaw`
      DELETE FROM "CoachingSession" WHERE "id" = ${id('oldPast')}`)).toBe(0);
    await expect(asUser(oldCoach, (tx) => tx.$executeRaw`
      INSERT INTO "CoachingSession" ("id", "coach_id", "client_id", "status", "start_at", "end_at", "title")
      VALUES (${id('added')}, ${oldCoach}, ${client}, 'scheduled', now() + interval '9 days',
        now() + interval '9 days 1 hour', ${`msr-${run}`})`)).rejects.toThrow(/row-level security/);
  });

  it("the client's raw read leaves out the coach's private notes", async () => {
    await expect(asUser(client, (tx) => tx.$queryRaw`
      SELECT "coach_notes_md" FROM "CoachingSession" WHERE "id" = ${id('moved')}`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('the sub-coach reads their session only while the team seat is live', async () => {
    expect(await seen(sub)).toEqual(['subAhead']);
    await prisma.$executeRaw`UPDATE "TeamSubCoachAssignment" SET "archived_at" = now()
      WHERE "head_coach_id" = ${newCoach} AND "sub_coach_id" = ${sub}`;
    expect(await seen(sub)).toEqual([]);
  });
});
