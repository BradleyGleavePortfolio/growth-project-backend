/**
 * DM-REACTION-WRITE-RLS-BE (LS-1245R2 C1 and the write half of C2, AUDIT 6776313449; [W2] "RLS for everything"), the
 * class spec for reaction writes at the row layer: a caller bound by row security inserts a community_responses row,
 * or moves one by UPDATE, only where src/community/reactions/community-reactions.service.ts:95-163 (resolveTarget)
 * would let that row's reactor make that reaction; every reaction the API writes that the row layer let in at
 * e24409bc still goes in; DELETE and every read are as at e24409bc.
 *
 * Disposable postgres:15 from test/ls-1197-live-fixture.ts (the whole chain by prisma migrate deploy). Principals as
 * test/fix-1245r1-dm-responses-class.spec.ts :37-40 and :84-99 (role authenticated, which does not bypass row
 * security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app setting (the Supabase Data API model)
 * Coach K owns W with spaces S and S2 (default visibility); A, B and M are K's clients in S; N is K's client in S2
 * only; coach L owns W2 with client C in its space. Messages: dAB (A to B), dKA (K to A), inS (B, in S), inS2 (N, in
 * S2), hallC (B, a Hall comment row), delS (B, in S, deleted), dCL (C to L, in W2). Posts: pS (B, in S), pHall (B,
 * the Hall). Reactions: rAB (B on dAB), rKA (A on dKA), rS (A on inS), rM (M on inS). Every write is a dryRun (run as
 * someone, then rolled back): 1 = written, a SQLSTATE = refused. Each ban, block, move or removal is set as the
 * superuser and undone in a finally.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';

jest.setTimeout(600_000);

type Key = 'K' | 'L' | 'A' | 'B' | 'M' | 'N' | 'C' | 'X' | 'O';
const READERS: Key[] = ['K', 'L', 'A', 'B', 'M', 'N', 'C']; // coaches first: clients reference them
const ROLE: Record<Key, string> = {
  K: 'coach', L: 'coach', A: 'student', B: 'student', M: 'student', N: 'student', C: 'student', X: 'student', O: 'owner',
};
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const DENIED = '42501';
const ROLLBACK = 'dm-reaction-write-rls-be: rolled back on purpose';
const sqlState = (e: unknown) => {
  const err = e as { code?: string; meta?: { code?: string } };
  return String(err.code === 'P2010' ? err.meta?.code : err.code);
};

const REACTIONS = ['rAB', 'rKA', 'rS', 'rM'] as const;
type R = (typeof REACTIONS)[number];
// Who reads each reaction at e24409bc, one digit per reader in READERS order (K L A B M N C); this job changes none.
const READS: Record<R, string> = {
  rAB: '0011000', // a DM's reaction: its two people (20270502011400)
  rKA: '1010000', // the coach's own DM: K and A
  rS: '1011110', // a space row: the coach and every member of W, N (not in S) included
  rM: '1011110',
};
// The same with B banned in W and A blocking M: B reads nothing in W; a block does not reach reaction reads.
const READS_BANNED: Record<R, string> = { rAB: '0010000', rKA: '1010000', rS: '1010110', rM: '1010110' };
type Matrix = Record<string, number | string>;
const pinned = (t: Record<R, string>): Matrix =>
  Object.fromEntries(REACTIONS.flatMap((r) => READERS.map((k, i): [string, number] => [`${r}:${k}`, Number(t[r][i])])));

const DIR = join(__dirname, '..', 'prisma', 'migrations', '20270502011500_community_reaction_writes_need_target');
// A migration file's statements; BEGIN/COMMIT become the one transaction apply() opens.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
const TABLES = ['community_responses', 'community_messages', 'community_posts'];
const TARGET_OPEN = 'app.community_response_target_open(workspace_id, target_type, target_id, user_id)';
// The two policies as the deparser prints them, line breaks folded.
const INSERT_POLICY = { name: 'community_responses.community_responses_target_open_insert', permissive: 'RESTRICTIVE', cmd: 'INSERT',
  roles: '{public}', qual: null, check: `((user_id = app.current_user_id()) AND ${TARGET_OPEN})` };
const UPDATE_POLICY = { name: 'community_responses.community_responses_target_open_update', permissive: 'RESTRICTIVE', cmd: 'UPDATE',
  roles: '{public}', qual: null, check: TARGET_OPEN };

describe('DM-REACTION-WRITE-RLS-BE: a reaction row is written only where the API lets its reactor make it', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  const id = Object.fromEntries((['K', 'L', 'A', 'B', 'M', 'N', 'C', 'X', 'O'] as Key[]).map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries((['K', 'L', 'A', 'B', 'M', 'N', 'C', 'X', 'O'] as Key[]).map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = { K: randomUUID(), L: randomUUID() };
  const space = { S: randomUUID(), S2: randomUUID(), W2: randomUUID(), S3: randomUUID() };
  const msg = {
    dAB: randomUUID(), dKA: randomUUID(), inS: randomUUID(), inS2: randomUUID(), hallC: randomUUID(), delS: randomUUID(),
    dCL: randomUUID(), chS: randomUUID(), dXA: randomUUID(),
  };
  const post = { pS: randomUUID(), pHall: randomUUID(), pW2: randomUUID() };
  const resp = Object.fromEntries(REACTIONS.map((r) => [r, randomUUID()])) as Record<R, string>;
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
  const reads = (who: Who | 'anon', r: R) =>
    count(who, `SELECT count(*)::int AS "n" FROM "community_responses" WHERE "id" = $1::uuid`, resp[r]);
  const matrix = async (): Promise<Matrix> => {
    const out: Matrix = {};
    for (const r of REACTIONS) for (const k of READERS) out[`${r}:${k}`] = await reads(backend(k), r);
    return out;
  };
  const outsiders = async () => {
    const out: Record<string, number | string> = {};
    for (const r of REACTIONS) {
      out[`${r}:dataApiA`] = await reads(dataApi('A'), r);
      out[`${r}:dataApiK`] = await reads(dataApi('K'), r);
      const a = await reads('anon', r);
      out[`${r}:anon`] = a === 0 ? DENIED : a; // anon reads none: 0 rows or refused, both "no"
    }
    return out;
  };
  // Writes run as `who` in one transaction, then rolled back: the rows each touched, up to and including the first
  // refusal (its SQLSTATE).
  const steps = async (who: Who | 'anon', writes: Array<[string, ...unknown[]]>): Promise<Array<number | string>> => {
    const out: Array<number | string> = [];
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await enter(tx, who);
      for (const [sql, ...params] of writes) {
        try {
          out.push(await tx.$executeRawUnsafe(sql, ...params));
        } catch (e) {
          out.push(sqlState(e));
          throw e;
        }
      }
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => {
      if (out.length === 0) throw e;
    });
    return out;
  };
  const dryRun = async (who: Who | 'anon', sql: string, ...params: unknown[]) => (await steps(who, [[sql, ...params]]))[0];
  const INSERT = `INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "user_id", "response_kind")
     VALUES ($1::uuid, $2::uuid, $3::"CommunityResponseTargetType", $4::uuid, $5, $6)`;
  // `who` reacts with a fresh kind; the row's user_id is `who` and its workspace W unless named.
  const react = (who: Who | 'anon', type: string, target: string, o: { ws?: string; user?: Key } = {}) =>
    dryRun(who, INSERT, randomUUID(), o.ws ?? ws.K, type, target,
      id[o.user ?? (who === 'anon' ? 'A' : who.key)], `dmrw-${(kinds += 1)}`);
  const UPDATE_SET = (set: string) => `UPDATE "community_responses" SET ${set} WHERE "id" = $1::uuid`;
  const DELETE = `DELETE FROM "community_responses" WHERE "id" = $1::uuid`;

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
  const say = (m: string, w: string, sender: Key, d: { scope: 'cohort' | 'dm'; to?: Key; cohort?: string; context?: string; deleted?: boolean }) =>
    su(`INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body",
          "plan_context_type", "plan_context_id", "deleted_at", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"CommunityMessageScope", $5, $6, $7, $8, $9, $10::uuid, $11::timestamptz, now())`,
      m, w, d.cohort ?? null, d.scope,
      d.scope === 'dm' ? `dm-${run}-${[id[sender], id[d.to!]].sort().join('-')}` : null,
      d.to ? id[d.to] : null, id[sender], `class words of ${sender}`,
      d.context ?? null, d.context ? randomUUID() : null, d.deleted ? new Date().toISOString() : null);
  const write = (p: string, w: string, author: Key, cohort: string | null) =>
    su(`INSERT INTO "community_posts" ("id", "workspace_id", "cohort_id", "author_id", "scope", "body", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"CommunityPostScope", 'class post', now())`,
      p, w, cohort, id[author], cohort ? 'cohort' : 'hall');

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of READERS) {
      const coach = ['A', 'B', 'M', 'N'].includes(k) ? id.K : k === 'C' ? id.L : null;
      await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'class user', $4::"Role", $5)`,
        id[k], sub[k], `dmrw-${id[k]}`, ROLE[k], coach);
    }
    for (const c of ['K', 'L'] as const) {
      await su(`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'class workspace', $3, now())`,
        ws[c], id[c], `dmrw-${run}-${c}`);
    }
    for (const [cohort, w, name] of [[space.S, ws.K, 'class space S'], [space.S2, ws.K, 'class space S2'], [space.W2, ws.L, 'class space W2']]) {
      await su(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "updated_at") VALUES ($1::uuid, $2::uuid, $3, now())`, cohort, w, name);
    }
    const members: [Key, string, string][] = [['A', space.S, ws.K], ['B', space.S, ws.K], ['M', space.S, ws.K], ['N', space.S2, ws.K], ['C', space.W2, ws.L]];
    for (const [k, cohort, w] of members) {
      await su(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
        randomUUID(), w, cohort, id[k]);
    }
    await say(msg.dAB, ws.K, 'A', { scope: 'dm', to: 'B' });
    await say(msg.dKA, ws.K, 'K', { scope: 'dm', to: 'A' });
    await say(msg.inS, ws.K, 'B', { scope: 'cohort', cohort: space.S });
    await say(msg.inS2, ws.K, 'N', { scope: 'cohort', cohort: space.S2 });
    await say(msg.hallC, ws.K, 'B', { scope: 'cohort', context: 'community_post_comment' });
    await say(msg.delS, ws.K, 'B', { scope: 'cohort', cohort: space.S, deleted: true });
    await say(msg.dCL, ws.L, 'C', { scope: 'dm', to: 'L' });
    await write(post.pS, ws.K, 'B', space.S);
    await write(post.pHall, ws.K, 'B', null);
    const seed = (r: R, who: Key, target: string) =>
      su(`INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "target_created_at", "user_id", "response_kind")
          VALUES ($1::uuid, $2::uuid, 'message', $3::uuid, (SELECT m."created_at" FROM "community_messages" m WHERE m."id" = $3::uuid), $4, 'like')`,
        resp[r], ws.K, target, id[who]);
    await seed('rAB', 'B', msg.dAB);
    await seed('rKA', 'A', msg.dKA);
    await seed('rS', 'A', msg.inS);
    await seed('rM', 'M', msg.inS);
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

  it('W1: another pair\'s DM: M and K on dAB refused; B and A on dAB, and K on his own dKA, written', async () => {
    expect({
      BonAB: await react(backend('B'), 'message', msg.dAB),
      AonAB: await react(backend('A'), 'message', msg.dAB),
      MonAB: await react(backend('M'), 'message', msg.dAB),
      KonAB: await react(backend('K'), 'message', msg.dAB),
      KonKA: await react(backend('K'), 'message', msg.dKA),
    }).toEqual({ BonAB: 1, AonAB: 1, MonAB: DENIED, KonAB: DENIED, KonKA: 1 });
  });

  it('W2: another community: C on dAB and L on inS with workspace W2 refused; C on dCL with W2 written', async () => {
    expect({
      CdCL: await react(backend('C'), 'message', msg.dCL, { ws: ws.L }),
      CdAB: await react(backend('C'), 'message', msg.dAB, { ws: ws.L }),
      LinS: await react(backend('L'), 'message', msg.inS, { ws: ws.L }),
    }).toEqual({ CdCL: 1, CdAB: DENIED, LinS: DENIED });
  });

  it('W3: a space the reactor is not in: N on inS and pS refused; N on inS2, M on inS and pS written', async () => {
    expect({
      NinS2: await react(backend('N'), 'message', msg.inS2),
      MinS: await react(backend('M'), 'message', msg.inS),
      MpS: await react(backend('M'), 'post', post.pS),
      NinS: await react(backend('N'), 'message', msg.inS),
      NpS: await react(backend('N'), 'post', post.pS),
    }).toEqual({ NinS2: 1, MinS: 1, MpS: 1, NinS: DENIED, NpS: DENIED });
  });

  it('W4: the Hall, as today: M on hallC as comment and on pHall as post written', async () => {
    expect({
      MhallC: await react(backend('M'), 'comment', msg.hallC),
      MpHall: await react(backend('M'), 'post', post.pHall),
    }).toEqual({ MhallC: 1, MpHall: 1 });
  });

  it('W5: a block (A blocks B): A on inS, pS and dAB and B on dAB refused; M on inS written; lifted, A on inS written', async () => {
    const got: Record<string, number | string> = {};
    await block('A', 'B');
    try {
      got.MinS = await react(backend('M'), 'message', msg.inS);
      got.AinS = await react(backend('A'), 'message', msg.inS);
      got.ApS = await react(backend('A'), 'post', post.pS);
      got.AdAB = await react(backend('A'), 'message', msg.dAB);
      got.BdAB = await react(backend('B'), 'message', msg.dAB);
    } finally {
      await unblock('A', 'B');
    }
    got.AinSlifted = await react(backend('A'), 'message', msg.inS);
    expect(got).toEqual({ MinS: 1, AinS: DENIED, ApS: DENIED, AdAB: DENIED, BdAB: DENIED, AinSlifted: 1 });
  });

  it('W6: bans: B (the author) banned, M on inS and pS refused, lifted 1; M (the reactor) banned, refused (own_insert already: a guard)', async () => {
    const got: Record<string, number | string> = {
      MinS: await react(backend('M'), 'message', msg.inS), MpS: await react(backend('M'), 'post', post.pS),
    };
    await ban('B');
    try {
      got.MinSauthorBanned = await react(backend('M'), 'message', msg.inS);
      got.MpSauthorBanned = await react(backend('M'), 'post', post.pS);
    } finally {
      await lift('B');
    }
    got.MinSlifted = await react(backend('M'), 'message', msg.inS);
    got.MpSlifted = await react(backend('M'), 'post', post.pS);
    await ban('M');
    try {
      got.MinSreactorBanned = await react(backend('M'), 'message', msg.inS);
    } finally {
      await lift('M');
    }
    expect(got).toEqual({ MinS: 1, MpS: 1, MinSauthorBanned: DENIED, MpSauthorBanned: DENIED, MinSlifted: 1, MpSlifted: 1, MinSreactorBanned: DENIED });
  });

  it('W7: a moved author (B\'s coach set to L): M on inS refused; restored, written', async () => {
    const got: Record<string, number | string> = { MinS: await react(backend('M'), 'message', msg.inS) };
    await coachOf('B', 'L');
    try {
      got.MinSmoved = await react(backend('M'), 'message', msg.inS);
    } finally {
      await coachOf('B', 'K');
    }
    got.MinSrestored = await react(backend('M'), 'message', msg.inS);
    expect(got).toEqual({ MinS: 1, MinSmoved: DENIED, MinSrestored: 1 });
  });

  // W8 and W8c are recorded, not asserted (the PLAN's DM-open branch point: app.community_workspace_open lets X of
  // W8c in, so no existing-helper expression matches assertDmOpen; DM-REACTION-OPEN-RLS under "Found, not fixed").
  it('W8 (recorded): a DM no longer open: B removed from S, A on dAB; A\'s coach set to L, K on dKA; each restored, written', async () => {
    const setStatus = (status: string) => su(`UPDATE "community_memberships" SET "status" = $1::"CommunityMembershipStatus"
      WHERE "cohort_id" = $2::uuid AND "user_id" = $3`, status, space.S, id.B);
    let removed: number | string = 0;
    let moved: number | string = 0;
    await setStatus('removed');
    try {
      removed = await react(backend('A'), 'message', msg.dAB);
    } finally {
      await setStatus('active');
    }
    await coachOf('A', 'L');
    try {
      moved = await react(backend('K'), 'message', msg.dKA);
    } finally {
      await coachOf('A', 'K');
    }
    console.log(`DM-REACTION-WRITE-RLS-BE W8 ${JSON.stringify({ AdABwithBremoved: removed, KdKAwithAmoved: moved })}`);
    expect({ AdAB: await react(backend('A'), 'message', msg.dAB), KdKA: await react(backend('K'), 'message', msg.dKA) }).toEqual({ AdAB: 1, KdKA: 1 });
  });

  it('W8c (recorded): a DM the API keeps closed that community_workspace_open opens: X (no membership row) to A', async () => {
    let got: Record<string, number | string> = {};
    await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'class user', 'student'::"Role", $4)`,
      id.X, sub.X, `dmrw-${id.X}`, id.K);
    try {
      await su(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'class space S3', 'clients'::"CommunitySpaceVisibility", now())`, space.S3, ws.K);
      await say(msg.dXA, ws.K, 'X', { scope: 'dm', to: 'A' });
      got = { AdXA: await react(backend('A'), 'message', msg.dXA), XdXA: await react(backend('X'), 'message', msg.dXA) };
    } finally {
      await su(`DELETE FROM "community_messages" WHERE "id" = $1::uuid`, msg.dXA);
      await su(`DELETE FROM "community_cohorts" WHERE "id" = $1::uuid`, space.S3);
      await su(`DELETE FROM "User" WHERE "id" = $1`, id.X);
    }
    console.log(`DM-REACTION-WRITE-RLS-BE W8c ${JSON.stringify(got)}`);
    expect(Object.keys(got)).toEqual(['AdXA', 'XdXA']);
  });

  it('W9: the target itself: random ids, a deleted row and a type that does not match the row refused; chS as message written', async () => {
    const got: Record<string, number | string> = {
      MinS: await react(backend('M'), 'message', msg.inS),
      MhallCcomment: await react(backend('M'), 'comment', msg.hallC),
      MrandomMessage: await react(backend('M'), 'message', randomUUID()),
      MrandomPost: await react(backend('M'), 'post', randomUUID()),
      MdelS: await react(backend('M'), 'message', msg.delS),
      MhallCmessage: await react(backend('M'), 'message', msg.hallC),
      MinScomment: await react(backend('M'), 'comment', msg.inS),
    };
    await say(msg.chS, ws.K, 'B', { scope: 'cohort', cohort: space.S, context: 'community_challenge_comment' });
    try {
      got.MchSmessage = await react(backend('M'), 'message', msg.chS);
      got.MchScomment = await react(backend('M'), 'comment', msg.chS);
    } finally {
      await su(`DELETE FROM "community_messages" WHERE "id" = $1::uuid`, msg.chS);
    }
    expect(got).toEqual({ MinS: 1, MhallCcomment: 1, MrandomMessage: DENIED, MrandomPost: DENIED, MdelS: DENIED, MhallCmessage: DENIED,
      MinScomment: DENIED, MchSmessage: 1, MchScomment: DENIED });
  });

  it('W10: types no one writes: event and challenge, on a random id and on inS\'s id, refused', async () => {
    expect({
      MinS: await react(backend('M'), 'message', msg.inS),
      eventRandom: await react(backend('M'), 'event', randomUUID()),
      challengeRandom: await react(backend('M'), 'challenge', randomUUID()),
      eventInS: await react(backend('M'), 'event', msg.inS),
      challengeInS: await react(backend('M'), 'challenge', msg.inS),
    }).toEqual({ MinS: 1, eventRandom: DENIED, challengeRandom: DENIED, eventInS: DENIED, challengeInS: DENIED });
  });

  it('W11: the reactor is the caller: K inserting a row under A\'s name on inS refused; A\'s own written', async () => {
    expect({
      AinS: await react(backend('A'), 'message', msg.inS),
      KasA: await react(backend('K'), 'message', msg.inS, { user: 'A' }),
    }).toEqual({ AinS: 1, KasA: DENIED });
  });

  it('W12: the Data API model (A\'s token, no app setting) and anon insert nothing, as at the base', async () => {
    expect({
      backendA: await react(backend('A'), 'message', msg.inS),
      dataApiA: await react(dataApi('A'), 'message', msg.inS),
      anon: await react('anon', 'message', msg.inS),
    }).toEqual({ backendA: 1, dataApiA: DENIED, anon: DENIED });
  });

  it('W13: the coach of a community with no space that is not public reacts on its Hall post, as the API lets him; C refused', async () => {
    let got: Record<string, number | string> = {};
    await su(`UPDATE "community_cohorts" SET "visibility" = 'public' WHERE "id" = $1::uuid`, space.W2);
    try {
      await write(post.pW2, ws.L, 'L', null);
      got = { LpW2: await react(backend('L'), 'post', post.pW2, { ws: ws.L }), CpW2: await react(backend('C'), 'post', post.pW2, { ws: ws.L }) };
    } finally {
      await su(`DELETE FROM "community_posts" WHERE "id" = $1::uuid`, post.pW2);
      await su(`UPDATE "community_cohorts" SET "visibility" = 'members' WHERE "id" = $1::uuid`, space.W2);
    }
    expect(got).toEqual({ LpW2: 1, CpW2: DENIED });
  });

  it('W14: the platform owner O (role owner, an active helper row in S only): O on inS written; O on inS2 recorded', async () => {
    let got: Record<string, number | string> = {};
    await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role") VALUES ($1, $2, $3, 'class user', 'owner'::"Role")`,
      id.O, sub.O, `dmrw-${id.O}`);
    try {
      await su(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'assistant'::"CommunityMembershipRole", now())`, randomUUID(), ws.K, space.S, id.O);
      got = { OinS: await react(backend('O'), 'message', msg.inS), OinS2: await react(backend('O'), 'message', msg.inS2) };
    } finally {
      await su(`DELETE FROM "community_memberships" WHERE "user_id" = $1`, id.O);
      await su(`DELETE FROM "User" WHERE "id" = $1`, id.O);
    }
    console.log(`DM-REACTION-WRITE-RLS-BE W14 ${JSON.stringify(got)}`);
    expect(got.OinS).toBe(1);
  });

  it('U1: the coach updates rS\'s kind, as today (test/fix-1245r1-dm-responses-class.spec.ts:304-313)', async () => {
    expect(await dryRun(backend('K'), UPDATE_SET(`"response_kind" = 'dmrw-edit'`), resp.rS)).toBe(1);
  });

  it('U2: the coach moves rS (A\'s) to a random id, to inS2 (where A is not), to dCL (another community) and onto dAB: refused', async () => {
    expect({
      response_kind: await dryRun(backend('K'), UPDATE_SET(`"response_kind" = 'dmrw-edit'`), resp.rS), // control
      random: await dryRun(backend('K'), UPDATE_SET(`"target_id" = $2::uuid`), resp.rS, randomUUID()),
      inS2: await dryRun(backend('K'), UPDATE_SET(`"target_id" = $2::uuid`), resp.rS, msg.inS2),
      dCL: await dryRun(backend('K'), UPDATE_SET(`"target_id" = $2::uuid`), resp.rS, msg.dCL),
      dAB: await dryRun(backend('K'), UPDATE_SET(`"target_id" = $2::uuid`), resp.rS, msg.dAB),
    }).toEqual({ response_kind: 1, random: DENIED, inS2: DENIED, dCL: DENIED, dAB: DENIED });
  });

  it('U3: A updates A\'s own rS: no permissive UPDATE policy lets a member in, 0 rows as at the base', async () => {
    expect(await dryRun(backend('A'), UPDATE_SET(`"response_kind" = 'dmrw-edit'`), resp.rS)).toBe(0);
  });

  it('U4: the upsert forms as A on inS: ON CONFLICT DO NOTHING twice then DO UPDATE; DO UPDATE alone; the repository\'s own Prisma upsert recorded', async () => {
    const kind = `dmrw-${(kinds += 1)}`;
    const upsert = (tail: string): [string, ...unknown[]] => [
      `INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "user_id", "response_kind")
       VALUES (gen_random_uuid(), $1::uuid, 'message', $2::uuid, $3, $4)
       ON CONFLICT ("target_type", "target_id", "user_id", "response_kind") ${tail}`, ws.K, msg.inS, id.A, kind];
    const nothing = upsert('DO NOTHING');
    const update = upsert(`DO UPDATE SET "response_kind" = EXCLUDED."response_kind"`);
    const forms = {
      nothingTwiceThenUpdate: await steps(backend('A'), [nothing, nothing, update]),
      updateAlone: await steps(backend('A'), [update]),
      refusedTarget: await steps(backend('N'), [[nothing[0], ws.K, msg.inS, id.N, kind]]),
    };
    // What src/community/reactions/community-reactions.repository.ts:26-44 sends, read from Prisma's own query log.
    const logged = new PrismaClient({ datasources: { db: { url: db.url } }, log: [{ emit: 'event', level: 'query' }] }) as unknown as PrismaClient;
    const sent: string[] = [];
    (logged as unknown as { $on: (event: 'query', cb: (q: { query: string }) => void) => void }).$on('query', (q) => {
      if (q.query.includes('community_responses')) sent.push(q.query.replace(/\s+/g, ' '));
    });
    const outcome: Array<string> = [];
    try {
      await logged.$transaction(async (tx: Prisma.TransactionClient) => {
        await enter(tx, backend('A'));
        for (let i = 0; i < 2; i += 1) {
          try {
            const row = await tx.communityResponse.upsert({
              where: { target_type_target_id_user_id_response_kind: { target_type: 'message', target_id: msg.inS, user_id: id.A, response_kind: kind } },
              create: { workspace_id: ws.K, target_type: 'message', target_id: msg.inS, target_created_at: null, user_id: id.A, response_kind: kind },
              update: {},
            });
            outcome.push(row.user_id === id.A ? 'row' : 'other');
          } catch (e) {
            const err = e as { code?: string; message?: string };
            outcome.push(`error ${err.code ?? ''} ${/\b42501\b|row-level security/.test(err.message ?? '') ? '42501' : ''}`.trim());
            throw e;
          }
        }
        throw new Error(ROLLBACK);
      }).catch(() => undefined);
    } finally {
      await logged.$disconnect();
    }
    console.log(`DM-REACTION-WRITE-RLS-BE U4 ${JSON.stringify({ forms, prismaUpsert: { outcome, sent } })}`);
    expect(forms).toEqual({ nothingTwiceThenUpdate: [1, 0, DENIED], updateAlone: [1], refusedTarget: [DENIED] });
    expect(outcome.length).toBeGreaterThan(0);
  });

  it('U5 (recorded): the coach sets rS\'s user_id to M (M may react on inS; the API never changes user_id)', async () => {
    // A fresh kind too: M's own rM is (message, inS, M, 'like'), so a bare move would hit the unique key (23505).
    const got = await dryRun(backend('K'), UPDATE_SET(`"user_id" = $2, "response_kind" = 'dmrw-u5'`), resp.rS, id.M);
    console.log(`DM-REACTION-WRITE-RLS-BE U5 ${JSON.stringify({ KsetsRsUserToM: got })}`);
    expect([1, DENIED]).toContain(got);
  });

  it('D1: deletes as today: own rows by their reactor (a banned or blocked one included), the coach on rS, not on another pair\'s rAB', async () => {
    const own: Record<string, number | string> = { BrAB: await dryRun(backend('B'), DELETE, resp.rAB) };
    await ban('M');
    try {
      own.MbannedRmById = await dryRun(backend('M'), DELETE, resp.rM); // a WHERE reads the row: the SELECT policies apply
      own.MbannedOwnRows = await dryRun(backend('M'), `DELETE FROM "community_responses"`); // no column read: own_delete alone
    } finally {
      await lift('M');
    }
    await block('A', 'B');
    try {
      own.AblockedRS = await dryRun(backend('A'), DELETE, resp.rS);
    } finally {
      await unblock('A', 'B');
    }
    own.KrS = await dryRun(backend('K'), DELETE, resp.rS);
    own.KrAB = await dryRun(backend('K'), DELETE, resp.rAB);
    expect(own).toEqual({ BrAB: 1, MbannedRmById: 0, MbannedOwnRows: 1, AblockedRS: 1, KrS: 1, KrAB: 0 });
  });

  it('R1: reads unchanged: every reaction by K, L, A, B, M, N and C as at e24409bc, and with a ban and a block set; the Data API and anon read none', async () => {
    expect(await matrix()).toEqual(pinned(READS));
    const none = Object.fromEntries(REACTIONS.flatMap((r) => [[`${r}:dataApiA`, 0], [`${r}:dataApiK`, 0], [`${r}:anon`, DENIED]]));
    expect(await outsiders()).toEqual(none);
    let banned: Matrix = {};
    await ban('B');
    await block('A', 'M');
    try {
      banned = await matrix();
    } finally {
      await unblock('A', 'M');
      await lift('B');
    }
    expect(banned).toEqual(pinned(READS_BANNED));
    expect(await matrix()).toEqual(pinned(READS));
  });

  describe('the round trip: HEAD, then down.sql as the superuser (BASE), then migration.sql (HEAD again)', () => {
    type Policy = { name: string; permissive: string; cmd: string; roles: string; qual: string | null; check: string | null };
    const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
    const policies = () => prisma.$queryRaw<Policy[]>`
      SELECT p."tablename" || '.' || p."policyname" AS "name", p."permissive", p."cmd", p."roles"::text AS "roles",
             p."qual", p."with_check" AS "check"
      FROM pg_policies p WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[]) ORDER BY 1`
      .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })));
    const NEW = [INSERT_POLICY, UPDATE_POLICY].map((p) => p.name);
    const others = (list: Policy[]) => list.filter((p) => !NEW.includes(p.name));
    type Fn = { definer: boolean; volatile: string; config: string[]; owner: string; authed: boolean; service: boolean; anon: boolean; pub: boolean };
    const fnInfo = () => prisma.$queryRawUnsafe<Fn[]>(
      `SELECT p."prosecdef" AS "definer", p."provolatile"::text AS "volatile", p."proconfig" AS "config",
              pg_get_userbyid(p."proowner")::text AS "owner",
              has_function_privilege('authenticated', p."oid", 'EXECUTE') AS "authed",
              has_function_privilege('service_role', p."oid", 'EXECUTE') AS "service",
              has_function_privilege('anon', p."oid", 'EXECUTE') AS "anon",
              EXISTS (SELECT 1 FROM aclexplode(p."proacl") a WHERE a."grantee" = 0) AS "pub"
       FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
       WHERE n."nspname" = 'app' AND p."proname" = 'community_response_target_open'`);
    const state = async () => {
      const plain = await matrix();
      await ban('B');
      await block('A', 'M');
      let banned: Matrix = {};
      try {
        banned = await matrix();
      } finally {
        await unblock('A', 'M');
        await lift('B');
      }
      return {
        policies: await policies(), fn: await fnInfo(), plain, banned, outsiders: await outsiders(),
        writes: { MdAB: await react(backend('M'), 'message', msg.dAB), KasA: await react(backend('K'), 'message', msg.inS, { user: 'A' }),
          KmovesRsToRandom: await dryRun(backend('K'), UPDATE_SET(`"target_id" = $2::uuid`), resp.rS, randomUUID()) },
      };
    };
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
      console.log(`DM-REACTION-WRITE-RLS-BE round trip ${JSON.stringify({ head: at.head.writes, base: at.base.writes, again: at.again.writes })}`);
    });

    it('F1: the chain prints both policies RESTRICTIVE, INSERT and UPDATE, no USING, WITH CHECK pinned; down.sql drops both; migration.sql brings both back', () => {
      const pick = (list: Policy[], name: string) => list.find((p) => p.name === name);
      for (const s of [at.head!, at.again!]) {
        expect(pick(s.policies, INSERT_POLICY.name)).toEqual(INSERT_POLICY);
        expect(pick(s.policies, UPDATE_POLICY.name)).toEqual(UPDATE_POLICY);
      }
      expect(at.base!.policies.filter((p) => NEW.includes(p.name))).toEqual([]);
      expect(others(at.base!.policies)).toEqual(others(at.head!.policies));
      expect(at.again!.policies).toEqual(at.head!.policies);
    });

    it('F1: at BASE the writes the fix refuses go in again (W1\'s M on dAB, W11, U2\'s random id); HEAD again refuses them', () => {
      const refused = { MdAB: DENIED, KasA: DENIED, KmovesRsToRandom: DENIED };
      expect(at.head!.writes).toEqual(refused);
      expect(at.base!.writes).toEqual({ MdAB: 1, KasA: 1, KmovesRsToRandom: 1 });
      expect(at.again!.writes).toEqual(refused);
    });

    it('R1 (round trip): every read cell at HEAD equals BASE and HEAD again, plain and with a ban and a block set', () => {
      for (const s of [at.head!, at.base!, at.again!]) {
        expect(s.plain).toEqual(pinned(READS));
        expect(s.banned).toEqual(pinned(READS_BANNED));
        expect(s.outsiders).toEqual(at.head!.outsiders);
      }
    });

    it('F2: the function is SECURITY DEFINER, owned by postgres, search_path pinned, run by authenticated and service_role, not anon or PUBLIC; gone after down.sql, back after migration.sql', () => {
      const want: Fn = { definer: true, volatile: 's', config: ['search_path=pg_catalog, public'], owner: 'postgres',
        authed: true, service: true, anon: false, pub: false };
      expect(at.head!.fn).toEqual([want]);
      expect(at.base!.fn).toEqual([]);
      expect(at.again!.fn).toEqual([want]);
    });
  });
});
