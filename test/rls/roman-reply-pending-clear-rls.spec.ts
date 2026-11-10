/**
 * SEND-ONCE-CLEAR-BE, on real Postgres (the rls-live-tests job: run-rls-suites.mjs gives this suite its own copy of
 * the whole migration chain, as the superuser):
 *  1. The clear of a keyed Roman turn's mark (RomanService.clearReplyPending's exact updateMany) under a role that
 *     row security stops matches 0 rows and raises no error: the silent case its new log line is for. The one query
 *     the owner is asked answers it: true exactly where the clear changes the row. A NOINHERIT member of service_role
 *     shows why the query tests USAGE, not MEMBER.
 *  2. A query after PrismaService's $disconnect reconnects, and RomanService's shutdown hook clears a real mark then.
 * No policy, migration or role in the product changes. Gate: TEST_DATABASE_URL (no URL -> skip, except under CI=true).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { RomanService, romanTurnIds } from '../../src/roman/roman.service';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('roman-reply-pending-clear-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

/** The owner's question, word for word as the PR body asks it. */
const CLEARS_QUERY = `SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(current_user, 'service_role', 'USAGE') AS "clears"
  FROM pg_roles r WHERE r.rolname = current_user`;
const PROBE = 'roman_clear_noinherit_probe';
const MARK = -1;

(DB_URL ? describe : describe.skip)('the reply-pending clear under row security', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const A = randomUUID();
  const S = randomUUID();
  const T = randomUUID();
  const clearOf = (tx: Prisma.TransactionClient) =>
    tx.romanMessage.updateMany({ where: { id: T, session_id: S, user_id: A, role: 'user' }, data: { completion_tokens: null } });
  const as = <R>(role: string | null, run: (tx: Prisma.TransactionClient) => Promise<R>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (role) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: A, role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, A);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'student', true)`);
      return run(tx);
    });
  const markOf = async () => (await prisma.romanMessage.findUniqueOrThrow({ where: { id: T } })).completion_tokens;

  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
      VALUES (${A}, ${randomUUID()}, ${`rpcrls-${A}`}, 'RLS user', 'student'::"Role")`;
    await prisma.$executeRaw`INSERT INTO "RomanSession" ("id", "user_id", "surface", "day_key", "updated_at")
      VALUES (${S}, ${A}, 'client'::"RomanSurface", '2026-11-09', now())`;
    await prisma.$executeRaw`INSERT INTO "RomanMessage" ("id", "session_id", "user_id", "role", "content", "completion_tokens")
      VALUES (${T}, ${S}, ${A}, 'user'::"RomanMessageRole", 'A question', ${MARK})`;
    await prisma.$executeRawUnsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE}') THEN CREATE ROLE ${PROBE} NOLOGIN NOINHERIT; END IF; END $$`,
    );
    await prisma.$executeRawUnsafe(`GRANT service_role TO ${PROBE}`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public, app TO ${PROBE}`);
    await prisma.$executeRawUnsafe(`GRANT SELECT, UPDATE ON "RomanMessage", "RomanSession" TO ${PROBE}`);
  });
  afterAll(() => prisma.$disconnect());

  it.each<[string, string | null, boolean, number]>([
    ['the superuser (rolsuper)', null, true, 1],
    ['service_role (BYPASSRLS, and its FOR ALL policy)', 'service_role', true, 1],
    ['authenticated (no bypass, no UPDATE policy)', 'authenticated', false, 0],
    ['a NOINHERIT member of service_role (MEMBER, not USAGE)', PROBE, false, 0],
  ])('%s: the query answers %s and the clear changes %s row(s), never an error', async (_name, role, clears, count) => {
    await prisma.romanMessage.update({ where: { id: T }, data: { completion_tokens: MARK } });
    expect(await as(role, (tx) => tx.$queryRawUnsafe<{ clears: boolean }[]>(CLEARS_QUERY))).toEqual([{ clears }]);
    await expect(as(role, clearOf)).resolves.toEqual({ count });
    expect(await markOf()).toBe(count === 1 ? null : MARK);
  });

  it('MEMBER would answer the wrong way for the NOINHERIT member: it says member while no policy of service_role applies', async () => {
    const [row] = await as(PROBE, (tx) => tx.$queryRaw<{ member: boolean; usage: boolean }[]>`
      SELECT pg_has_role(current_user, 'service_role', 'MEMBER') AS "member", pg_has_role(current_user, 'service_role', 'USAGE') AS "usage"`);
    expect(row).toEqual({ member: true, usage: false });
  });

  it('a query after PrismaService\'s $disconnect reconnects, and the shutdown hook clears a real mark then', async () => {
    const svc = new PrismaService({ datasources: { db: { url: DB_URL } } });
    const roman = new RomanService(svc, grantAllEgress());
    const caller = { id: A, role: 'student', tier: 'free' } as const;
    const turn = romanTurnIds(A, S, randomUUID()).turn;
    try {
      await roman.appendKeyedTurn(caller, S, turn, 'Still there?');
      expect((await prisma.romanMessage.findUniqueOrThrow({ where: { id: turn } })).completion_tokens).toBe(MARK);
      await svc.onModuleDestroy();
      expect(await svc.romanMessage.count({ where: { id: turn } })).toBe(1);
      await svc.onModuleDestroy();
      await roman.onModuleDestroy();
      expect((await prisma.romanMessage.findUniqueOrThrow({ where: { id: turn } })).completion_tokens).toBeNull();
    } finally {
      await svc.$disconnect();
    }
  });
});
