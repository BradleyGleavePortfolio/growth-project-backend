/**
 * GUIDEWRITE (20270429000000): only a coach writes a coach guideline. Live, on
 * the replayed migration chain, as the non-bypass `authenticated` role.
 *
 * Coach A coaches X and Y; coach C coaches Z; coach F coaches W until W moves
 * to A. Each guideline row is written by its coach. First this suite applies
 * the migration's down.sql (the 20270419000000 text, the rule production and
 * main have today) and shows the hole: client X plants a guideline naming
 * coach C as author, and edits and deletes coach A's guideline. Then it
 * applies migration.sql verbatim and shows all three refused, while the
 * current coach, the owner admin and the server's own connection keep
 * working, the former coach stays refused, and no other client reads X's rows.
 * Every 0 below follows a read or write of the same row that returned 1.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('guideline-rows-coach-written-only-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const DIR = join(__dirname, '../../prisma/migrations/20270429000000_guideline_rows_coach_written_only');
// The two files hold only ALTER POLICY / COMMENT statements, each ending at a
// line end (a ';' inside a comment string is followed by more text).
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n').filter((l) => !l.startsWith('--')).join('\n')
    .split(/;\s*\n/).map((s) => s.trim())
    .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

(DB_URL ? describe : describe.skip)('Row rules: only a coach writes a coach guideline', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'ACFXYZWO'].map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { X: 'A', Y: 'A', Z: 'C', W: 'F' };
  const role = (k: string) => (k === 'O' ? 'owner' : 'ACF'.includes(k) ? 'coach' : 'student');
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const seeded: Record<string, [string, string]> = { gAX: ['A', 'X'], gAY: ['A', 'Y'], gCZ: ['C', 'Z'], gFW: ['F', 'W'] };

  const apply = (file: string) =>
    prisma.$transaction(async (tx) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  const seed = (g: string) =>
    prisma.$executeRaw`INSERT INTO "CoachGuideline" ("id", "coach_id", "client_id", "content", "updated_at")
      VALUES (${id(g)}, ${u[seeded[g][0]]}, ${u[seeded[g][1]]}, 'Guideline', now()) ON CONFLICT ("id") DO NOTHING`;

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${u[k]}, ${`gw-${u[k]}`}, 'RLS user', ${role(k)}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    for (const g of Object.keys(seeded)) await seed(g);
  });
  afterAll(() => prisma.$disconnect());

  // Runs `query` as the API role with both identity forms the policies read.
  const asUser = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>, dbRole = 'authenticated') =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${dbRole}`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role(who));
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: u[who] }));
      return query(tx);
    });
  const seen = (who: string, dbRole?: string) =>
    asUser(who, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "CoachGuideline" WHERE "id" LIKE $1`, `%-${run}`), dbRole)
      .then((rows) => rows.map((r) => r.id.slice(0, -run.length - 1)).sort());
  const update = (who: string, g: string) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(`UPDATE "CoachGuideline" SET "content" = 'Edited' WHERE "id" = $1`, id(g)));
  const remove = (who: string, g: string) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(`DELETE FROM "CoachGuideline" WHERE "id" = $1`, id(g)));
  const add = (who: string, g: string, coach: string | null, client: string | null, dbRole?: string) =>
    asUser(who, (tx) => tx.$executeRaw`INSERT INTO "CoachGuideline" ("id", "coach_id", "client_id", "content", "updated_at")
      VALUES (${id(g)}, ${coach ? u[coach] : null}, ${client ? u[client] : null}, 'Guideline', now())`, dbRole);
  const exists = (g: string) =>
    prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "CoachGuideline" WHERE "id" = ${id(g)}`.then((r) => r[0].n);

  it('runs as a role that does not bypass row security', async () => {
    expect(await asUser('X', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  describe('under down.sql (the 20270419000000 rule in force today)', () => {
    beforeAll(() => apply('down.sql'));

    it('the hole: a client plants a guideline naming any coach, and edits and deletes their coach\'s guideline', async () => {
      expect(await seen('X')).toEqual(['gAX']);
      expect(await add('X', 'gPlanted', 'C', 'X')).toBe(1);
      expect(await update('X', 'gAX')).toBe(1);
      expect(await remove('X', 'gAX')).toBe(1);
      expect(await exists('gAX')).toBe(0);
      // Restore the seeded rows for the next phase.
      await prisma.$executeRaw`DELETE FROM "CoachGuideline" WHERE "id" = ${id('gPlanted')}`;
      await seed('gAX');
    });

    it('the former coach still writes before the move (control for the refusals below)', async () => {
      expect(await update('F', 'gFW')).toBe(1);
    });
  });

  describe('after migration.sql (W has moved from coach F to coach A)', () => {
    beforeAll(async () => {
      await apply('migration.sql');
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.A} WHERE "id" = ${u.W}`;
    });

    it('the client still reads every guideline written about them', async () => {
      expect(await seen('X')).toEqual(['gAX']);
      expect(await seen('W')).toEqual(['gFW']);
    });

    it('the client can no longer plant, edit or delete a guideline', async () => {
      expect(await seen('X')).toEqual(['gAX']);
      await expect(add('X', 'gPlanted', 'C', 'X')).rejects.toThrow(/row-level security/);
      await expect(add('X', 'gPlantedA', 'A', null)).rejects.toThrow(/row-level security/);
      expect(await update('X', 'gAX')).toBe(0);
      expect(await remove('X', 'gAX')).toBe(0);
      expect(await seen('W')).toEqual(['gFW']);
      expect(await update('W', 'gFW')).toBe(0);
      expect(await exists('gAX')).toBe(1);
      expect(await exists('gPlanted')).toBe(0);
    });

    it('the current coach still inserts, updates and deletes for their client', async () => {
      expect(await add('A', 'gAW', 'A', 'W')).toBe(1);
      expect(await add('A', 'gAnone', 'A', null)).toBe(1);
      expect(await update('A', 'gAX')).toBe(1);
      expect(await update('A', 'gAW')).toBe(1);
      expect(await remove('A', 'gAW')).toBe(1);
      expect(await remove('A', 'gAnone')).toBe(1);
      await expect(add('A', 'gForged', 'C', 'X')).rejects.toThrow(/row-level security/);
    });

    it('the former coach is still refused', async () => {
      expect(await exists('gFW')).toBe(1);
      expect(await seen('F')).toEqual([]);
      expect(await update('F', 'gFW')).toBe(0);
      expect(await remove('F', 'gFW')).toBe(0);
      await expect(add('F', 'gFW2', 'F', 'W')).rejects.toThrow(/row-level security/);
    });

    it('the owner admin still works', async () => {
      expect(await update('O', 'gCZ')).toBe(1);
      expect(await add('O', 'gOwner', 'C', null)).toBe(1);
      expect(await remove('O', 'gOwner')).toBe(1);
    });

    it('another client or coach cannot read or write client X\'s rows', async () => {
      expect(await seen('X')).toEqual(['gAX']);
      expect(await seen('Z')).toEqual(['gCZ']);
      expect(await seen('Y')).toEqual(['gAY']);
      expect(await update('Z', 'gAX')).toBe(0);
      expect(await update('A', 'gAX')).toBe(1);
      expect(await seen('C')).toEqual(['gCZ']);
      expect(await update('C', 'gAX')).toBe(0);
      expect(await remove('C', 'gAX')).toBe(0);
    });

    it('the server path is unchanged: the service role reads and writes inside a client request', async () => {
      // RlsContextInterceptor sets app.current_user_id to the client on a client
      // request; Roman's read and the coach route's write run on service_role.
      expect(await seen('X', 'service_role')).toEqual(['gAX', 'gAY', 'gCZ', 'gFW']);
      expect(await add('X', 'gServer', 'A', null, 'service_role')).toBe(1);
      await prisma.$executeRaw`DELETE FROM "CoachGuideline" WHERE "id" = ${id('gServer')}`;
    });

    it('policy text: no write rule has a client branch; the read rule keeps it', async () => {
      const rows = await prisma.$queryRaw<{ policy: string; qual: string | null; check: string | null; comment: string | null }[]>`
        SELECT p."polname" AS "policy", pg_get_expr(p."polqual", p."polrelid") AS "qual",
               pg_get_expr(p."polwithcheck", p."polrelid") AS "check", obj_description(p."oid", 'pg_policy') AS "comment"
        FROM pg_policy p JOIN pg_class c ON c."oid" = p."polrelid"
        WHERE c."relname" = 'CoachGuideline' AND p."polname" NOT LIKE '%service_role%'`;
      const clientBranch = /client_id"? = app\.current_user_id\(\)/;
      const byName = Object.fromEntries(rows.map((r) => [r.policy, r]));
      expect(Object.keys(byName).sort()).toEqual([
        'p_coachguideline_delete', 'p_coachguideline_insert', 'p_coachguideline_select', 'p_coachguideline_update',
      ]);
      for (const p of ['p_coachguideline_insert', 'p_coachguideline_update', 'p_coachguideline_delete']) {
        expect(`${byName[p].qual ?? ''} ${byName[p].check ?? ''}`).not.toMatch(clientBranch);
        expect(byName[p].comment).toMatch(/^20270429000000: /);
      }
      expect(byName.p_coachguideline_select.qual).toMatch(clientBranch);
      expect(byName.p_coachguideline_select.comment).toMatch(/^20270419000000: /);
    });
  });
});
