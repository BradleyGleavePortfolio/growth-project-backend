/**
 * COPILOT-BE2: a Path Copilot reply's facts (RomanMessage.copilot, new column) are the client's alone; the coach sees a
 * suggestion only after Send, through AiActionDraft. Runs in rls-live-tests as role authenticated (no bypass), backend
 * model (app GUCs + JWT sub). A and B are coach K's clients; the superuser writes the reply. Every 0 follows a control of 1.
 * No policy changes. Gate: TEST_DATABASE_URL (no URL -> skip, except under CI=true).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('copilot-reply-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'K';
const ROLE: Record<Key, string> = { A: 'student', B: 'student', K: 'coach' };

(DB_URL ? describe : describe.skip)('a Copilot reply and its facts stay with the client', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['K', 'A', 'B'];
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const S = randomUUID();
  const M = randomUUID();

  const as = <T>(key: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[key], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[key]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[key]);
      return query(tx);
    });
  const reads = (key: Key) =>
    as(key, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "RomanMessage" WHERE "id" = $1 AND "copilot" IS NOT NULL`, M),
    ).then((r) => r[0].n);
  const blanks = async (key: Key): Promise<number | string> => {
    try {
      return await as(key, (tx) => tx.$executeRawUnsafe(`UPDATE "RomanMessage" SET "copilot" = NULL WHERE "id" = $1`, M));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };

  beforeAll(async () => {
    for (const k of keys) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`cprrls-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${k === 'K' ? null : id.K})`;
    }
    await prisma.$executeRaw`INSERT INTO "RomanSession" ("id", "user_id", "surface", "day_key", "updated_at")
      VALUES (${S}, ${id.A}, 'client'::"RomanSurface", '2026-10-21', now())`;
    await prisma.$executeRaw`INSERT INTO "RomanMessage" ("id", "session_id", "user_id", "role", "content", "copilot")
      VALUES (${M}, ${S}, ${id.A}, 'roman'::"RomanMessageRole", 'Friday works. [1]',
        '{"question_id":null,"sources":[{"n":1,"kind":"check_in","label":"71.4 kg on Sun 18 Oct"}],"suggestion_id":null}'::jsonb)`;
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('A', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('the client reads their reply and its facts; their coach and another client of that coach read nothing', async () => {
    expect(await reads('A')).toBe(1);
    expect(await reads('K')).toBe(0);
    expect(await reads('B')).toBe(0);
  });

  it('nobody but the server writes the facts: the client, their coach and another client change no row', async () => {
    for (const k of ['B', 'K', 'A'] as const) expect(await blanks(k)).not.toBe(1);
    expect(await reads('A')).toBe(1);
  });
});
