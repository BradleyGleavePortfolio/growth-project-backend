/**
 * Row security for stored coach briefs (BRIEFTEAM2, Sol B4 on #987) on the
 * replayed migration chain, as the non-bypass `authenticated` role. Head
 * coach A has clients X and Y and a seated sub-coach S; coach C is another
 * head coach. A's stored head brief names X (message row, name, preview) and
 * carries check-in counts. No signed-in user reads it directly, before or
 * after X turns off Coach sharing or moves to C: the server API is the only
 * read path, and it re-checks sharing, moves and delegation (#987, BRIEFTEAM2).
 * The service role, which the API uses, still reads the row.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-brief-direct-read-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: a stored coach brief is read only through the server', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'ACSXY'].map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { S: 'A', X: 'A', Y: 'A' };
  const isCoach = (k: string) => 'ACS'.includes(k);
  const briefId = randomUUID();
  const READERS = ['A', 'C', 'S', 'X', 'Y'];

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${u[k]}, ${`bt2-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    await prisma.$executeRaw`INSERT INTO "TeamSubCoachAssignment" ("id", "head_coach_id", "sub_coach_id")
      VALUES (${randomUUID()}, ${u.A}, ${u.S})`;
    await prisma.$executeRaw`INSERT INTO "ClientCoachConsent" ("id", "client_id", "coach_id", "scope", "granted_at")
      VALUES (${randomUUID()}, ${u.X}, ${u.A}, 'fitness.habits_progress', now())`;
    const context = { brief_mode: 'head_coach', activity: { check_ins_completed: 1, clients_messaged: 1 } };
    const items = [{ type: 'message_unread', client_id: u.X, client_name: 'Sarah Lee', detail: 'Can we move my session?', priority: 1 }];
    await prisma.$executeRaw`INSERT INTO "CoachBrief"
        ("id", "coach_id", "brief_date", "status", "generated_at", "narrative", "brief_context", "action_items", "generated_by", "brief_mode", "updated_at")
      VALUES (${briefId}, ${u.A}, '2026-05-25', 'generated', now(), 'Good morning.', ${JSON.stringify(context)}::jsonb,
        ${JSON.stringify(items)}::jsonb, 'fallback', 'head_coach', now())`;
  });
  afterAll(() => prisma.$disconnect());

  // Runs `query` as the signed-in API role, with both identity forms the
  // policies read (app.current_user_id and the Supabase JWT subject).
  const asUser = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: u[who] }));
      return query(tx);
    });
  const select = (tx: Prisma.TransactionClient) =>
    tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CoachBrief" WHERE "id" = ${briefId}`.then((r) => r.length);
  const seenBy = async () => {
    const out: Record<string, number> = {};
    for (const k of READERS) out[k] = await asUser(k, select);
    return out;
  };
  const serviceRole = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      return select(tx);
    });
  const NONE = Object.fromEntries(READERS.map((k) => [k, 0]));

  it('runs as a role that does not bypass row security', async () => {
    expect(await asUser('A', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('only the service role policy is left on CoachBrief', async () => {
    expect(await prisma.$queryRaw`SELECT "policyname", "roles"::text AS "roles", "cmd" FROM pg_policies
      WHERE "tablename" = 'CoachBrief' ORDER BY "policyname"`).toEqual([
      { policyname: 'coach_brief_service_role_bypass', roles: '{service_role}', cmd: 'ALL' },
    ]);
  });

  it('the service role reads the brief; its coach, another head coach, the sub-coach and the clients read none', async () => {
    expect(await serviceRole()).toBe(1);
    expect(await seenBy()).toEqual(NONE);
  });

  it('after X turns off Coach sharing, still no direct read', async () => {
    await prisma.$executeRaw`UPDATE "ClientCoachConsent" SET "revoked_at" = now() WHERE "client_id" = ${u.X}`;
    expect(await seenBy()).toEqual(NONE);
    expect(await serviceRole()).toBe(1);
  });

  it('after X moves to coach C, still no direct read, including the new coach', async () => {
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.C} WHERE "id" = ${u.X}`;
    expect(await seenBy()).toEqual(NONE);
    expect(await serviceRole()).toBe(1);
  });
});
