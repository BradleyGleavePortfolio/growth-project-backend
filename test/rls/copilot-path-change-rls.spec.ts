/**
 * COPILOT-BE: at the row layer a Copilot plan change (AiActionDraft, capability client_path_change) is the client's own
 * until they tap Send, then their current coach's to decide, and no other coach's or client's at any point.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay, as role authenticated (no row-security bypass):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A and B are coach K's clients, C is coach L's. The server writes (Roman's suggestion, Send) are the superuser's here,
 * service_role in the app. Every 0 or 42501 follows a control of 1 on the same row. No policy changes in this PR.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('copilot-path-change-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'C' | 'K' | 'L';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { A: 'student', B: 'student', C: 'student', K: 'coach', L: 'coach' };

(DB_URL ? describe : describe.skip)('a Copilot plan change stays with the client, then their current coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['K', 'L', 'A', 'B', 'C']; // coaches first: clients reference them
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const S = randomUUID(); // A's suggestion

  const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who.key], role: 'authenticated' }));
      if (who.guc) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who.key]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who.key]);
      }
      return query(tx);
    });
  const write = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      return await as(who, (tx) => tx.$executeRawUnsafe(sql, ...params));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const reads = (who: Who) =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "AiActionDraft" WHERE "id" = $1`, S)).then((r) => r[0].n);
  const note = (who: Who) => write(who, `UPDATE "AiActionDraft" SET "decision_note" = 'rls' WHERE "id" = $1`, S);
  const sendAs = (who: Who) => write(who, `UPDATE "AiActionDraft" SET "status" = 'pending', "tenant_coach_id" = $1 WHERE "id" = $2`, id.K, S);

  beforeAll(async () => {
    for (const k of keys) {
      const coach = k === 'A' || k === 'B' ? id.K : k === 'C' ? id.L : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`cprls-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    // Roman's turn (the server) writes the suggestion: the client's own, no tenant yet.
    await prisma.$executeRaw`INSERT INTO "AiActionDraft" ("id", "capability", "status", "requester_id", "subject_user_id", "tenant_coach_id", "payload")
      VALUES (${S}, 'client_path_change', 'suggested', ${id.A}, ${id.A}, NULL, '{"kind":"move_session"}'::jsonb)`;
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('A'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('before Send: only the client reads it; no coach, other client or Data API caller does', async () => {
    expect(await reads(backend('A'))).toBe(1);
    expect(await reads(backend('K'))).toBe(0);
    expect(await reads(backend('L'))).toBe(0);
    expect(await reads(backend('B'))).toBe(0);
    expect(await reads(dataApi('A'))).toBe(0);
  });

  it('before Send: nobody but the server can send, decide or add one', async () => {
    expect(await sendAs(backend('A'))).toBe(0);
    expect(await note(backend('K'))).toBe(0);
    expect(await write(backend('A'), `INSERT INTO "AiActionDraft" ("id", "capability", "status", "requester_id", "subject_user_id", "payload")
      VALUES ($1, 'client_path_change', 'pending', $2, $2, '{}'::jsonb)`, randomUUID(), id.A)).toBe('42501');
  });

  it('after Send: the client and their coach read it; the coach decides it; no one else reads or decides it', async () => {
    await prisma.$executeRaw`UPDATE "AiActionDraft" SET "status" = 'pending', "tenant_coach_id" = ${id.K} WHERE "id" = ${S}`;
    expect(await reads(backend('K'))).toBe(1);
    expect(await reads(backend('A'))).toBe(1);
    expect(await reads(backend('L'))).toBe(0);
    expect(await reads(backend('B'))).toBe(0);
    expect(await reads(backend('C'))).toBe(0);
    expect(await reads(dataApi('K'))).toBe(0);
    expect(await note(backend('K'))).toBe(1);
    expect(await note(backend('L'))).toBe(0);
    expect(await note(backend('A'))).toBe(0);
  });

  it('after the client moves to coach L, coach K neither reads nor decides it; the client still reads it', async () => {
    expect(await reads(backend('K'))).toBe(1);
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.L} WHERE "id" = ${id.A}`;
    expect(await reads(backend('K'))).toBe(0);
    expect(await note(backend('K'))).toBe(0);
    expect(await reads(backend('L'))).toBe(0);
    expect(await reads(backend('A'))).toBe(1);
  });
});
