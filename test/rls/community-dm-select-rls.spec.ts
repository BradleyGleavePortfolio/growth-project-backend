/**
 * DM-SELECT-RLS: at the row layer a community DM reads only for its sender and its recipient. The workspace
 * coach keeps every non-DM row of the workspace (community_messages_select's coach arm reads scope 'cohort'
 * only) and no longer reaches another person's DM voice note (community_voice_notes_coach_all reads
 * conversation_id IS NULL only). The RESTRICTIVE policies (*_author_stays, *_unbanned_unblocked) still bind.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals (role authenticated, which does
 * not bypass row security), as test/rls/messages-tenure-rls.spec.ts models them:
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * Coach K owns W; A and B are K's clients with memberships in W's members space S; coach L owns W2 with client
 * C. Messages in W: dAB (A to B), dKA (K to A), dAK (A to K), a Hall row (a comment on a workspace-wide post,
 * cohort_id NULL) and a row of S, both by B; dCL (C to L) in W2. Voice notes in W: vAB (A's DM note) and vAH
 * (A's Hall note). Every id differs from its supabase id. Every 0 or refusal follows a control of 1 on the
 * same row. Writes that would change a fixture row run in a transaction that is rolled back. The suite runs
 * down.sql (the text before) and migration.sql again (case 11), and proves three mutations of the new text
 * fail their cases, each restored by migration.sql before the next.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-dm-select-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502011400_community_dm_select_parties_only');
// A migration file's statements; BEGIN/COMMIT become the one transaction apply() opens.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
const TABLES = ['community_messages', 'community_voice_notes', 'community_responses'];
const MSG = 'community_messages.community_messages_select';
const VOICE = 'community_voice_notes.community_voice_notes_coach_all';
const RESP_COACH = 'community_responses.community_responses_coach_all';
const RESP_MEMBER = 'community_responses.community_responses_member_select';
const FN = `app.community_response_dm_party("CommunityResponseTargetType", uuid)`;
// The policy text as the deparser prints it, line breaks folded.
const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
const COACH = 'app.is_community_workspace_coach(workspace_id)';
const COHORT = `(scope = 'cohort'::"CommunityMessageScope")`;
const DM_ARM = `((scope = 'dm'::"CommunityMessageScope") AND ((sender_id = app.current_user_id()) OR (recipient_user_id = app.current_user_id())))`;
const MSG_NEW = `((${COACH} AND ${COHORT}) OR (${COHORT} AND app.shares_community_cohort(cohort_id)) OR ${DM_ARM})`;
const MSG_OLD = `(${COACH} OR (${COHORT} AND app.shares_community_cohort(cohort_id)) OR ${DM_ARM})`;
const VOICE_NEW = `(${COACH} AND (conversation_id IS NULL))`;
const VOICE_OLD = COACH;
const MEMBER = 'app.is_community_workspace_member(workspace_id)';
const DM_PARTY = 'app.community_response_dm_party(target_type, target_id)';
const RESP_COACH_NEW = `(${COACH} AND ${DM_PARTY})`;
const RESP_MEMBER_NEW = `(${MEMBER} AND ${DM_PARTY})`;

type Key = 'K' | 'L' | 'A' | 'B' | 'C';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', A: 'student', B: 'student', C: 'student' };
const DENIED = '42501';
const ROLLBACK = 'community-dm-select-rls: rolled back on purpose';
const sqlState = (e: unknown) => {
  const err = e as { code?: string; meta?: { code?: string } };
  return String(err.code === 'P2010' ? err.meta?.code : err.code);
};

(DB_URL ? describe : describe.skip)('DM-SELECT-RLS: a community DM reads only for its sender and its recipient', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['K', 'L', 'A', 'B', 'C']; // coaches first: clients reference them
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = { K: randomUUID(), L: randomUUID() };
  const space = { K: randomUUID(), L: randomUUID() }; // a members space in each workspace
  const row = { dAB: randomUUID(), dKA: randomUUID(), dAK: randomUUID(), hall: randomUUID(), inS: randomUUID(), dCL: randomUUID() };
  const voice = { vAB: randomUUID(), vAH: randomUUID() };
  const BODY = 'RLS words of A to B';

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
  const as = <T>(who: Who | 'anon', query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await enter(tx, who);
      return query(tx);
    });
  // Rows counted (or the SQLSTATE of the refusal).
  const count = (who: Who | 'anon', sql: string, ...params: unknown[]): Promise<number | string> =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(sql, ...params)).then((r) => r[0].n, sqlState);
  const reads = (who: Who | 'anon', rowId: string) =>
    count(who, `SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id" = $1::uuid`, rowId);
  const readsVoice = (who: Who, noteId: string) =>
    count(who, `SELECT count(*)::int AS "n" FROM "community_voice_notes" WHERE "id" = $1::uuid`, noteId);
  // The ids of W's messages a principal reads (null: every row, as the superuser).
  const idsOfW = async (who: Who | null, dmOnly = false) => {
    const sql = `SELECT "id"::text AS "id" FROM "community_messages" WHERE "workspace_id" = $1::uuid ${dmOnly ? `AND "scope" = 'dm'` : ''}`;
    const list = who
      ? await as(who, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(sql, ws.K))
      : await prisma.$queryRawUnsafe<{ id: string }[]>(sql, ws.K);
    return list.map((r) => r.id).sort();
  };
  // A write run as `who`, then rolled back: the rows it touched (or the SQLSTATE of its refusal), and dAB as
  // the superuser sees it inside the same transaction right after the write (null once deleted).
  const dryRun = async (who: Who, sql: string, ...params: unknown[]) => {
    let out: { n: number | string; dAB: { body: string | null; seen: boolean } | null } | undefined;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await enter(tx, who);
      let n: number | string;
      try {
        n = await tx.$executeRawUnsafe(sql, ...params);
      } catch (e) {
        out = { n: sqlState(e), dAB: null };
        throw e;
      }
      await tx.$executeRawUnsafe('RESET ROLE');
      const [now] = await tx.$queryRawUnsafe<{ body: string | null; seen: boolean }[]>(
        `SELECT "body", "coach_seen_at" IS NOT NULL AS "seen" FROM "community_messages" WHERE "id" = $1::uuid`, row.dAB);
      out = { n, dAB: now ?? null };
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => {
      if (!(e instanceof Error && e.message === ROLLBACK) && !out) throw e;
    });
    return out!;
  };
  const say = (msgId: string, workspace: string, sender: Key, data: { scope: 'cohort' | 'dm'; to?: Key; cohort?: string; comment?: boolean; body?: string }) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body",
         "plan_context_type", "plan_context_id", "updated_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"CommunityMessageScope", $5, $6, $7, $8, $9, $10::uuid, now())`,
      msgId, workspace, data.cohort ?? null, data.scope,
      data.scope === 'dm' ? `dm-${run}-${[id[sender], id[data.to!]].sort().join('-')}` : null,
      data.to ? id[data.to] : null, id[sender], data.body ?? `RLS words of ${sender}`,
      data.comment ? 'community_post_comment' : null, data.comment ? randomUUID() : null);
  const note = (noteId: string, author: Key, conversation: string | null) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "community_voice_notes" ("id", "workspace_id", "cohort_id", "conversation_id", "author_id", "storage_key", "duration_ms", "bytes", "mime_type")
       VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, $4, $5, 3000, 1000, 'audio/mp4')`,
      noteId, ws.K, conversation, id[author], `${id[author]}/1700000000000-${randomUUID().replace(/-/g, '').slice(0, 16)}.m4a`);
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  type Policy = { name: string; permissive: string; cmd: string; roles: string; qual: string | null; check: string | null };
  const policies = () => prisma.$queryRaw<Policy[]>`
    SELECT p."tablename" || '.' || p."policyname" AS "name", p."permissive", p."cmd", p."roles"::text AS "roles",
           p."qual", p."with_check" AS "check"
    FROM pg_policies p WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[]) ORDER BY 1`
    .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })));
  const pick = (list: Policy[], name: string) => list.find((p) => p.name === name);
  const others = (list: Policy[]) => list.filter((p) => ![MSG, VOICE, RESP_COACH, RESP_MEMBER].includes(p.name));
  const hasFn = () => prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS "n" FROM pg_proc WHERE "oid" = to_regprocedure($1)`, FN).then((r) => r[0].n);
  let chain: Policy[] = [];

  beforeAll(async () => {
    for (const k of keys) {
      const coach = k === 'A' || k === 'B' ? id.K : k === 'C' ? id.L : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`dm-select-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    for (const c of ['K', 'L'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`dm-select-${run}-${c}`}, now())`;
      await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "updated_at")
        VALUES (${space[c]}::uuid, ${ws[c]}::uuid, 'RLS members space', now())`;
    }
    for (const [k, c] of [['A', 'K'], ['B', 'K'], ['C', 'L']] as [Key, 'K' | 'L'][]) {
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ws[c]}::uuid, ${space[c]}::uuid, ${id[k]}, now())`;
    }
    await say(row.dAB, ws.K, 'A', { scope: 'dm', to: 'B', body: BODY });
    await say(row.dKA, ws.K, 'K', { scope: 'dm', to: 'A' });
    await say(row.dAK, ws.K, 'A', { scope: 'dm', to: 'K' });
    await say(row.hall, ws.K, 'B', { scope: 'cohort', comment: true });
    await say(row.inS, ws.K, 'B', { scope: 'cohort', cohort: space.K });
    await say(row.dCL, ws.L, 'C', { scope: 'dm', to: 'L' });
    await note(voice.vAB, 'A', randomUUID());
    await note(voice.vAH, 'A', null);
    chain = await policies();
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('K'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('case 1: the workspace coach reads a DM between two of his clients by id: 0', async () => {
    expect(await reads(backend('A'), row.dAB)).toBe(1); // control: the sender
    expect(await reads(backend('K'), row.dAB)).toBe(0);
  });

  it('case 2: every DM of W the workspace coach reads is one he is in: exactly dKA and dAK', async () => {
    expect(await idsOfW(null, true)).toEqual([row.dAB, row.dKA, row.dAK].sort()); // control: all three exist
    expect(await idsOfW(backend('K'), true)).toEqual([row.dKA, row.dAK].sort());
  });

  it('case 3: the workspace coach reads every row of W but that DM', async () => {
    const all = await idsOfW(null);
    expect(all).toContain(row.dAB);
    expect(await idsOfW(backend('K'))).toEqual(all.filter((x) => x !== row.dAB));
  });

  it('case 4: the DM reads for its sender and its recipient only', async () => {
    expect(await reads(backend('A'), row.dAB)).toBe(1);
    expect(await reads(backend('B'), row.dAB)).toBe(1);
    expect(await reads(backend('C'), row.dAB)).toBe(0);
    expect(await reads(backend('L'), row.dAB)).toBe(0);
    expect(await reads(backend('L'), row.dCL)).toBe(1); // control: L reads his own DM in W2
  });

  it('case 5: the coach\'s own DMs read for him and his client, not for another client', async () => {
    for (const msg of [row.dKA, row.dAK]) {
      expect(await reads(backend('K'), msg)).toBe(1);
      expect(await reads(backend('A'), msg)).toBe(1);
      expect(await reads(backend('B'), msg)).toBe(0);
    }
  });

  it('case 6: the workspace coach still reads the Hall row and the space row; a space member reads the space row', async () => {
    expect(await reads(backend('K'), row.hall)).toBe(1);
    expect(await reads(backend('K'), row.inS)).toBe(1);
    expect(await reads(backend('A'), row.inS)).toBe(1);
    expect(await reads(backend('C'), row.inS)).toBe(0); // control: outside W
  });

  it('case 7: a ban and a block still hide the author\'s DM from the coach; the author reads her own', async () => {
    expect(await reads(backend('K'), row.dAK)).toBe(1); // control
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.K, user_id: id.A, banned_by_id: id.K } });
    try {
      expect(await reads(backend('K'), row.dAK)).toBe(0);
      expect(await reads(backend('A'), row.dAK)).toBe(1);
    } finally {
      await prisma.communityWorkspaceBan.updateMany({ where: { workspace_id: ws.K, user_id: id.A }, data: { lifted_at: new Date() } });
    }
    expect(await reads(backend('K'), row.dAK)).toBe(1); // the ban lifted
    await prisma.userBlock.create({ data: { blocker_id: id.A, blocked_id: id.K } });
    try {
      expect(await reads(backend('K'), row.dAK)).toBe(0);
      expect(await reads(backend('A'), row.dAK)).toBe(1);
    } finally {
      await prisma.userBlock.deleteMany({ where: { blocker_id: id.A, blocked_id: id.K } });
    }
    expect(await reads(backend('K'), row.dAK)).toBe(1); // the block removed
  });

  it('case 8: the Data API model and anon read nothing; a month partition read directly is refused', async () => {
    const readers: Record<string, Key> = { [row.dAB]: 'A', [row.dKA]: 'K', [row.dAK]: 'K', [row.hall]: 'K', [row.inS]: 'K' };
    for (const [msg, reader] of Object.entries(readers)) {
      expect(await reads(backend(reader), msg)).toBe(1); // control
      expect(await reads(dataApi('K'), msg)).toBe(0);
      expect(await reads(dataApi('A'), msg)).toBe(0);
      expect([0, DENIED]).toContain(await reads('anon', msg)); // no row, or refused: anon reads nothing
    }
    const [{ part }] = await prisma.$queryRawUnsafe<{ part: string }[]>(
      `SELECT "tableoid"::regclass::text AS "part" FROM "community_messages" WHERE "id" = $1::uuid`, row.dAK);
    const direct = `SELECT count(*)::int AS "n" FROM ${part} WHERE "id" = $1::uuid`;
    expect((await prisma.$queryRawUnsafe<{ n: number }[]>(direct, row.dAK))[0].n).toBe(1); // control: the row is there
    expect(await count(backend('K'), direct, row.dAK)).toBe(DENIED);
  });

  it('case 9 (Found, not fixed): a write that reads no column still reaches the DM through the write policies', async () => {
    // No WHERE: Postgres applies only the UPDATE and DELETE policies (the SELECT ones join only when a column
    // is read), and their coach arm still covers every row of W (20270502002400 :142-150, unchanged here).
    expect(await dryRun(backend('L'), `UPDATE "community_messages" SET "coach_seen_at" = now()`))
      .toMatchObject({ dAB: { body: BODY, seen: false } }); // control: another workspace's coach does not reach it
    expect(await dryRun(backend('K'), `UPDATE "community_messages" SET "coach_seen_at" = now()`))
      .toMatchObject({ dAB: { body: BODY, seen: true } });
    expect(await dryRun(backend('K'), `DELETE FROM "community_messages"`)).toMatchObject({ dAB: null });
    expect(await reads(backend('A'), row.dAB)).toBe(1); // rolled back: dAB is as it was
  });

  it('case 10: the workspace coach still sends a DM to his client', async () => {
    const sent = await dryRun(backend('K'),
      `INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'RLS dm', now())`,
      randomUUID(), ws.K, `dm-${run}-${randomUUID()}`, id.A, id.K);
    expect(sent.n).toBe(1);
  });

  it('case 13: the workspace coach no longer reads another person\'s DM voice note; Hall notes stay', async () => {
    expect(await readsVoice(backend('A'), voice.vAB)).toBe(1); // control: the author
    expect(await readsVoice(backend('K'), voice.vAH)).toBe(1); // control: the coach still reads a Hall note
    expect(await readsVoice(backend('K'), voice.vAB)).toBe(0);
    expect(await readsVoice(backend('B'), voice.vAB)).toBe(0);
    expect(await readsVoice(backend('L'), voice.vAB)).toBe(0);
  });

  it('case 11: the chain prints the new texts; down.sql restores the old ones exactly; migration.sql brings the new back', async () => {
    expect(pick(chain, MSG)).toEqual({ name: MSG, permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{public}', qual: MSG_NEW, check: null });
    expect(pick(chain, VOICE)).toEqual({ name: VOICE, permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{public}', qual: VOICE_NEW, check: COACH });
    expect(pick(chain, RESP_COACH)).toEqual({ name: RESP_COACH, permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{public}', qual: RESP_COACH_NEW, check: COACH });
    expect(pick(chain, RESP_MEMBER)).toEqual({ name: RESP_MEMBER, permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{public}', qual: RESP_MEMBER_NEW, check: null });
    expect(await hasFn()).toBe(1);
    expect(await reads(backend('K'), row.dAB)).toBe(0);
    expect(await readsVoice(backend('K'), voice.vAB)).toBe(0);
    await apply('down.sql');
    try {
      const down = await policies();
      expect(pick(down, MSG)).toEqual({ ...pick(chain, MSG), qual: MSG_OLD });
      expect(pick(down, VOICE)).toEqual({ ...pick(chain, VOICE), qual: VOICE_OLD });
      expect(pick(down, RESP_COACH)).toEqual({ ...pick(chain, RESP_COACH), qual: COACH });
      expect(pick(down, RESP_MEMBER)).toEqual({ ...pick(chain, RESP_MEMBER), qual: MEMBER });
      expect(await hasFn()).toBe(0); // the function is gone after down.sql
      expect(others(down)).toEqual(others(chain));
      expect(await reads(backend('K'), row.dAB)).toBe(1); // case 1 under the old text
      expect(await readsVoice(backend('K'), voice.vAB)).toBe(1); // case 13 under the old text
    } finally {
      await apply('migration.sql');
    }
    expect(await policies()).toEqual(chain);
    expect(await hasFn()).toBe(1); // and back after migration.sql
    expect(await reads(backend('K'), row.dAB)).toBe(0);
    expect(await readsVoice(backend('K'), voice.vAB)).toBe(0);
  });

  describe('mutation proofs (each restored by migration.sql before the next)', () => {
    const COACH_SQL = 'app.is_community_workspace_coach("workspace_id")';
    const COHORT_ARM = `("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))`;
    const DM_FULL = `("scope" = 'dm' AND ("sender_id"::text = app.current_user_id() OR "recipient_user_id"::text = app.current_user_id()))`;
    const DM_SENDER = `("scope" = 'dm' AND "sender_id"::text = app.current_user_id())`;
    const mutate = (using: string) =>
      prisma.$executeRawUnsafe(`ALTER POLICY "community_messages_select" ON "community_messages" USING (${using})`);
    afterEach(() => apply('migration.sql'));

    it('the coach arm\'s scope test dropped: cases 1 to 3 would see the DM', async () => {
      await mutate(`${COACH_SQL} OR ${COHORT_ARM} OR ${DM_FULL}`);
      expect(await reads(backend('K'), row.dAB)).toBe(1);
      expect(await idsOfW(backend('K'), true)).toContain(row.dAB);
      expect(await idsOfW(backend('K'))).toEqual(await idsOfW(null));
    });

    it('the DM arm cut to the sender only: case 5 would lose the coach\'s read of dAK', async () => {
      await mutate(`(${COACH_SQL} AND "scope" = 'cohort') OR ${COHORT_ARM} OR ${DM_SENDER}`);
      expect(await reads(backend('A'), row.dAK)).toBe(1); // the sender still reads it
      expect(await reads(backend('K'), row.dAK)).toBe(0);
    });

    it('the coach arm dropped altogether: case 6 would lose the Hall row', async () => {
      await mutate(`${COHORT_ARM} OR ${DM_FULL}`);
      expect(await reads(backend('K'), row.inS)).toBe(1); // the space row still reads (the coach passes the space rule)
      expect(await reads(backend('K'), row.hall)).toBe(0);
    });

    it('restored: the chain\'s text, and cases 1, 5 and 6 hold again', async () => {
      expect(await policies()).toEqual(chain);
      expect(await reads(backend('K'), row.dAB)).toBe(0);
      expect(await reads(backend('K'), row.dAK)).toBe(1);
      expect(await reads(backend('K'), row.hall)).toBe(1);
    });
  });

  it('case 9: the coach\'s UPDATE and DELETE by id of that DM touch nothing; its sender\'s do', async () => {
    // A WHERE that reads a column makes Postgres apply the SELECT policies too, so the coach arm's scope test
    // reaches these writes. Before the change each touched dAB (1).
    expect(await dryRun(backend('A'), `UPDATE "community_messages" SET "body" = 'edited' WHERE "id" = $1::uuid`, row.dAB))
      .toEqual({ n: 1, dAB: { body: 'edited', seen: false } }); // control
    expect(await dryRun(backend('K'), `UPDATE "community_messages" SET "body" = 'edited' WHERE "id" = $1::uuid`, row.dAB))
      .toEqual({ n: 0, dAB: { body: BODY, seen: false } });
    expect(await dryRun(backend('A'), `DELETE FROM "community_messages" WHERE "id" = $1::uuid`, row.dAB))
      .toEqual({ n: 1, dAB: null }); // control
    expect(await dryRun(backend('K'), `DELETE FROM "community_messages" WHERE "id" = $1::uuid`, row.dAB))
      .toEqual({ n: 0, dAB: { body: BODY, seen: false } });
    expect(await reads(backend('A'), row.dAB)).toBe(1); // rolled back: dAB is as it was
  });
});
