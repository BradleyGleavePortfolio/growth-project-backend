/**
 * RLSLIVE2a (RLSINV G02, G03, G04): at the row layer a coach sees only the
 * nudges and review markers of the coaching relationship he is in, clients
 * never write coach-only rows, and a DM needs workspace membership and a
 * recipient in that same workspace.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A is a client who moves from coach F to coach K; B is K's client; C is coach
 * L's client. K and L each own a community workspace; A and B are members of
 * K's, C of L's. Every id differs from its supabase id (RLSINV Y04). The suite
 * runs down.sql (today's text; ConversationReview as #973 leaves it), then
 * migration.sql, which must give the state the replayed chain gave. Every 0
 * or 42501 follows a control of 1 on the same row or table.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('messages-tenure-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502000200_messages_follow_the_coaching_relationship');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

const TABLES = ['CoachNudge', 'ConversationReview', 'community_messages'];
const HELPER = 'app.workspace_has_participant(uuid,text)';
// The text of every policy down.sql restores, as the deparser prints it, line breaks folded.
const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
const NUDGE_OLD = '(app.is_owner() OR ((app.current_user_id() IS NOT NULL) AND ((coach_id = app.current_user_id()) OR (client_id = app.current_user_id()) OR app.is_current_coach_of(client_id))))';
const REVIEW_973 = '((app.current_user_id() IS NOT NULL) AND ((client_id = app.current_user_id()) OR ((coach_id = app.current_user_id()) AND app.is_user_coached_by(client_id, coach_id))))';
const DM_OLD = '((sender_id = app.current_user_id()) AND (app.is_community_workspace_coach(workspace_id) OR ((scope = \'cohort\'::"CommunityMessageScope") AND app.shares_community_cohort(cohort_id)) OR ((scope = \'dm\'::"CommunityMessageScope") AND (recipient_user_id IS NOT NULL))))';
const nudgeNote = (verb: string) => `PR-RLS-02: owner, the nudge coach, the nudge client, or the client's current coach may ${verb}.`;
const OLD: Record<string, [string, string | null, string | null, string | null]> = { // cmd, USING, CHECK, comment
  'CoachNudge.p_coachnudge_select': ['SELECT', NUDGE_OLD, null, nudgeNote('read')],
  'CoachNudge.p_coachnudge_insert': ['INSERT', null, NUDGE_OLD, nudgeNote('insert')],
  'CoachNudge.p_coachnudge_update': ['UPDATE', NUDGE_OLD, NUDGE_OLD, nudgeNote('update')],
  'CoachNudge.p_coachnudge_delete': ['DELETE', NUDGE_OLD, null, nudgeNote('delete')],
  'ConversationReview.conversation_review_participant_access': ['ALL', REVIEW_973, REVIEW_973, null],
  'community_messages.community_messages_author_insert': ['INSERT', null, DM_OLD, null],
};
const ADDED = ['ConversationReview.conversation_review_coach_access', 'ConversationReview.conversation_review_client_read'];

type Key = 'A' | 'B' | 'C' | 'F' | 'K' | 'L';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { A: 'student', B: 'student', C: 'student', F: 'coach', K: 'coach', L: 'coach' };
const DENIED = '42501';

(DB_URL ? describe : describe.skip)('messages follow the coaching relationship', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['F', 'K', 'L', 'A', 'B', 'C']; // clients last: they reference their coach
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = { K: randomUUID(), L: randomUUID() };
  const cohort = { K: randomUUID(), L: randomUUID() };
  const memberA = randomUUID();
  // nF: F's nudge to A (F era); nK, spare: K's nudges to A; rF / rK: F's and K's review markers of A's thread.
  const row = { nF: `nf-${run}`, nK: `nk-${run}`, spare: `ns-${run}`, rF: `rf-${run}`, rK: `rk-${run}` };

  const as = <T>(who: Who | 'anon', query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who === 'anon' ? 'anon' : 'authenticated'}`);
      if (who === 'anon') return query(tx);
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
  // Rows written (or the SQLSTATE of the refusal).
  const write = async (who: Who | 'anon', sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      return await as(who, (tx) => tx.$executeRawUnsafe(sql, ...params));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const reads = (who: Who, table: string, rowId: string) =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id"::text = $1`, rowId))
      .then((r) => r[0].n);
  const nudge = (who: Who | null, coach: Key, client: Key, nudgeId: string = randomUUID()) => {
    const sql = `INSERT INTO "CoachNudge" ("id", "coach_id", "client_id", "title", "body") VALUES ($1, $2, $3, 'RLS nudge', 'RLS body')`;
    return who ? write(who, sql, nudgeId, id[coach], id[client]) : prisma.$executeRawUnsafe(sql, nudgeId, id[coach], id[client]);
  };
  const review = (who: Who | null, coach: Key, client: Key, reviewId: string = randomUUID()) => {
    const sql = `INSERT INTO "ConversationReview" ("id", "coach_id", "client_id", "updated_at") VALUES ($1, $2, $3, now())`;
    return who ? write(who, sql, reviewId, id[coach], id[client]) : prisma.$executeRawUnsafe(sql, reviewId, id[coach], id[client]);
  };
  const touch = (who: Who, table: string, rowId: string) => write(who, table === 'CoachNudge'
    ? `UPDATE "CoachNudge" SET "read_at" = now() WHERE "id" = $1`
    : `UPDATE "ConversationReview" SET "coach_reviewed_at" = now() WHERE "id" = $1`, rowId);
  const remove = (who: Who, table: string, rowId: string) => write(who, `DELETE FROM "${table}" WHERE "id" = $1`, rowId);
  const dm = (who: Who | 'anon', from: Key, to: Key, workspace: string, msgId: string = randomUUID()) => write(who,
    `INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
     VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'RLS dm', now())`, msgId, workspace, `dm-${run}-${randomUUID()}`, id[to], id[from]);
  const moveA = (coach: Key) => prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id[coach]} WHERE "id" = ${id.A}`;
  const policies = () => prisma.$queryRaw<{ name: string; cmd: string; roles: string; qual: string | null; check: string | null; comment: string | null }[]>`
    SELECT p."tablename" || '.' || p."policyname" AS "name", p."cmd", p."roles"::text AS "roles", p."qual",
           p."with_check" AS "check", obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = format('public.%I', p."tablename")::regclass
    WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[]) ORDER BY 1`
    .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })));
  const helper = () => prisma.$queryRaw<{ exists: boolean }[]>`SELECT to_regprocedure(${HELPER}) IS NOT NULL AS "exists"`
    .then((r) => r[0].exists);
  let chain: Awaited<ReturnType<typeof policies>> = [];

  beforeAll(async () => {
    for (const k of keys) {
      const coach = k === 'A' ? id.F : k === 'B' ? id.K : k === 'C' ? id.L : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`messages-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    for (const c of ['K', 'L'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`rls-${run}-${c}`}, now())`;
      await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "updated_at")
        VALUES (${cohort[c]}::uuid, ${ws[c]}::uuid, 'RLS cohort', now())`;
    }
    for (const [k, c, memberId] of [['A', 'K', memberA], ['B', 'K', randomUUID()], ['C', 'L', randomUUID()]] as [Key, 'K' | 'L', string][]) {
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at")
        VALUES (${memberId}::uuid, ${ws[c]}::uuid, ${cohort[c]}::uuid, ${id[k]}, now())`;
    }
    await nudge(null, 'F', 'A', row.nF);
    await nudge(null, 'K', 'A', row.nK);
    await nudge(null, 'K', 'A', row.spare);
    await review(null, 'F', 'A', row.rF);
    await review(null, 'K', 'A', row.rK);
    chain = await policies();
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('A'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  describe('under down.sql (the text today)', () => {
    beforeAll(() => apply('down.sql'));
    afterAll(async () => {
      await moveA('F');
      await apply('migration.sql');
    });

    it('restores every touched policy exactly, drops the new ones and the helper, leaves the rest', async () => {
      const now = await policies();
      for (const [name, [cmd, qual, check, comment]] of Object.entries(OLD)) {
        expect(now.find((p) => p.name === name)).toEqual({ name, cmd, roles: '{public}', qual, check, comment });
      }
      expect(now.filter((p) => ADDED.includes(p.name))).toEqual([]);
      expect(await helper()).toBe(false);
      const untouched = (list: typeof now) => list.filter((p) => !(p.name in OLD) && !ADDED.includes(p.name));
      expect(untouched(now)).toEqual(untouched(chain));
    });

    it('the holes: the new coach reads the former coach\'s nudge, the client writes coach rows, DMs cross workspaces', async () => {
      await moveA('K');
      expect(await reads(backend('K'), 'CoachNudge', row.nF)).toBe(1);
      expect(await nudge(backend('A'), 'L', 'A')).toBe(1);
      expect(await touch(backend('A'), 'ConversationReview', row.rK)).toBe(1);
      expect(await dm(backend('A'), 'A', 'C', ws.L)).toBe(1);
    });
  });

  describe('after the migration', () => {
    it('gives exactly the state the replayed chain gave', async () => {
      expect(await policies()).toEqual(chain);
      expect(chain.map((p) => p.name)).not.toContain('ConversationReview.conversation_review_participant_access');
    });

    it('the helper is SECURITY DEFINER, STABLE, pinned, owned by postgres, executable by authenticated only', async () => {
      const [fn] = await prisma.$queryRaw<{ definer: boolean; volatile: string; config: string[]; owner: string;
        pub: boolean; anon: boolean; authed: boolean }[]>`
        SELECT p."prosecdef" AS "definer", p."provolatile"::text AS "volatile", p."proconfig" AS "config",
               pg_get_userbyid(p."proowner")::text AS "owner",
               EXISTS (SELECT 1 FROM aclexplode(p."proacl") a WHERE a."grantee" = 0) AS "pub",
               has_function_privilege('anon', p."oid", 'EXECUTE') AS "anon",
               has_function_privilege('authenticated', p."oid", 'EXECUTE') AS "authed"
        FROM pg_proc p WHERE p."oid" = to_regprocedure(${HELPER})`;
      expect(fn).toEqual({ definer: true, volatile: 's', config: ['search_path=pg_catalog, public'], owner: 'postgres',
        pub: false, anon: false, authed: true });
    });

    it('nudges before the move: F reads and edits his own; K reads none of them; A reads every nudge', async () => {
      expect(await reads(backend('F'), 'CoachNudge', row.nF)).toBe(1);
      expect(await touch(backend('F'), 'CoachNudge', row.nF)).toBe(1);
      expect(await reads(backend('K'), 'CoachNudge', row.nF)).toBe(0);
      expect(await reads(backend('A'), 'CoachNudge', row.nF)).toBe(1);
      expect(await reads(backend('A'), 'CoachNudge', row.nK)).toBe(1);
    });

    it('review markers before the move: F reads his marker of A\'s thread', async () => {
      expect(await reads(backend('F'), 'ConversationReview', row.rF)).toBe(1);
      expect(await reads(backend('A'), 'ConversationReview', row.rF)).toBe(1);
    });

    it('after the move: K reads his own nudge, never F\'s; F loses his; A keeps every nudge', async () => {
      await moveA('K');
      expect(await reads(backend('K'), 'CoachNudge', row.nK)).toBe(1);
      expect(await reads(backend('K'), 'CoachNudge', row.nF)).toBe(0);
      expect(await reads(backend('F'), 'CoachNudge', row.nF)).toBe(0);
      expect(await reads(backend('L'), 'CoachNudge', row.nK)).toBe(0);
      expect(await reads(backend('A'), 'CoachNudge', row.nF)).toBe(1);
      expect(await reads(backend('A'), 'CoachNudge', row.nK)).toBe(1);
      expect(await touch(backend('K'), 'CoachNudge', row.nK)).toBe(1);
      for (const k of ['K', 'F'] as Key[]) expect(await touch(backend(k), 'CoachNudge', row.nF)).toBe(0);
      expect(await remove(backend('F'), 'CoachNudge', row.nF)).toBe(0);
    });

    it('only the current coach writes nudges: the client and other coaches insert, edit and delete none', async () => {
      expect(await nudge(backend('K'), 'K', 'A')).toBe(1);
      expect(await nudge(backend('A'), 'K', 'A')).toBe(DENIED);
      expect(await nudge(backend('A'), 'L', 'A')).toBe(DENIED);
      expect(await nudge(backend('F'), 'F', 'A')).toBe(DENIED);
      expect(await nudge(backend('L'), 'L', 'A')).toBe(DENIED);
      expect(await nudge(backend('K'), 'K', 'C')).toBe(DENIED);
      expect(await nudge(backend('K'), 'L', 'A')).toBe(DENIED);
      expect(await touch(backend('K'), 'CoachNudge', row.nK)).toBe(1);
      expect(await touch(backend('A'), 'CoachNudge', row.nK)).toBe(0);
      expect(await remove(backend('A'), 'CoachNudge', row.nK)).toBe(0);
      expect(await write(backend('K'), `UPDATE "CoachNudge" SET "client_id" = $1 WHERE "id" = $2`, id.C, row.nK)).toBe(DENIED);
      expect(await remove(backend('K'), 'CoachNudge', row.spare)).toBe(1);
      expect(await reads(backend('A'), 'CoachNudge', row.nK)).toBe(1);
    });

    it('review markers after the move: K reads and stamps his own; F loses his; the client writes none', async () => {
      expect(await reads(backend('K'), 'ConversationReview', row.rK)).toBe(1);
      expect(await reads(backend('K'), 'ConversationReview', row.rF)).toBe(0);
      expect(await reads(backend('F'), 'ConversationReview', row.rF)).toBe(0);
      expect(await reads(backend('L'), 'ConversationReview', row.rK)).toBe(0);
      expect(await touch(backend('K'), 'ConversationReview', row.rK)).toBe(1);
      expect(await touch(backend('A'), 'ConversationReview', row.rK)).toBe(0);
      expect(await remove(backend('A'), 'ConversationReview', row.rK)).toBe(0);
      expect(await reads(backend('A'), 'ConversationReview', row.rK)).toBe(1); // the current thread's marker
      expect(await reads(backend('A'), 'ConversationReview', row.rF)).toBe(0); // the former coach's marker
      expect(await review(backend('K'), 'K', 'B')).toBe(1);
      expect(await review(backend('A'), 'L', 'A')).toBe(DENIED);
      expect(await review(backend('A'), 'K', 'B')).toBe(DENIED);
      expect(await review(backend('F'), 'F', 'B')).toBe(DENIED);
    });

    it('a DM needs the sender\'s membership and a recipient in that same workspace', async () => {
      const toCoach = randomUUID();
      expect(await dm(backend('A'), 'A', 'K', ws.K, toCoach)).toBe(1);
      expect(await dm(backend('A'), 'A', 'B', ws.K)).toBe(1);
      expect(await dm(backend('A'), 'A', 'C', ws.L)).toBe(DENIED);
      expect(await dm(backend('A'), 'A', 'L', ws.L)).toBe(DENIED);
      expect(await dm(backend('A'), 'A', 'C', ws.K)).toBe(DENIED);
      expect(await dm(backend('A'), 'B', 'K', ws.K)).toBe(DENIED); // as someone else
      expect(await dm('anon', 'A', 'K', ws.K)).toBe(DENIED);
      expect(await reads(backend('A'), 'community_messages', toCoach)).toBe(1);
      expect(await reads(backend('K'), 'community_messages', toCoach)).toBe(1);
      expect(await reads(backend('L'), 'community_messages', toCoach)).toBe(0);
      await prisma.$executeRaw`UPDATE "community_memberships" SET "status" = 'removed' WHERE "id" = ${memberA}::uuid`;
      expect(await dm(backend('A'), 'A', 'K', ws.K)).toBe(DENIED);
      await prisma.$executeRaw`UPDATE "community_memberships" SET "status" = 'active' WHERE "id" = ${memberA}::uuid`;
      expect(await dm(backend('A'), 'A', 'K', ws.K)).toBe(1);
    });

    it('the Data API model (JWT, no GUC) reads and writes nothing on the three tables', async () => {
      const msg = randomUUID();
      expect(await dm(backend('A'), 'A', 'K', ws.K, msg)).toBe(1);
      expect(await reads(backend('A'), 'CoachNudge', row.nK)).toBe(1);
      expect(await reads(backend('K'), 'CoachNudge', row.nK)).toBe(1);
      expect(await reads(backend('K'), 'ConversationReview', row.rK)).toBe(1);
      expect(await reads(backend('A'), 'community_messages', msg)).toBe(1);
      for (const k of ['A', 'K', 'F'] as Key[]) {
        expect(await reads(dataApi(k), 'CoachNudge', row.nK)).toBe(0);
        expect(await reads(dataApi(k), 'CoachNudge', row.nF)).toBe(0);
        expect(await reads(dataApi(k), 'ConversationReview', row.rK)).toBe(0);
        expect(await reads(dataApi(k), 'community_messages', msg)).toBe(0);
      }
      expect(await nudge(dataApi('K'), 'K', 'A')).toBe(DENIED);
      expect(await dm(dataApi('A'), 'A', 'K', ws.K)).toBe(DENIED);
    });
  });
});
