/**
 * FIX-1245R1 (b#1245, DM-SELECT-RLS fix round 1), the class spec for the DM responses policies: at the row layer a
 * reaction on a community DM reads only for that DM's sender and its recipient (each still needing today's coach or
 * member arm), and every other reaction reads for exactly who read it before, every target type included.
 * community_responses_coach_all (FOR ALL) and community_responses_member_select each AND
 * app.community_response_dm_party("target_type", "target_id"), a SECURITY DEFINER function, so the reader's own row
 * security on community_messages (another space, a banned author) never hides a reaction that reads today.
 *
 * Disposable postgres:15 from test/ls-1197-live-fixture.ts (the whole chain by prisma migrate deploy). Principals as
 * test/rls/community-dm-select-rls.spec.ts :51-52, :73-87 (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app setting (the Supabase Data API model)
 * Coach K owns W with members spaces S and S2; A, B and M are K's clients in S; N is K's client in S2 only; coach L
 * owns W2 with client C in its space. Messages: dAB (A to B), dKA (K to A), inS (B, in S), hallC (B, a Hall comment
 * row, cohort_id NULL), dCL (C to L, in W2). Reactions: rAB (B on dAB), rKA (A on dKA), rS (A on inS), rHall (A on
 * hallC, target_type 'comment'), rP (A, 'post', an id with no row), rGone (A, 'message', an id with no row), rCL (C
 * on dCL). Every 0 follows a 1 on the same row. Writes are rolled back. The round trip applies down.sql as the
 * superuser (BASE) and migration.sql again (HEAD again).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';

jest.setTimeout(600_000);

const DIR = join(__dirname, '..', 'prisma', 'migrations', '20270502011400_community_dm_select_parties_only');
// A migration file's statements; BEGIN/COMMIT become the one transaction apply() opens.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
const FN = `app.community_response_dm_party("CommunityResponseTargetType", uuid)`;

type Key = 'K' | 'L' | 'A' | 'B' | 'M' | 'N' | 'C';
const READERS: Key[] = ['K', 'L', 'A', 'B', 'M', 'N', 'C']; // coaches first: clients reference them
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', A: 'student', B: 'student', M: 'student', N: 'student', C: 'student' };
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const DENIED = '42501';
const ROLLBACK = 'fix-1245r1: rolled back on purpose';
const sqlState = (e: unknown) => {
  const err = e as { code?: string; meta?: { code?: string } };
  return String(err.code === 'P2010' ? err.meta?.code : err.code);
};

const REACTIONS = ['rAB', 'rKA', 'rS', 'rHall', 'rP', 'rGone', 'rCL'] as const;
type R = (typeof REACTIONS)[number];
// Who reads each reaction with the fix in, one digit per reader in READERS order (K L A B M N C).
const AT_HEAD: Record<R, string> = {
  rAB: '0011000', // the DM's two people, A and B
  rKA: '1010000', // the coach's own DM: K and A
  rS: '1011110', // a space row: the coach and every member of W, N (not in S) included, as today
  rHall: '1011110', // a Hall comment row: as today
  rP: '1011110', // a post: as today
  rGone: '1011110', // a message id with no row: as today
  rCL: '0100001', // W2's DM: L and C
};
// The only cells the fix changes; each read 1 at the base.
const DM_CELLS = ['rAB:K', 'rAB:M', 'rAB:N', 'rKA:B', 'rKA:M', 'rKA:N'];
type Matrix = Record<string, number | string>;
const expected = (base: boolean): Matrix => Object.fromEntries(REACTIONS.flatMap((r) =>
  READERS.map((k, i): [string, number] => {
    const cell = `${r}:${k}`;
    return [cell, base && DM_CELLS.includes(cell) ? 1 : Number(AT_HEAD[r][i])];
  })));
const only = (m: Matrix, cells: string[]) => Object.fromEntries(cells.map((c) => [c, m[c]]));
const without = (m: Matrix, cells: string[]) => Object.fromEntries(Object.entries(m).filter(([c]) => !cells.includes(c)));
// The first reader who reads the reaction with the fix in (the control of a 0 on the same row).
const firstReader = (r: R) => READERS[AT_HEAD[r].indexOf('1')];

describe('FIX-1245R1: a DM\'s reactions read only for its two people; every other reaction reads as today', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  const id = Object.fromEntries(READERS.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(READERS.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = { K: randomUUID(), L: randomUUID() };
  const space = { S: randomUUID(), S2: randomUUID(), W2: randomUUID() };
  const msg = { dAB: randomUUID(), dKA: randomUUID(), inS: randomUUID(), hallC: randomUUID(), dCL: randomUUID() };
  const resp = Object.fromEntries(REACTIONS.map((r) => [r, randomUUID()])) as Record<R, string>;

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
  const reads = (who: Who | 'anon', r: R) =>
    count(who, `SELECT count(*)::int AS "n" FROM "community_responses" WHERE "id" = $1::uuid`, resp[r]);
  const readsMsg = (who: Who, m: keyof typeof msg) =>
    count(who, `SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id" = $1::uuid`, msg[m]);
  const row = async (r: R, who: Key[]) => {
    const out: Record<string, number | string> = {};
    for (const k of who) out[k] = await reads(backend(k), r);
    return out;
  };
  const matrix = async (): Promise<Matrix> => {
    const out: Matrix = {};
    for (const r of REACTIONS) for (const k of READERS) out[`${r}:${k}`] = await reads(backend(k), r);
    return out;
  };
  const byReaction = async (who: Who | 'anon') => {
    const out: Record<string, number | string> = {};
    for (const r of REACTIONS) out[r] = await reads(who, r);
    return out;
  };
  // A write run as `who`, then rolled back: the rows it touched (or the SQLSTATE of its refusal).
  const dryRun = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
    let n: number | string | undefined;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await enter(tx, who);
      try {
        n = await tx.$executeRawUnsafe(sql, ...params);
      } catch (e) {
        n = sqlState(e);
        throw e;
      }
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => {
      if (n === undefined) throw e;
    });
    return n as number | string;
  };
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  type Fn = { definer: boolean; volatile: string; config: string[]; owner: string; authed: boolean; service: boolean; anon: boolean; pub: boolean };
  const fnInfo = () => prisma.$queryRawUnsafe<Fn[]>(
    `SELECT p."prosecdef" AS "definer", p."provolatile"::text AS "volatile", p."proconfig" AS "config",
            pg_get_userbyid(p."proowner")::text AS "owner",
            has_function_privilege('authenticated', p."oid", 'EXECUTE') AS "authed",
            has_function_privilege('service_role', p."oid", 'EXECUTE') AS "service",
            has_function_privilege('anon', p."oid", 'EXECUTE') AS "anon",
            EXISTS (SELECT 1 FROM aclexplode(p."proacl") a WHERE a."grantee" = 0) AS "pub"
     FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
     WHERE n."nspname" = 'app' AND p."proname" = 'community_response_dm_party'
       AND p."oid" = to_regprocedure($1)`, FN);

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of READERS) {
      const coach = ['A', 'B', 'M', 'N'].includes(k) ? id.K : k === 'C' ? id.L : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`fix-1245r1-${id[k]}`}, 'class user', ${ROLE[k]}::"Role", ${coach})`;
    }
    for (const c of ['K', 'L'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'class workspace', ${`fix-1245r1-${run}-${c}`}, now())`;
    }
    for (const [cohort, w, name] of [[space.S, ws.K, 'class space S'], [space.S2, ws.K, 'class space S2'], [space.W2, ws.L, 'class space W2']]) {
      await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "updated_at")
        VALUES (${cohort}::uuid, ${w}::uuid, ${name}, now())`;
    }
    const members: [Key, string, string][] = [['A', space.S, ws.K], ['B', space.S, ws.K], ['M', space.S, ws.K], ['N', space.S2, ws.K], ['C', space.W2, ws.L]];
    for (const [k, cohort, w] of members) {
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at")
        VALUES (${randomUUID()}::uuid, ${w}::uuid, ${cohort}::uuid, ${id[k]}, now())`;
    }
    const say = (m: string, w: string, sender: Key, d: { scope: 'cohort' | 'dm'; to?: Key; cohort?: string; comment?: boolean }) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body",
           "plan_context_type", "plan_context_id", "updated_at")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"CommunityMessageScope", $5, $6, $7, $8, $9, $10::uuid, now())`,
        m, w, d.cohort ?? null, d.scope,
        d.scope === 'dm' ? `dm-${run}-${[id[sender], id[d.to!]].sort().join('-')}` : null,
        d.to ? id[d.to] : null, id[sender], `class words of ${sender}`,
        d.comment ? 'community_post_comment' : null, d.comment ? randomUUID() : null);
    await say(msg.dAB, ws.K, 'A', { scope: 'dm', to: 'B' });
    await say(msg.dKA, ws.K, 'K', { scope: 'dm', to: 'A' });
    await say(msg.inS, ws.K, 'B', { scope: 'cohort', cohort: space.S });
    await say(msg.hallC, ws.K, 'B', { scope: 'cohort', comment: true });
    await say(msg.dCL, ws.L, 'C', { scope: 'dm', to: 'L' });
    // A message or comment target carries its row's created_at, as the writer stores it (community-reactions.service.ts).
    const react = (r: R, w: string, who: Key, type: string, target: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "target_created_at", "user_id", "response_kind")
         VALUES ($1::uuid, $2::uuid, $3::"CommunityResponseTargetType", $4::uuid,
                 (SELECT m."created_at" FROM "community_messages" m WHERE m."id" = $4::uuid), $5, 'like')`,
        resp[r], w, type, target, id[who]);
    await react('rAB', ws.K, 'B', 'message', msg.dAB);
    await react('rKA', ws.K, 'A', 'message', msg.dKA);
    await react('rS', ws.K, 'A', 'message', msg.inS);
    await react('rHall', ws.K, 'A', 'comment', msg.hallC);
    await react('rP', ws.K, 'A', 'post', randomUUID());
    await react('rGone', ws.K, 'A', 'message', randomUUID());
    await react('rCL', ws.L, 'C', 'message', msg.dCL);
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('K'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('(a) a reaction on a DM reads for its two people only: rAB for A and B, rKA for K and A', async () => {
    expect(await row('rAB', ['A', 'B', 'K', 'M', 'N', 'L', 'C'])).toEqual({ A: 1, B: 1, K: 0, M: 0, N: 0, L: 0, C: 0 });
    expect(await row('rKA', ['K', 'A', 'B', 'M', 'N'])).toEqual({ K: 1, A: 1, B: 0, M: 0, N: 0 });
  });

  describe('the round trip: HEAD, then down.sql as the superuser (BASE), then migration.sql (HEAD again)', () => {
    const at: { head?: Matrix; base?: Matrix; again?: Matrix } = {};
    const anon: { head?: Record<string, number | string>; base?: Record<string, number | string> } = {};
    const dataK: { head?: Record<string, number | string>; base?: Record<string, number | string> } = {};
    const fn: { head?: Fn[]; base?: Fn[]; again?: Fn[] } = {};
    beforeAll(async () => {
      at.head = await matrix();
      anon.head = await byReaction('anon');
      dataK.head = await byReaction(dataApi('K'));
      fn.head = await fnInfo();
      await apply('down.sql');
      try {
        at.base = await matrix();
        anon.base = await byReaction('anon');
        dataK.base = await byReaction(dataApi('K'));
        fn.base = await fnInfo();
      } finally {
        await apply('migration.sql');
      }
      at.again = await matrix();
      fn.again = await fnInfo();
      console.log(`FIX-1245R1 matrix ${JSON.stringify(at)}`);
      console.log(`FIX-1245R1 anon ${JSON.stringify(anon)}`);
    });

    it('(b) BASE differs from HEAD in exactly six cells, rAB for K, M and N and rKA for B, M and N: 1 at BASE, 0 at HEAD', () => {
      const diff = Object.keys(at.head!).filter((c) => at.head![c] !== at.base![c]).sort();
      expect({ diff, head: only(at.head!, DM_CELLS), base: only(at.base!, DM_CELLS) })
        .toEqual({ diff: [...DM_CELLS].sort(), head: only(expected(false), DM_CELLS), base: only(expected(true), DM_CELLS) });
    });

    it('(b) every other cell reads at HEAD, BASE and HEAD again exactly as at the base (N on rS; rHall, rP, rGone for every reader)', () => {
      const want = without(expected(true), DM_CELLS);
      expect(want).toMatchObject({ 'rS:N': 1, 'rHall:A': 1, 'rP:M': 1, 'rGone:N': 1, 'rGone:L': 0 }); // the pins named in the text
      expect(without(at.head!, DM_CELLS)).toEqual(want);
      expect(without(at.base!, DM_CELLS)).toEqual(want);
      expect(without(at.again!, DM_CELLS)).toEqual(want);
    });

    it('(b) HEAD again equals HEAD', () => {
      expect(at.again).toEqual(at.head);
    });

    it('(e) the Data API model reads no reaction; anon reads none (0 or refused), at BASE and at HEAD', async () => {
      for (const r of REACTIONS) expect([r, await reads(backend(firstReader(r)), r)]).toEqual([r, 1]); // control
      const none = Object.fromEntries(REACTIONS.map((r) => [r, 0]));
      expect(dataK.head).toEqual(none);
      expect(dataK.base).toEqual(none);
      expect(await byReaction(dataApi('A'))).toEqual(none);
      for (const v of [...Object.values(anon.base!), ...Object.values(anon.head!)]) expect([0, DENIED]).toContain(v);
    });

    it('(f) the function is SECURITY DEFINER, owned by postgres, run by authenticated and service_role, not anon or PUBLIC; gone after down.sql, back after migration.sql', () => {
      const want: Fn = { definer: true, volatile: 's', config: ['search_path=pg_catalog, public'], owner: 'postgres',
        authed: true, service: true, anon: false, pub: false };
      expect(fn.head).toEqual([want]);
      expect(fn.base).toEqual([]);
      expect(fn.again).toEqual([want]);
    });
  });

  it('(c) a RESTRICTIVE message policy does not reach reactions: B banned in W hides inS from K, and K still reads rS', async () => {
    expect(await readsMsg(backend('K'), 'inS')).toBe(1); // control
    expect(await reads(backend('K'), 'rS')).toBe(1);
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.K, user_id: id.B, banned_by_id: id.K } });
    let banned: Record<string, number | string> = {};
    try {
      banned = { inS: await readsMsg(backend('K'), 'inS'), rS: await reads(backend('K'), 'rS') };
    } finally {
      await prisma.communityWorkspaceBan.updateMany({ where: { workspace_id: ws.K, user_id: id.B }, data: { lifted_at: new Date() } });
    }
    expect(banned).toEqual({ inS: 0, rS: 1 });
    expect(await readsMsg(backend('K'), 'inS')).toBe(1); // the ban lifted
  });

  it('(d) through coach_all the coach no longer deletes or updates a reaction on another pair\'s DM; its own author still deletes it', async () => {
    const del = `DELETE FROM "community_responses" WHERE "id" = $1::uuid`;
    const upd = `UPDATE "community_responses" SET "response_kind" = 'fix-1245r1-edit' WHERE "id" = $1::uuid`;
    expect({
      ownDelete: await dryRun(backend('B'), del, resp.rAB), // control: own_delete
      coachDelete: await dryRun(backend('K'), del, resp.rAB),
      coachUpdate: await dryRun(backend('K'), upd, resp.rAB),
    }).toEqual({ ownDelete: 1, coachDelete: 0, coachUpdate: 0 });
    expect(await reads(backend('B'), 'rAB')).toBe(1); // rolled back: rAB is as it was
  });

  it('(d) the coach\'s other writes through coach_all are as today: he deletes and updates rS, and inserts his own reaction on dKA', async () => {
    expect({
      coachDelete: await dryRun(backend('K'), `DELETE FROM "community_responses" WHERE "id" = $1::uuid`, resp.rS),
      coachUpdate: await dryRun(backend('K'), `UPDATE "community_responses" SET "response_kind" = 'fix-1245r1-edit' WHERE "id" = $1::uuid`, resp.rS),
      coachInsert: await dryRun(backend('K'),
        `INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "user_id", "response_kind")
         VALUES ($1::uuid, $2::uuid, 'message', $3::uuid, $4, 'like')`, randomUUID(), ws.K, msg.dKA, id.K),
    }).toEqual({ coachDelete: 1, coachUpdate: 1, coachInsert: 1 });
    expect(await reads(backend('A'), 'rS')).toBe(1); // rolled back: rS is as it was
  });
});
