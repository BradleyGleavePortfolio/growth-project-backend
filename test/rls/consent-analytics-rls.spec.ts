/**
 * RLSLIVE3c (RLSINV I03, H07): only the client grants consent, and only to the
 * coach who coaches them now; signals, predictions, cached insights and
 * outcome labels are written by the server (outcome labels also by the
 * client's current coach or the owner admin).
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A is a client who moved from coach F to coach K, B is K's other client and C
 * is coach L's client. Every id differs from its supabase id (RLSINV Y04).
 * consentF is an F-era row. The suite runs down.sql (the production text
 * today, exactly), then migration.sql, which must give the state the replayed
 * chain gave. Every write runs in a transaction that is rolled back, so no
 * attempt changes a row; every 0 or 42501 follows a control of 1.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('consent-analytics-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502000500_consent_and_analytics_rows');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

const SERVER_ONLY = ['ClientSignal', 'PtmPrediction', 'HolisticInsightCache'];
const TABLES = ['ClientCoachConsent', ...SERVER_ONLY, 'ClientOutcome'];
// Every policy on the five tables in the production catalog of 2026-10-13 (keys
// t, p, c, r, q, w), whose dump folds the deparser's line breaks into spaces.
const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
const USER = '(app.is_owner() OR ((app.current_user_id() IS NOT NULL) AND ((user_id = app.current_user_id()) OR app.is_current_coach_of(user_id))))';
const CONSENT = '(app.is_owner() OR ((app.current_user_id() IS NOT NULL) AND ((client_id = app.current_user_id()) OR (coach_id = app.current_user_id()) OR app.is_current_coach_of(client_id))))';
type Row = { name: string; cmd: string; roles: string; qual: string | null; check: string | null };
const set = (t: string, rows: [string, string, string | null, string | null][]): Row[] =>
  rows.map(([p, cmd, qual, check]) => ({ name: `${t}.p_${t.toLowerCase()}_${p}`, cmd,
    roles: cmd === 'ALL' ? '{service_role}' : '{public}', qual, check }));
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);
const PROD: Row[] = [
  ...set('ClientCoachConsent', [['delete', 'DELETE', 'app.is_owner()', null], ['insert', 'INSERT', null, CONSENT],
    ['select', 'SELECT', CONSENT, null], ['service_role_all', 'ALL', 'true', 'true'],
    ['update', 'UPDATE', 'app.is_owner()', 'app.is_owner()']]),
  ...[...SERVER_ONLY, 'ClientOutcome'].flatMap((t) => set(t, [['delete', 'DELETE', USER, null], ['insert', 'INSERT', null, USER],
    ['select', 'SELECT', USER, null], ['service_role_all', 'ALL', 'true', 'true'], ['update', 'UPDATE', USER, USER]])),
].sort(byName);
// The comments down.sql restores on the policies the migration touches.
const tier4 = (verb: string) => `PR-RLS-06 user-self-current-coach ${verb}: owner, the user, or the user's current coach.`;
const OLD_COMMENT: Record<string, string> = {
  'ClientCoachConsent.p_clientcoachconsent_insert':
    'A client may record their own consent and a coach may record consent for their client; owner is also allowed.',
  'ClientCoachConsent.p_clientcoachconsent_select':
    'Read consent rows only as the consenting client, the named coach, the current coach of that client, or an owner.',
  ...Object.fromEntries([...SERVER_ONLY.flatMap((t) => ['insert', 'update', 'delete'].map((v) => [t, v])),
    ['ClientOutcome', 'insert'], ['ClientOutcome', 'update'], ['ClientOutcome', 'delete']]
    .map(([t, v]) => [`${t}.p_${t.toLowerCase()}_${v}`, tier4(v)])),
};

type Key = 'A' | 'B' | 'C' | 'F' | 'K' | 'L';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { A: 'student', B: 'student', C: 'student', F: 'coach', K: 'coach', L: 'coach' };
const COACH: Partial<Record<Key, Key>> = { A: 'F', B: 'K', C: 'L' }; // A moves F -> K after the F-era rows
const DENIED = '42501';
class Rollback extends Error { constructor(readonly n: number) { super('rollback'); } }

(DB_URL ? describe : describe.skip)('consent and analytics rows', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['F', 'K', 'L', 'A', 'B', 'C']; // clients last: they reference their coach
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const r = Object.fromEntries(['consentF', 'consentK', 'sig', 'pred', 'insight', 'outcome']
    .map((k) => [k, randomUUID()])) as Record<string, string>;
  const ROW: Record<string, string> = { ClientCoachConsent: r.consentK, ClientSignal: r.sig, PtmPrediction: r.pred,
    HolisticInsightCache: r.insight, ClientOutcome: r.outcome };
  const SET: Record<string, string> = { ClientCoachConsent: `"revoked_at" = now()`, ClientSignal: `"value" = 99`,
    PtmPrediction: `"risk_score" = 0.99`, HolisticInsightCache: `"payload" = '{"rls":1}'`, ClientOutcome: `"outcome_type" = 'churned'` };

  const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: sub[who.key], role: 'authenticated' }));
      if (who.guc) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who.key]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who.key]);
      }
      return query(tx);
    });
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  // Rows written (or the SQLSTATE of the refusal); always rolled back.
  const write = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      await as(who, async (tx) => { throw new Rollback(await tx.$executeRawUnsafe(sql, ...params)); });
    } catch (e) {
      if (e instanceof Rollback) return e.n;
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
    throw new Error('unreachable');
  };
  const reads = (who: Who, table: string, rowId: string) =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id" = $1`, rowId))
      .then((x) => x[0].n);
  const update = (who: Who, table: string, rowId: string, change = SET[table]) =>
    write(who, `UPDATE "${table}" SET ${change} WHERE "id" = $1`, rowId);
  const remove = (who: Who, table: string, rowId: string) => write(who, `DELETE FROM "${table}" WHERE "id" = $1`, rowId);
  const consent = (who: Who, client: Key, coach: Key) => write(who, `INSERT INTO "ClientCoachConsent" ("id", "client_id",
    "coach_id", "scope", "granted_at") VALUES ($1, $2, $3, $4, now())`, randomUUID(), id[client], id[coach], `rls.${randomUUID()}`);
  const INSERT: Record<string, string> = {
    ClientSignal: `INSERT INTO "ClientSignal" ("id", "user_id", "signal_type") VALUES ($1, $2, 'checkin_streak')`,
    PtmPrediction: `INSERT INTO "PtmPrediction" ("id", "user_id", "risk_score", "success_score", "prediction_basis")
      VALUES ($1, $2, 0.9, 0.1, 'heuristic_v1')`,
    HolisticInsightCache: `INSERT INTO "HolisticInsightCache" ("id", "user_id", "window_days", "payload", "expires_at")
      VALUES ($1, $2, 7, '{}', now())`,
    ClientOutcome: `INSERT INTO "ClientOutcome" ("id", "user_id", "outcome_type") VALUES ($1, $2, 'milestone_hit')`,
  };
  const insert = (who: Who, table: string, user: Key) => write(who, INSERT[table], randomUUID(), id[user]);
  const policies = () => prisma.$queryRaw<(Row & { comment: string | null })[]>`
    SELECT p."tablename" || '.' || p."policyname" AS "name", p."cmd", p."roles"::text AS "roles", p."qual",
           p."with_check" AS "check", obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = format('public.%I', p."tablename")::regclass
    WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[])`
    .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })).sort(byName));
  let chain: Awaited<ReturnType<typeof policies>> = [];

  beforeAll(async () => {
    for (const k of keys) {
      const coach = COACH[k];
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`consent-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach ? id[coach] : null})`;
    }
    for (const [row, coach] of [[r.consentF, id.F], [r.consentK, id.K]]) {
      await prisma.clientCoachConsent.create({ data: { id: row, client_id: id.A, coach_id: coach,
        scope: 'fitness.food_macros', granted_at: new Date() } });
    }
    await prisma.clientSignal.create({ data: { id: r.sig, user_id: id.A, signal_type: 'checkin_streak', value: 5 } });
    await prisma.ptmPrediction.create({ data: { id: r.pred, user_id: id.A, risk_score: 0.5, success_score: 0.5,
      prediction_basis: 'heuristic_v1' } });
    await prisma.holisticInsightCache.create({ data: { id: r.insight, user_id: id.A, window_days: 30, payload: {},
      expires_at: new Date(Date.now() + 86_400_000) } });
    await prisma.clientOutcome.create({ data: { id: r.outcome, user_id: id.A, outcome_type: 'renewed' } });
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.K} WHERE "id" = ${id.A}`; // A moves F -> K
    chain = await policies();
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('A'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  describe('under down.sql (the production text today)', () => {
    beforeAll(() => apply('down.sql'));
    afterAll(() => apply('migration.sql'));

    it('restores every policy on the five tables to the production catalog text exactly', async () => {
      const now = await policies();
      expect(now.map(({ comment: _c, ...p }) => p)).toEqual(PROD);
      for (const [name, comment] of Object.entries(OLD_COMMENT)) expect(now.find((p) => p.name === name)?.comment).toBe(comment);
      const untouched = (list: typeof now) => list.filter((p) => !(p.name in OLD_COMMENT));
      expect(untouched(now)).toEqual(untouched(chain));
    });

    it('the holes: a coach grants consent, a former coach reads it, people write the analytics rows', async () => {
      expect(await consent(backend('K'), 'C', 'K')).toBe(1);
      expect(await consent(backend('A'), 'A', 'L')).toBe(1);
      expect(await reads(backend('F'), 'ClientCoachConsent', r.consentF)).toBe(1);
      for (const t of SERVER_ONLY) {
        expect(await insert(backend('A'), t, 'A')).toBe(1);
        expect(await insert(backend('K'), t, 'A')).toBe(1);
      }
      expect(await update(backend('K'), 'PtmPrediction', r.pred)).toBe(1);
      expect(await insert(backend('B'), 'ClientOutcome', 'B')).toBe(1);
      expect(await remove(backend('A'), 'ClientOutcome', r.outcome)).toBe(1);
    });
  });

  describe('after the migration', () => {
    it('gives exactly the state the replayed chain gave', async () => {
      expect(await policies()).toEqual(chain);
    });

    it('consent: only the client grants, and only naming the coach who coaches them now', async () => {
      expect(await consent(backend('A'), 'A', 'K')).toBe(1);
      expect(await consent(backend('K'), 'A', 'K')).toBe(DENIED);
      expect(await consent(backend('K'), 'C', 'K')).toBe(DENIED);
      expect(await consent(backend('A'), 'A', 'L')).toBe(DENIED);
      expect(await consent(backend('A'), 'A', 'F')).toBe(DENIED);
      expect(await consent(backend('F'), 'A', 'F')).toBe(DENIED);
    });

    it('consent: the client reads every own row, the current coach his own, a former coach none', async () => {
      expect(await reads(backend('A'), 'ClientCoachConsent', r.consentF)).toBe(1);
      expect(await reads(backend('A'), 'ClientCoachConsent', r.consentK)).toBe(1);
      expect(await reads(backend('K'), 'ClientCoachConsent', r.consentK)).toBe(1);
      expect(await reads(backend('F'), 'ClientCoachConsent', r.consentF)).toBe(0);
      expect(await reads(backend('K'), 'ClientCoachConsent', r.consentF)).toBe(0);
      expect(await reads(backend('L'), 'ClientCoachConsent', r.consentK)).toBe(0);
      for (const k of ['A', 'K'] as Key[]) {
        expect(await update(backend(k), 'ClientCoachConsent', r.consentK)).toBe(0);
        expect(await remove(backend(k), 'ClientCoachConsent', r.consentK)).toBe(0);
      }
    });

    it('signals, predictions and cached insights: the client and the current coach read them, nobody writes', async () => {
      for (const t of SERVER_ONLY) {
        for (const k of ['A', 'K'] as Key[]) {
          expect(await reads(backend(k), t, ROW[t])).toBe(1);
          expect(await insert(backend(k), t, 'A')).toBe(DENIED);
          expect(await update(backend(k), t, ROW[t])).toBe(0);
          expect(await remove(backend(k), t, ROW[t])).toBe(0);
          expect(await reads(backend(k), t, ROW[t])).toBe(1);
        }
        expect(await reads(backend('F'), t, ROW[t])).toBe(0);
        expect(await reads(backend('L'), t, ROW[t])).toBe(0);
      }
    });

    it('outcomes: the current coach labels and relabels; the client and a former coach do not', async () => {
      expect(await insert(backend('K'), 'ClientOutcome', 'B')).toBe(1);
      expect(await insert(backend('B'), 'ClientOutcome', 'B')).toBe(DENIED);
      expect(await insert(backend('K'), 'ClientOutcome', 'C')).toBe(DENIED);
      expect(await insert(backend('F'), 'ClientOutcome', 'A')).toBe(DENIED);
      expect(await update(backend('K'), 'ClientOutcome', r.outcome)).toBe(1);
      expect(await update(backend('K'), 'ClientOutcome', r.outcome, `"user_id" = '${id.C}'`)).toBe(DENIED);
      expect(await reads(backend('A'), 'ClientOutcome', r.outcome)).toBe(1);
      expect(await update(backend('A'), 'ClientOutcome', r.outcome)).toBe(0);
      expect(await update(backend('F'), 'ClientOutcome', r.outcome)).toBe(0);
      for (const k of ['A', 'K'] as Key[]) expect(await remove(backend(k), 'ClientOutcome', r.outcome)).toBe(0);
      expect(await reads(backend('K'), 'ClientOutcome', r.outcome)).toBe(1);
      expect(await reads(backend('F'), 'ClientOutcome', r.outcome)).toBe(0);
    });

    it('the Data API model (JWT, no GUC) reads nothing on any of the five tables', async () => {
      for (const t of TABLES) {
        for (const k of ['A', 'K'] as Key[]) {
          expect(await reads(backend(k), t, ROW[t])).toBe(1);
          expect(await reads(dataApi(k), t, ROW[t])).toBe(0);
        }
      }
    });
  });
});
