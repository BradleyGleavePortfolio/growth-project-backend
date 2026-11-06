/**
 * ROMAN-HOLD-BE (20270502011200): the row rules of RomanMessageReport (a client's report on one of
 * Roman's replies), on the replayed migration chain as the non-bypass `authenticated` role. Coach K
 * coaches client A; client B has no coach; O is TGP's team (platform owner). A reports Roman's reply in
 * A's own chat. Only O reads the report: A (the reporter), A's coach K, client B and another coach L read
 * none, and no API role writes, changes or deletes one (the server writes it as service_role). Every 0
 * below follows a 1 for a caller who can read a row of the same table (O, the control read). The report
 * goes with the message (chat erased) and with the account (user deleted).
 *
 * Runs in the rls-live-tests job. Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('roman-message-report-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)("Row rules: a report on Roman's reply is read only by TGP's team", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const role: Record<string, 'coach' | 'student' | 'owner'> = { K: 'coach', L: 'coach', A: 'student', B: 'student', O: 'owner' };
  const u: Record<string, string> = Object.fromEntries(Object.keys(role).map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(role).map((k) => [k, randomUUID()]));
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const REPORT = `SELECT count(*)::int AS "n" FROM "RomanMessageReport" WHERE "id" = $1`;

  const seedChat = async (who: string, key: string) => {
    await prisma.$executeRaw`INSERT INTO "RomanSession" ("id", "user_id", "surface", "day_key", "updated_at")
      VALUES (${id(`sess.${key}`)}, ${u[who]}, 'client'::"RomanSurface", ${`2026-11-0${key.length}`}, CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "RomanMessage" ("id", "session_id", "user_id", "role", "content")
      VALUES (${id(`msg.${key}`)}, ${id(`sess.${key}`)}, ${u[who]}, 'roman'::"RomanMessageRole", 'A Roman reply')`;
  };
  const seedReport = (who: string, key: string) =>
    prisma.$executeRaw`INSERT INTO "RomanMessageReport" ("id", "reporter_id", "roman_message_id", "reason", "details")
      VALUES (${id(`rep.${key}`)}, ${u[who]}, ${id(`msg.${key}`)}, 'harassment', 'Reported in the live test')`;

  beforeAll(async () => {
    const coachOf: Record<string, string | null> = { A: u.K };
    for (const k of Object.keys(role)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`rmr-${u[k]}`}, 'RLS user', ${role[k]}::"Role", ${coachOf[k] ?? null})`;
    }
    await seedChat('A', 'a');
    await seedReport('A', 'a');
  });
  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ANY(${Object.values(u)}::text[])`;
    await prisma.$disconnect();
  });

  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      return query(tx);
    });
  const reads = async (who: string, r: string) => {
    const [{ n }] = await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(REPORT, id(r)));
    return n;
  };
  const sqlstate = (e: unknown) => /Code: `([0-9A-Z]{5})`/.exec(String(e))?.[1] ?? 'refused';
  const write = (who: string, sql: string, ...args: string[]) =>
    as(who, (tx) => tx.$executeRawUnsafe(sql, ...args)).then((n) => n, sqlstate);
  const exists = async (r: string) => {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(REPORT, id(r));
    return n;
  };

  it('runs as a role that does not bypass row security, on a table that forces it, with no anon access', async () => {
    expect(await as('A', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    expect(await prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT "relrowsecurity" AS "enabled", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "relnamespace" = 'public'::regnamespace AND "relname" = 'RomanMessageReport'`).toEqual([{ enabled: true, forced: true }]);
    const anon = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM information_schema.role_table_grants
      WHERE "grantee" = 'anon' AND "table_schema" = 'public' AND "table_name" = 'RomanMessageReport'`;
    expect(anon).toEqual([{ n: 0 }]);
  });

  it("TGP's team reads the report; the reporter, their coach, another client and another coach read none", async () => {
    expect(await reads('O', 'rep.a')).toBe(1);
    expect(await reads('A', 'rep.a')).toBe(0);
    expect(await reads('K', 'rep.a')).toBe(0);
    expect(await reads('B', 'rep.a')).toBe(0);
    expect(await reads('L', 'rep.a')).toBe(0);
  });

  it('no API role writes, changes or deletes a report (the server writes it as service_role)', async () => {
    const INSERT = `INSERT INTO "RomanMessageReport" ("id", "reporter_id", "roman_message_id", "reason") VALUES ($1, $2, $3, 'spam')`;
    for (const who of 'AKBLO') {
      expect(await write(who, INSERT, randomUUID(), u.A, id('msg.a'))).not.toBe(1);
      expect(await write(who, `UPDATE "RomanMessageReport" SET "reason" = 'other' WHERE "id" = $1`, id('rep.a'))).not.toBe(1);
      expect(await write(who, `DELETE FROM "RomanMessageReport" WHERE "id" = $1`, id('rep.a'))).not.toBe(1);
    }
    expect(await reads('O', 'rep.a')).toBe(1);
    const server = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      return tx.$executeRawUnsafe(
        `INSERT INTO "RomanMessageReport" ("id", "reporter_id", "roman_message_id", "reason") VALUES ($1, $2, $3, 'spam')
         ON CONFLICT ("reporter_id", "roman_message_id") DO NOTHING`,
        id('rep.server'),
        u.A,
        id('msg.a'),
      );
    });
    // One report per reporter and message: the server's second insert for the same message is a no-op.
    expect(server).toBe(0);
  });

  it('refuses a reason off the DM report list and details over 1000 characters (database checks)', async () => {
    await seedChat('A', 'chk');
    const bad = (reason: string, details: string | null) =>
      prisma
        .$executeRawUnsafe(
          `INSERT INTO "RomanMessageReport" ("id", "reporter_id", "roman_message_id", "reason", "details") VALUES ($1, $2, $3, $4, $5)`,
          randomUUID(),
          u.A,
          id('msg.chk'),
          reason,
          details,
        )
        .then((n) => n, sqlstate);
    expect(await bad('boring', null)).toBe('23514');
    expect(await bad('spam', 'x'.repeat(1001))).toBe('23514');
    expect(await bad('spam', 'x'.repeat(1000))).toBe(1);
  });

  it('goes with the message when the client erases the chat', async () => {
    await seedChat('A', 'erase');
    await seedReport('A', 'erase');
    expect(await exists('rep.erase')).toBe(1);
    await prisma.$executeRaw`DELETE FROM "RomanMessage" WHERE "session_id" = ${id('sess.erase')}`;
    expect(await exists('rep.erase')).toBe(0);
  });

  it('goes with the account when the reporter is deleted', async () => {
    const gone = randomUUID();
    u.G = gone;
    role.G = 'student';
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
      VALUES (${gone}, ${randomUUID()}, ${`rmr-${gone}`}, 'RLS user', 'student'::"Role")`;
    await seedChat('G', 'gone');
    await seedReport('G', 'gone');
    expect(await exists('rep.gone')).toBe(1);
    await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${gone}`;
    expect(await exists('rep.gone')).toBe(0);
  });
});
