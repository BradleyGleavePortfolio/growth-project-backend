/**
 * COMMUNITY-DM-RULES-BE (agent 203; owner #203-E49, 203-D11 op 1 and 203-D12; operator rulings R-a to R-i), the row
 * layer and the SQL function, on Postgres: community direct messages are on by default (the column default and every
 * existing community), and the workspace's coach K and a former client X (X's coach is no longer K) keep reading,
 * writing and reacting in their existing DM thread while X is still in the community and neither has blocked the other,
 * at the row layer as at the API (test/community/community-dm-rules-be.spec.ts); nobody else gains a read or a write.
 *
 * Disposable postgres:15 from test/ls-1197-live-fixture.ts (the whole chain by prisma migrate deploy), principals as
 * test/dm-reaction-write-rls-be.spec.ts (copied, not imported; role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app setting (the Supabase Data API model)
 * World: coach K owns W with spaces S (members), P (public), C3 (clients, no rows) and Pk (package); coach L owns W2.
 * A and B are K's clients in S. X has a row in S and a thread with K (dKX: X to K, dXK: K to X); Y as X with no thread;
 * Z as X with its row removed; V as X and banned in W; U as X whose only row is in P; Q as X whose only row is in Pk (no
 * purchase); T has no row and a thread; then the coach of X, Y, Z, V, U, Q and T is set to L. dAB (A to B) and dBA.
 * Every write is a dry run (made as someone, then rolled back): 1 = written, a SQLSTATE = refused. Each ban, block,
 * move or default set inside a case is set as the superuser and undone in a finally.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';
import { CommunityRepository } from '../src/community/community.repository';

jest.setTimeout(600_000);

type Key = 'K' | 'L' | 'A' | 'B' | 'X' | 'Y' | 'Z' | 'V' | 'U' | 'Q' | 'T' | 'N';
const PEOPLE: Key[] = ['K', 'L', 'A', 'B', 'X', 'Y', 'Z', 'V', 'U', 'Q', 'T']; // coaches first: clients reference them
const FORMER: Key[] = ['X', 'Y', 'Z', 'V', 'U', 'Q', 'T'];
const ROLE: Record<Key, string> = {
  K: 'coach', L: 'coach', N: 'coach', A: 'student', B: 'student', X: 'student', Y: 'student', Z: 'student', V: 'student',
  U: 'student', Q: 'student', T: 'student',
};
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const DENIED = '42501';
const ROLLBACK = 'community-dm-rules-be: rolled back on purpose';
const sqlState = (e: unknown) => {
  const err = e as { code?: string; meta?: { code?: string } };
  return String(err.code === 'P2010' ? err.meta?.code : err.code);
};

const DIR = join(__dirname, '..', 'prisma', 'migrations', '20270502011600_community_dms_on_and_former_client_thread');
const B1248 = join(__dirname, '..', 'prisma', 'migrations', '20270502011500_community_reaction_writes_need_target', 'migration.sql');
// A migration file's statements; BEGIN/COMMIT become the one transaction apply() opens.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
const TABLES = ['community_messages', 'community_responses', 'community_posts', 'community_voice_notes'];
const NEW_POLICIES = ['community_messages.community_messages_dm_former_client_insert',
  'community_responses.community_responses_dm_former_client_insert', 'community_responses.community_responses_dm_former_client_select'];
const STAYS = 'community_messages.community_messages_author_stays';
// 20270502006400 :50-51 as the deparser prints it.
const STAYS_OLD = '((sender_id = app.current_user_id()) OR app.community_author_stays(workspace_id, cohort_id, sender_id))';
const FUNCTIONS = ['community_dm_former_client', 'community_dm_former_client_target'];

/** The same pairs and answers as test/community/community-dm-rules-be.spec.ts PAIRS (the double's half). */
const PAIRS: Array<[string, Key, Key, boolean]> = [
  ['K and X (a former client with a row and a thread)', 'K', 'X', true],
  ['X and K (the coach must come first)', 'X', 'K', false],
  ['K and Y (no thread)', 'K', 'Y', false],
  ['K and Z (row removed)', 'K', 'Z', false],
  ['K and V (banned)', 'K', 'V', false],
  ['K and U (only a public row)', 'K', 'U', false],
  ['K and Q (only a lapsed package row)', 'K', 'Q', false],
  ['K and T (no row)', 'K', 'T', false],
  ['K and A (a current client: today\'s arm, not this one)', 'K', 'A', false],
  ['L and X (X\'s new coach does not run W)', 'L', 'X', false],
  ['A and B (two clients)', 'A', 'B', false],
  ['K and K', 'K', 'K', false],
];

describe('COMMUNITY-DM-RULES-BE: DMs on by default; the coach and a former client keep their thread, at the row layer', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  const all: Key[] = [...PEOPLE, 'N'];
  const id = Object.fromEntries(all.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(all.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = { K: randomUUID(), L: randomUUID() };
  const space = { S: randomUUID(), P: randomUUID(), C3: randomUUID(), Pk: randomUUID(), W2: randomUUID() };
  // dK<p>: p to K; d<p>K: K to p.
  const msg: Record<string, string> = Object.fromEntries(
    [...FORMER.flatMap((k) => [`dK${k}`, `d${k}K`]), 'dAB', 'dBA', 'inSX'].map((m) => [m, randomUUID()]));
  const post = { hallX: randomUUID() };
  const resp = { rK: randomUUID() }; // K's reaction on dXK
  let kinds = 0;

  const enter = async (tx: Prisma.TransactionClient, who: Who | 'anon') => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who === 'anon' ? 'anon' : 'authenticated'}`);
    if (who === 'anon') return;
    await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
      JSON.stringify({ sub: sub[who.key], role: 'authenticated' }));
    if (who.guc) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who.key]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who.key]);
    }
  };
  const count = (who: Who | 'anon', sql: string, ...params: unknown[]): Promise<number | string> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await enter(tx, who);
      return tx.$queryRawUnsafe<{ n: number }[]>(sql, ...params);
    }).then((r) => r[0].n, sqlState);
  const reads = (who: Who | 'anon', m: string) =>
    count(who, `SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id" = $1::uuid`, msg[m]);
  const readsPost = (who: Who, p: string) => count(who, `SELECT count(*)::int AS "n" FROM "community_posts" WHERE "id" = $1::uuid`, p);
  const readsReaction = (who: Who | 'anon', r: string) =>
    count(who, `SELECT count(*)::int AS "n" FROM "community_responses" WHERE "id" = $1::uuid`, r);
  const dryRun = async (who: Who | 'anon', sql: string, ...params: unknown[]): Promise<number | string> => {
    let out: number | string = 'none';
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await enter(tx, who);
      try {
        out = await tx.$executeRawUnsafe(sql, ...params);
      } catch (e) {
        out = sqlState(e);
        throw e;
      }
      throw new Error(ROLLBACK);
    }).catch(() => undefined);
    return out;
  };
  const key = (a: Key, b: Key) => `dm-${run}-${[id[a], id[b]].sort().join('-')}`;
  /** `who` writes a DM to `to` in W under their own name (or `as`). */
  const send = (who: Who | 'anon', to: Key, as?: Key) => {
    const from = as ?? (who === 'anon' ? 'X' : who.key);
    return dryRun(who, `INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
      VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'class words', now())`, randomUUID(), ws.K, key(from, to), id[to], id[from]);
  };
  /** `who` reacts on message `m` with a fresh kind under their own name. */
  const react = (who: Who | 'anon', m: string) =>
    dryRun(who, `INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "user_id", "response_kind")
      VALUES ($1::uuid, $2::uuid, 'message', $3::uuid, $4, $5)`, randomUUID(), ws.K, msg[m], id[who === 'anon' ? 'X' : who.key],
    `cdmr-${(kinds += 1)}`);

  const su = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  const ban = (k: Key) => su(
    `INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id", "banned_by_id") VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT ("workspace_id", "user_id") DO UPDATE SET "lifted_at" = NULL`, randomUUID(), ws.K, id[k], id.K);
  const lift = (k: Key) => su(`UPDATE "community_workspace_bans" SET "lifted_at" = now() WHERE "workspace_id" = $1::uuid AND "user_id" = $2`, ws.K, id[k]);
  const block = (a: Key, b: Key) => prisma.userBlock.create({ data: { blocker_id: id[a], blocked_id: id[b] } });
  const unblock = (a: Key, b: Key) => prisma.userBlock.deleteMany({ where: { blocker_id: id[a], blocked_id: id[b] } });
  const coachOf = (k: Key, coach: Key) => su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id[coach], id[k]);
  const say = (m: string, sender: Key, to: Key) =>
    su(`INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, $6, now())`, msg[m], ws.K, key(sender, to), id[to], id[sender], `class words of ${sender}`);
  const former = (c: Key, k: Key) => prisma.$queryRawUnsafe<{ ok: boolean }[]>(
    `SELECT app.community_dm_former_client($1::uuid, $2, $3) AS "ok"`, ws.K, id[c], id[k]).then((r) => r[0].ok);

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of PEOPLE) {
      const coach = ['A', 'B', ...FORMER].includes(k) ? id.K : null;
      await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'class user', $4::"Role", $5)`,
        id[k], sub[k], `cdmr-${id[k]}`, ROLE[k], coach);
    }
    for (const c of ['K', 'L'] as const) {
      await su(`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'class workspace', $3, now())`,
        ws[c], id[c], `cdmr-${run}-${c}`);
    }
    const spaces: Array<[string, string, string]> = [[space.S, ws.K, 'members'], [space.P, ws.K, 'public'], [space.C3, ws.K, 'clients'],
      [space.Pk, ws.K, 'package'], [space.W2, ws.L, 'members']];
    for (const [cohort, w, visibility] of spaces) {
      await su(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'class space', $3::"CommunitySpaceVisibility", now())`, cohort, w, visibility);
    }
    const rows: Array<[Key, string]> = [['A', space.S], ['B', space.S], ['X', space.S], ['Y', space.S], ['Z', space.S], ['V', space.S],
      ['U', space.P], ['Q', space.Pk]];
    for (const [k, cohort] of rows) {
      await su(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
        randomUUID(), ws.K, cohort, id[k]);
    }
    for (const k of FORMER.filter((f) => f !== 'Y')) {
      await say(`dK${k}`, k, 'K');
      await say(`d${k}K`, 'K', k);
    }
    await say('dAB', 'A', 'B');
    await say('dBA', 'B', 'A');
    await su(`INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "sender_id", "body", "updated_at")
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'cohort', $4, 'class words of X', now())`, msg.inSX, ws.K, space.S, id.X);
    await su(`INSERT INTO "community_posts" ("id", "workspace_id", "cohort_id", "author_id", "scope", "body", "updated_at")
      VALUES ($1::uuid, $2::uuid, NULL, $3, 'hall', 'class post', now())`, post.hallX, ws.K, id.X);
    await su(`INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "user_id", "response_kind")
      VALUES ($1::uuid, $2::uuid, 'message', $3::uuid, $4, 'like')`, resp.rK, ws.K, msg.dXK, id.K);
    await su(`UPDATE "community_memberships" SET "status" = 'removed', "removed_at" = now() WHERE "user_id" = $1`, id.Z);
    await ban('V');
    for (const k of FORMER) await coachOf(k, 'L');
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('runs as a role that does not bypass row security', async () => {
    expect(await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await enter(tx, backend('K'));
      return tx.$queryRaw<{ b: boolean }[]>`SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`;
    })).toEqual([{ b: false }]);
  });

  it('D11-1 (live half). A community row inserted without the column, and one made by the app\'s writer (ensureWorkspaceForCoach), read dm_enabled_default true', async () => {
    const bare = randomUUID();
    let got: Record<string, unknown> = {};
    await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role") VALUES ($1, $2, $3, 'class user', 'coach'::"Role")`,
      id.N, sub.N, `cdmr-${id.N}`);
    try {
      await su(`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'bare', $3, now())`,
        bare, id.L, `cdmr-${run}-bare`);
      const made = await new CommunityRepository(db.db).ensureWorkspaceForCoach(id.N);
      const rows = await prisma.$queryRawUnsafe<{ id: string; d: boolean }[]>(
        `SELECT "id"::text AS "id", "dm_enabled_default" AS "d" FROM "community_workspaces" WHERE "id" IN ($1::uuid, $2::uuid)`, bare, made?.id ?? bare);
      got = { bare: rows.find((r) => r.id === bare)?.d, writer: made?.dm_enabled_default, writerRow: rows.find((r) => r.id === made?.id)?.d };
    } finally {
      await su(`DELETE FROM "community_cohorts" WHERE "workspace_id" IN (SELECT "id" FROM "community_workspaces" WHERE "coach_id" = $1)`, id.N);
      await su(`DELETE FROM "community_workspaces" WHERE "id" = $1::uuid OR "coach_id" = $2`, bare, id.N);
      await su(`DELETE FROM "User" WHERE "id" = $1`, id.N);
    }
    expect(got).toEqual({ bare: true, writer: true, writerRow: true });
  });

  it('D12-2. K reads dKX, X reads dXK; X writes to K and K to X; X reads K\'s reaction on dXK; each reacts on the other\'s row', async () => {
    expect({
      KreadsKX: await reads(backend('K'), 'dKX'),
      XreadsXK: await reads(backend('X'), 'dXK'),
      XtoK: await send(backend('X'), 'K'),
      KtoX: await send(backend('K'), 'X'),
      XreadsRK: await readsReaction(backend('X'), resp.rK),
      KreactsKX: await react(backend('K'), 'dKX'),
      XreactsXK: await react(backend('X'), 'dXK'),
    }).toEqual({ KreadsKX: 1, XreadsXK: 1, XtoK: 1, KtoX: 1, XreadsRK: 1, KreactsKX: 1, XreactsXK: 1 });
  });

  it('D12-2 (matrix). Every other reader of the thread\'s rows and K\'s reaction as at the base: L, A, B, Y read none; the Data API and anon none', async () => {
    const got: Record<string, number | string> = {};
    for (const k of ['K', 'L', 'A', 'B', 'X', 'Y'] as Key[]) {
      got[`dKX:${k}`] = await reads(backend(k), 'dKX');
      got[`dXK:${k}`] = await reads(backend(k), 'dXK');
      got[`rK:${k}`] = await readsReaction(backend(k), resp.rK);
    }
    got['dKX:dataApiX'] = await reads(dataApi('X'), 'dKX');
    got['dXK:dataApiK'] = await reads(dataApi('K'), 'dXK');
    const anon = await reads('anon', 'dXK');
    got['dXK:anon'] = anon === 0 ? DENIED : anon;
    expect(got).toEqual({
      'dKX:K': 1, 'dXK:K': 1, 'rK:K': 1, 'dKX:L': 0, 'dXK:L': 0, 'rK:L': 0, 'dKX:A': 0, 'dXK:A': 0, 'rK:A': 0,
      'dKX:B': 0, 'dXK:B': 0, 'rK:B': 0, 'dKX:X': 1, 'dXK:X': 1, 'rK:X': 1, 'dKX:Y': 0, 'dXK:Y': 0, 'rK:Y': 0,
      'dKX:dataApiX': 0, 'dXK:dataApiK': 0, 'dXK:anon': DENIED,
    });
  });

  it.each(['Z', 'V', 'U', 'Q', 'T'] as const)('D12-3. %s (removed, banned, public only, lapsed package, no row): closed both ways at the row layer', async (k) => {
    expect({
      Kreads: await reads(backend('K'), `dK${k}`),
      toK: await send(backend(k), 'K'),
      Kto: await send(backend('K'), k),
      reactsOnK: await react(backend(k), `d${k}K`),
      Kreacts: await react(backend('K'), `dK${k}`),
    }).toEqual({ Kreads: 0, toK: DENIED, Kto: DENIED, reactsOnK: DENIED, Kreacts: DENIED });
  });

  it('D12-3. Y (no thread): no DM either way; V with the ban lifted: open again', async () => {
    const got: Record<string, number | string> = { YtoK: await send(backend('Y'), 'K'), KtoY: await send(backend('K'), 'Y') };
    await lift('V');
    try {
      got.KreadsKVlifted = await reads(backend('K'), 'dKV');
      got.VtoKlifted = await send(backend('V'), 'K');
    } finally {
      await ban('V');
    }
    got.KreadsKVbanned = await reads(backend('K'), 'dKV');
    expect(got).toEqual({ YtoK: DENIED, KtoY: DENIED, KreadsKVlifted: 1, VtoKlifted: 1, KreadsKVbanned: 0 });
  });

  it.each([
    ['K blocks X', 'K', 'X'],
    ['X blocks K', 'X', 'K'],
  ] as const)('D12-4. %s: each other\'s rows refused (community_messages_unbanned_unblocked), reactions refused; lifted, open again', async (_l, a, b) => {
    const got: Record<string, number | string> = {};
    await block(a, b);
    try {
      got.KreadsKX = await reads(backend('K'), 'dKX');
      got.XreadsXK = await reads(backend('X'), 'dXK');
      got.KreactsKX = await react(backend('K'), 'dKX');
      got.XreactsXK = await react(backend('X'), 'dXK');
      // A DM insert has no block test at 7f566a59 and this job adds none (the API refuses with 403 blocked_by_*).
      got.XtoK = await send(backend('X'), 'K');
    } finally {
      await unblock(a, b);
    }
    got.KreadsKXlifted = await reads(backend('K'), 'dKX');
    expect(got).toEqual({ KreadsKX: 0, XreadsXK: 0, KreactsKX: DENIED, XreactsXK: DENIED, XtoK: 1, KreadsKXlifted: 1 });
  });

  it('D12-6. Nothing else opens: K reads none of X\'s space and Hall rows; L and A read nothing of the thread; dBA closes when B moves (R-h)', async () => {
    const got: Record<string, number | string> = {
      KinSX: await reads(backend('K'), 'inSX'),
      KhallX: await readsPost(backend('K'), post.hallX),
      LdKX: await reads(backend('L'), 'dKX'),
      AdKX: await reads(backend('A'), 'dKX'),
      AdBA: await reads(backend('A'), 'dBA'),
    };
    await coachOf('B', 'L');
    try {
      got.AdBAmoved = await reads(backend('A'), 'dBA');
      got.BtoAmoved = await send(backend('B'), 'A');
      got.LtoX = await send(backend('L'), 'X');
    } finally {
      await coachOf('B', 'K');
    }
    expect(got).toEqual({ KinSX: 0, KhallX: 0, LdKX: 0, AdKX: 0, AdBA: 1, AdBAmoved: 0, BtoAmoved: DENIED, LtoX: DENIED });
  });

  it('F2 (SQL half). app.community_dm_former_client answers the pair table as the double does', async () => {
    const got: Record<string, boolean> = {};
    for (const [label, c, k] of PAIRS) got[label] = await former(c, k);
    expect(got).toEqual(Object.fromEntries(PAIRS.map(([label, , , want]) => [label, want])));
  });

  describe('the round trip: HEAD, then down.sql as the superuser (BASE), then migration.sql (HEAD again)', () => {
    type Policy = { name: string; permissive: string; cmd: string; roles: string; qual: string | null; check: string | null };
    const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
    const policies = () => prisma.$queryRaw<Policy[]>`
      SELECT p."tablename" || '.' || p."policyname" AS "name", p."permissive", p."cmd", p."roles"::text AS "roles",
             p."qual", p."with_check" AS "check"
      FROM pg_policies p WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[]) ORDER BY 1`
      .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })));
    const others = (list: Policy[]) => list.filter((p) => !NEW_POLICIES.includes(p.name) && p.name !== STAYS);
    type Fn = { name: string; definer: boolean; volatile: string; config: string[]; owner: string; authed: boolean; service: boolean;
      anon: boolean; pub: boolean };
    const fnInfo = () => prisma.$queryRawUnsafe<Fn[]>(
      `SELECT p."proname"::text AS "name", p."prosecdef" AS "definer", p."provolatile"::text AS "volatile", p."proconfig" AS "config",
              pg_get_userbyid(p."proowner")::text AS "owner",
              has_function_privilege('authenticated', p."oid", 'EXECUTE') AS "authed",
              has_function_privilege('service_role', p."oid", 'EXECUTE') AS "service",
              has_function_privilege('anon', p."oid", 'EXECUTE') AS "anon",
              EXISTS (SELECT 1 FROM aclexplode(p."proacl") a WHERE a."grantee" = 0) AS "pub"
       FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
       WHERE n."nspname" = 'app' AND p."proname" = ANY($1::text[]) ORDER BY 1`, FUNCTIONS);
    const targetOpen = () => prisma.$queryRawUnsafe<{ src: string; comment: string | null }[]>(
      `SELECT p."prosrc" AS "src", obj_description(p."oid", 'pg_proc') AS "comment"
       FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
       WHERE n."nspname" = 'app' AND p."proname" = 'community_response_target_open'`).then((r) => r[0]);
    const writes = async () => ({
      KreadsKX: await reads(backend('K'), 'dKX'), XtoK: await send(backend('X'), 'K'), KtoX: await send(backend('K'), 'X'),
      XreadsRK: await readsReaction(backend('X'), resp.rK), KreactsKX: await react(backend('K'), 'dKX'),
      XreactsXK: await react(backend('X'), 'dXK'),
    });
    const state = async () => ({ policies: await policies(), fn: await fnInfo(), target: await targetOpen(), writes: await writes() });
    const at: { head?: Awaited<ReturnType<typeof state>>; base?: Awaited<ReturnType<typeof state>>; again?: Awaited<ReturnType<typeof state>> } = {};
    beforeAll(async () => {
      at.head = await state();
      await apply('down.sql');
      try {
        at.base = await state();
      } finally {
        await apply('migration.sql');
      }
      at.again = await state();
      console.log(`COMMUNITY-DM-RULES-BE round trip ${JSON.stringify({ head: at.head.writes, base: at.base.writes, again: at.again.writes })}`);
    });

    it('F1: down.sql drops the three new policies and restores community_messages_author_stays to 20270502006400; migration.sql brings all back; every other policy equal', () => {
      const names = (list: Policy[]) => list.map((p) => p.name);
      for (const n of NEW_POLICIES) {
        expect(names(at.head!.policies)).toContain(n);
        expect(names(at.base!.policies)).not.toContain(n);
      }
      expect(at.base!.policies.find((p) => p.name === STAYS)?.qual).toBe(STAYS_OLD);
      expect(at.head!.policies.find((p) => p.name === STAYS)?.qual).not.toBe(STAYS_OLD);
      expect(others(at.base!.policies)).toEqual(others(at.head!.policies));
      expect(at.again!.policies).toEqual(at.head!.policies);
    });

    it('F1: b#1248\'s function body and comment back at BASE exactly as 20270502011500 wrote them; the new body at HEAD again', () => {
      const text = readFileSync(B1248, 'utf8');
      const body = text.slice(text.indexOf('AS $fn$') + 'AS $fn$'.length, text.indexOf('$fn$;'));
      const comment = /IS\n  '([\s\S]*?)';\n/.exec(text.slice(text.indexOf('COMMENT ON FUNCTION app.community_response_target_open')))?.[1]
        .replace(/''/g, "'");
      expect(at.base!.target).toEqual({ src: body, comment });
      expect(at.head!.target.src).not.toBe(body);
      expect(at.again!.target).toEqual(at.head!.target);
    });

    it('F1: the D12-2 writes and reads are open at HEAD, refused at BASE, open again', () => {
      const open = { KreadsKX: 1, XtoK: 1, KtoX: 1, XreadsRK: 1, KreactsKX: 1, XreactsXK: 1 };
      expect(at.head!.writes).toEqual(open);
      expect(at.base!.writes).toEqual({ KreadsKX: 0, XtoK: DENIED, KtoX: DENIED, XreadsRK: 0, KreactsKX: DENIED, XreactsXK: DENIED });
      expect(at.again!.writes).toEqual(open);
    });

    it('F2: each new function is SECURITY DEFINER, owned by postgres, search_path pinned, run by authenticated and service_role, not anon or PUBLIC; gone after down.sql, back after migration.sql', () => {
      const want = (name: string): Fn => ({ name, definer: true, volatile: 's', config: ['search_path=pg_catalog, public'], owner: 'postgres',
        authed: true, service: true, anon: false, pub: false });
      expect(at.head!.fn).toEqual(FUNCTIONS.map(want));
      expect(at.base!.fn).toEqual([]);
      expect(at.again!.fn).toEqual(FUNCTIONS.map(want));
    });
  });

  it('D11-3. After migration.sql every community reads true and the column default is true, community_memberships.dm_enabled untouched; after down.sql the default is false and the rows keep true', async () => {
    const extra = [randomUUID(), randomUUID()];
    const rowsWithSetting: Array<[string, boolean | null, Key]> = [[randomUUID(), null, 'A'], [randomUUID(), true, 'B'], [randomUUID(), false, 'X']];
    const columnDefault = () => prisma.$queryRawUnsafe<{ d: string }[]>(
      `SELECT "column_default" AS "d" FROM information_schema.columns WHERE "table_name" = 'community_workspaces' AND "column_name" = 'dm_enabled_default'`)
      .then((r) => r[0].d);
    const falseCount = () => prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS "n" FROM "community_workspaces" WHERE NOT "dm_enabled_default"`).then((r) => r[0].n);
    const settings = () => prisma.$queryRawUnsafe<{ id: string; v: boolean | null }[]>(
      `SELECT "id"::text AS "id", "dm_enabled" AS "v" FROM "community_memberships" ORDER BY "id"`);
    const got: Record<string, unknown> = {};
    let before: Array<{ id: string; v: boolean | null }> = [];
    try {
      await apply('down.sql');
      try {
        got.baseDefault = await columnDefault();
        for (const [i, w] of extra.entries()) {
          await su(`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'old', $3, now())`,
            w, id.L, `cdmr-${run}-old-${i}`);
        }
        await su(`UPDATE "community_workspaces" SET "dm_enabled_default" = false WHERE "id" = $1::uuid`, ws.L);
        for (const [m, v, k] of rowsWithSetting) {
          await su(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "dm_enabled", "updated_at")
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now())`, m, ws.L, space.W2, id[k], v);
        }
        got.falseBefore = await falseCount();
        before = await settings();
      } finally {
        await apply('migration.sql');
      }
      got.membershipsSameAfterUp = JSON.stringify(await settings()) === JSON.stringify(before);
      got.headDefault = await columnDefault();
      got.falseAfter = await falseCount();
      await apply('down.sql');
      try {
        got.downDefault = await columnDefault();
        got.falseAfterDown = await falseCount();
      } finally {
        await apply('migration.sql');
      }
      got.membershipsSame = JSON.stringify(await settings()) === JSON.stringify(before);
      got.settings = (await settings()).filter((r) => rowsWithSetting.some(([m]) => m === r.id)).map((r) => r.v).sort();
    } finally {
      await su(`DELETE FROM "community_memberships" WHERE "id" = ANY($1::uuid[])`, rowsWithSetting.map(([m]) => m));
      await su(`DELETE FROM "community_workspaces" WHERE "id" = ANY($1::uuid[])`, extra);
    }
    expect(got).toEqual({
      baseDefault: 'false', falseBefore: 3, membershipsSameAfterUp: true, headDefault: 'true', falseAfter: 0, downDefault: 'false',
      falseAfterDown: 0, membershipsSame: true, settings: [false, true, null].sort(),
    });
  });
});
