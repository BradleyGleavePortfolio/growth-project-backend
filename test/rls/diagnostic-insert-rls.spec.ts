/**
 * RLSDIAG (RLSINV H08): a DiagnosticSubmission row written through row
 * security needs a signed-in owner. Before 20270501000000 the insert policy
 * admitted any user_id-NULL row with no identity, so a signed-in user's JWT on
 * the Supabase Data API (no app.current_user_id GUC) could insert anonymous
 * rows. Anonymous rows are the server's job: Prisma connects as service_role.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals:
 *   dataApi(k)  role authenticated, JWT sub = k's supabase id, no app GUC
 *   backend(k)  role authenticated, app.current_user_id/_role and JWT sub set
 *   owner       backend model with app.current_user_role = 'owner'
 *   service     role service_role (BYPASSRLS)
 *   anon        role anon
 * The suite first runs down.sql (the hole, the exact production text), then
 * migration.sql. Every refusal follows a control write of 1 to the same kind
 * of row. Ids differ from supabase ids (RLSINV Y04).
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('diagnostic-insert-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270501000000_diagnostic_insert_needs_a_user');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

const OLD_CHECK =
  '(app.is_owner() OR (user_id IS NULL) OR ((app.current_user_id() IS NOT NULL) AND (user_id = app.current_user_id())))';
const NEW_CHECK = '(app.is_owner() OR ((app.current_user_id() IS NOT NULL) AND (user_id = app.current_user_id())))';

type Who =
  | { kind: 'dataApi' | 'backend'; k: 'A' | 'B' }
  | { kind: 'owner' | 'service' | 'anon' };
const dataApi = (k: 'A' | 'B'): Who => ({ kind: 'dataApi', k });
const backend = (k: 'A' | 'B'): Who => ({ kind: 'backend', k });
const owner: Who = { kind: 'owner' };
const service: Who = { kind: 'service' };
const anon: Who = { kind: 'anon' };

(DB_URL ? describe : describe.skip)('DiagnosticSubmission: a row written through row security needs a signed-in owner', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const id = { A: randomUUID(), B: randomUUID(), O: randomUUID() };
  const sub = { A: randomUUID(), B: randomUUID(), O: randomUUID() };
  const run = randomUUID().slice(0, 8);
  let n = 0;
  afterAll(() => prisma.$disconnect());

  const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const role = who.kind === 'service' ? 'service_role' : who.kind === 'anon' ? 'anon' : 'authenticated';
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      if (who.kind === 'dataApi' || who.kind === 'backend' || who.kind === 'owner') {
        const k = who.kind === 'owner' ? 'O' : who.k;
        await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role }));
        if (who.kind !== 'dataApi') {
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, who.kind === 'owner' ? 'owner' : 'student');
        }
      }
      return query(tx);
    });
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  const policy = () => prisma.$queryRaw<{ with_check: string; comment: string }[]>`
    SELECT p."with_check", obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = '"DiagnosticSubmission"'::regclass
    WHERE p."tablename" = 'DiagnosticSubmission' AND p."policyname" = 'p_diagnosticsubmission_insert'`;
  // 1 = the row was written (checked by the superuser); otherwise SQLSTATE + cause.
  const insert = async (who: Who, userId: string | null): Promise<number | string> => {
    const rowId = `diag-${run}-${(n += 1)}`;
    try {
      await as(who, (tx) => tx.$executeRaw`INSERT INTO "DiagnosticSubmission" ("id", "email", "answers", "scores", "bucket", "user_id")
        VALUES (${rowId}, ${`rls-${run}`}, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, ${userId})`);
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string; message?: string }; message?: string };
      const text = `${err.message ?? ''} ${err.meta?.message ?? ''}`;
      const cause = /row-level security/.test(text) ? 'rls' : /permission denied for function/.test(text) ? 'helper' : text;
      return `${err.code === 'P2010' ? err.meta?.code : err.code} ${cause}`;
    }
    const [{ count }] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS "count" FROM "DiagnosticSubmission" WHERE "id" = ${rowId}`;
    return count;
  };
  const DENIED = '42501 rls';

  it('runs the API roles without row-security bypass; only service_role bypasses', async () => {
    const bypass = (who: Who) =>
      as(who, (tx) => tx.$queryRaw<{ b: boolean }[]>`SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)
        .then((r) => r[0].b);
    expect([await bypass(backend('A')), await bypass(anon), await bypass(service)]).toEqual([false, false, true]);
  });

  it('the replayed chain already carries the new rule', async () => {
    expect((await policy())[0].with_check).toBe(NEW_CHECK);
  });

  describe('under down.sql (the production text today)', () => {
    beforeAll(() => apply('down.sql'));

    it('restores the 20261213000000 text and comment exactly', async () => {
      expect(await policy()).toEqual([{
        with_check: OLD_CHECK,
        comment: 'Allow anonymous lead-funnel intake (user_id NULL) plus self-attributed and owner inserts.',
      }]);
    });

    it('the hole: a signed-in Data API caller inserts an anonymous row; anon errors', async () => {
      expect(await insert(service, null)).toBe(1);
      expect(await insert(dataApi('A'), null)).toBe(1);
      expect(await insert(anon, null)).toBe('42501 helper');
    });
  });

  describe('after the migration', () => {
    beforeAll(() => apply('migration.sql'));

    it('the policy reads the new rule', async () => {
      const [p] = await policy();
      expect(p.with_check).toBe(NEW_CHECK);
      expect(p.comment).toMatch(/^20270501000000: /);
    });

    it('a signed-in Data API caller can no longer insert any row', async () => {
      expect(await insert(service, null)).toBe(1);
      expect(await insert(dataApi('A'), null)).toBe(DENIED);
      expect(await insert(backend('A'), id.A)).toBe(1);
      expect(await insert(dataApi('A'), id.A)).toBe(DENIED);
    });

    it('the backend model inserts only a row attributed to the caller', async () => {
      expect(await insert(backend('A'), id.A)).toBe(1);
      expect(await insert(service, null)).toBe(1);
      expect(await insert(backend('A'), null)).toBe(DENIED);
      expect(await insert(backend('B'), id.B)).toBe(1);
      expect(await insert(backend('A'), id.B)).toBe(DENIED);
    });

    it('service_role writes the anonymous row; the owner admin still inserts; anon errors as before', async () => {
      expect(await insert(service, null)).toBe(1);
      expect(await insert(owner, null)).toBe(1);
      expect(await insert(owner, id.A)).toBe(1);
      expect(await insert(anon, null)).toBe('42501 helper');
    });

    it('reads are unchanged: only the attributed user reads their row', async () => {
      const reads = (who: Who) =>
        as(who, (tx) => tx.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS "count" FROM "DiagnosticSubmission" WHERE "id" LIKE ${`diag-${run}-%`} AND "user_id" = ${id.A}`)
          .then((r) => r[0].count);
      expect(await reads(backend('A'))).toBe(3); // two own inserts and the owner's row for A
      expect(await reads(backend('B'))).toBe(0);
      expect(await reads(dataApi('A'))).toBe(0);
    });
  });
});
