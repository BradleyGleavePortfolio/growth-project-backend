/**
 * FIX-1118-R1 (b#1118 Sol B2): "User".coach_joined_at is written by the
 * "User_coach_joined_at" trigger (20270502007500) on every attach to a coach,
 * so the brief's "Joined today" row sees a paid invite, a guest checkout and
 * a code join alike. The server writes below are the same statements those
 * paths send: a new account created with its coach (guest checkout), a
 * coachless account attached later (code, QR, paid fan-out, guest conversion),
 * and a move to another coach (one client, or the bulk move of a removed
 * sub-coach's clients to the head coach). FIX-1118-R2 (Sol B2): a move starts
 * a new join time, so the new coach's brief shows "Joined today".
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Row layer:
 * role authenticated (no bypass) with the backend's app GUCs. Every 0 or
 * 42501 follows a control of 1 on the same row.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('user-coach-joined-at: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502007500_user_coach_joined_at');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
// The function body is one statement: split only on a ';' that ends a line
// outside the $$ ... $$ block.
const statements = (file: string) => {
  const sql = readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '');
  const out: string[] = [];
  let buf = '';
  let inBody = false;
  for (const line of sql.split('\n')) {
    buf += `${line}\n`;
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBody = !inBody;
    if (!inBody && /;\s*$/.test(line)) {
      out.push(buf.trim().replace(/;$/, ''));
      buf = '';
    }
  }
  return out.filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
};

type Key = 'K' | 'L' | 'A' | 'B' | 'C' | 'D' | 'E';
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', A: 'student', B: 'student', C: 'student', D: 'student', E: 'student' };

(DB_URL ? describe : describe.skip)('"User".coach_joined_at: set by the database on every attach to a coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['K', 'L', 'A', 'B', 'C', 'D', 'E'];
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;

  const as = <T>(who: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who]);
      return query(tx);
    });
  const write = async (who: Key, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      return await as(who, (tx) => tx.$executeRawUnsafe(sql, ...params));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  const insert = (k: Key, coach: Key | null) => prisma.$executeRaw`
    INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
    VALUES (${id[k]}, ${sub[k]}, ${`joined-${id[k]}`}, 'Joined user', ${ROLE[k]}::"Role", ${coach ? id[coach] : null})`;
  const setCoach = (k: Key, coach: Key | null) =>
    prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${coach ? id[coach] : null} WHERE "id" = ${id[k]}`;
  const joinedAt = async (k: Key) =>
    (await prisma.user.findUnique({ where: { id: id[k] }, select: { coach_joined_at: true } }))?.coach_joined_at ?? null;
  const backdate = (k: Key) =>
    prisma.$executeRaw`ALTER TABLE "User" DISABLE TRIGGER "User_coach_joined_at"`
      .then(() => prisma.$executeRaw`UPDATE "User" SET "coach_joined_at" = '2026-01-01 00:00:00' WHERE "id" = ${id[k]}`)
      .then(() => prisma.$executeRaw`ALTER TABLE "User" ENABLE TRIGGER "User_coach_joined_at"`);
  const near = (d: Date | null) => expect(d && Math.abs(d.getTime() - Date.now())).toBeLessThan(60_000);
  const OLD = new Date('2026-01-01T00:00:00.000Z');

  beforeAll(async () => {
    await insert('K', null);
    await insert('L', null);
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('a new account created with its coach (guest checkout) gets the join time now, in UTC', async () => {
    await insert('A', 'K');
    near(await joinedAt('A'));
    expect(await joinedAt('K')).toBeNull(); // the coach row has no coach
  });

  it('a coachless account attached later (code, QR, paid fan-out, guest conversion) gets it then', async () => {
    await insert('B', null);
    expect(await joinedAt('B')).toBeNull();
    await setCoach('B', 'K');
    near(await joinedAt('B'));
  });

  it('a move to another coach starts a new join time (the join to the current coach)', async () => {
    await backdate('B');
    expect(await joinedAt('B')).toEqual(OLD); // control: the backdate landed
    await setCoach('B', 'L');
    near(await joinedAt('B'));
  });

  it('while the coach is unchanged the time is kept: a same-coach write (renewal), with or without a time', async () => {
    await backdate('B');
    expect(await joinedAt('B')).toEqual(OLD);
    await setCoach('B', 'L');
    expect(await joinedAt('B')).toEqual(OLD);
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.L}, "coach_joined_at" = now() WHERE "id" = ${id.B}`;
    expect(await joinedAt('B')).toEqual(OLD);
  });

  it('only the trigger writes it: a direct server write is undone', async () => {
    await prisma.$executeRaw`UPDATE "User" SET "coach_joined_at" = now() WHERE "id" = ${id.B}`;
    expect(await joinedAt('B')).toEqual(OLD);
  });

  it('a client cannot write it at the row layer (42501), though they can write their name (1)', async () => {
    expect(await write('B', `UPDATE "User" SET "name" = 'B renamed' WHERE "id" = $1`, id.B)).toBe(1);
    expect(await write('B', `UPDATE "User" SET "coach_joined_at" = now() WHERE "id" = $1`, id.B)).toBe('42501');
  });

  it("the client's current coach reads the join time (1); another coach reads nothing (0)", async () => {
    const read = (who: Key) => as(who, (tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM "User" WHERE "id" = ${id.A} AND "coach_joined_at" IS NOT NULL`).then((r) => r[0].n);
    expect(await read('K')).toBe(1);
    expect(await read('L')).toBe(0);
  });

  it('leaving the coach (coach_id to null) clears it; a later attach starts a new join', async () => {
    await setCoach('B', null);
    expect(await joinedAt('B')).toBeNull();
    await setCoach('B', 'K');
    near(await joinedAt('B'));
  });

  it("a bulk move (a removed sub-coach's clients to the head coach) stamps each moved client, only them", async () => {
    for (const k of ['C', 'D', 'E'] as Key[]) {
      await insert(k, 'L');
      await backdate(k);
      expect(await joinedAt(k)).toEqual(OLD); // control
    }
    // The statement tx.user.updateMany({ where: { id: { in } }, data: { coach_id } })
    // sends in team-mode.service.ts and sub-coach-invite.service.ts.
    expect(await prisma.$executeRaw`
      UPDATE "User" SET "coach_id" = ${id.K} WHERE "id" IN (${id.C}, ${id.D})`).toBe(2);
    near(await joinedAt('C'));
    near(await joinedAt('D'));
    expect(await joinedAt('E')).toEqual(OLD); // not moved
  });

  it('the new coach\'s "Joined today" read finds a moved client whose consultation finished long ago', async () => {
    await prisma.$executeRaw`
      INSERT INTO "ClientOnboardingIntake" ("id", "client_id", "version", "answers", "completed_at", "updated_at")
      VALUES (${randomUUID()}, ${id.C}, 'consult-v1', '{}'::jsonb, '2026-01-01 00:00:00', now())`;
    // The where of the brief's client_joined read (aggregateSoloContext).
    const joinedFor = (coach: Key) => {
      const dayAgo = new Date(Date.now() - 24 * 3_600_000);
      return prisma.user.findMany({
        where: {
          id: { in: [id.C, id.E] },
          coach_id: id[coach],
          onboarding_intake: { is: { completed_at: { not: null } } },
          OR: [
            { onboarding_intake: { is: { completed_at: { gte: dayAgo } } } },
            { coach_joined_at: { gte: dayAgo } },
          ],
        },
        select: { id: true },
      }).then((r) => r.map((u) => u.id));
    };
    expect(await joinedFor('K')).toEqual([id.C]); // the new coach
    expect(await joinedFor('L')).toEqual([]); // the former coach
  });

  it('down.sql removes the trigger, function and column; migration.sql puts them back', async () => {
    const present = () => prisma.$queryRaw<{ col: number; trg: number; fn: number }[]>`
      SELECT (SELECT count(*)::int FROM information_schema.columns
               WHERE "table_schema" = 'public' AND "table_name" = 'User' AND "column_name" = 'coach_joined_at') AS "col",
             (SELECT count(*)::int FROM pg_trigger WHERE "tgname" = 'User_coach_joined_at') AS "trg",
             (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p."pronamespace"
               WHERE n."nspname" = 'app' AND p."proname" = 'user_coach_joined_at') AS "fn"`.then((r) => r[0]);
    expect(await present()).toEqual({ col: 1, trg: 1, fn: 1 });
    await apply('down.sql');
    expect(await present()).toEqual({ col: 0, trg: 0, fn: 0 });
    await apply('migration.sql');
    expect(await present()).toEqual({ col: 1, trg: 1, fn: 1 });
    await setCoach('A', null);
    await setCoach('A', 'K');
    near(await joinedAt('A'));
  });
});
