/**
 * C6-BVIS: one rule decides who reads or writes a community space,
 * app.community_can_access(space, person) (migration 20270502002400). Row
 * security and the server ask the same function.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Row reads
 * and writes run as role authenticated (no BYPASSRLS) with the backend identity
 * (app.current_user_id/_role and the JWT sub); the server paths run the real
 * access service and repositories on the same database.
 * Coach X owns four spaces, one per visibility; Y is another coach with one
 * space. I is X's client in every scope (joined the public space, a member of
 * the members space, holds X's package); O is X's client with nothing else; E
 * is X's client whose package ended; M was X's client in every scope and moves
 * to Y; N has no coach and joined X's public space; Z is Y's client. Every 0
 * or refusal follows a read of 1 by the same person.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-space-access-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'O' | 'E' | 'M' | 'N' | 'Z';
type Space = 'pub' | 'cli' | 'pkg' | 'mem';
type AnySpace = Space | 'ymem';
const PEOPLE: Key[] = ['X', 'Y', 'I', 'O', 'E', 'M', 'N', 'Z']; // coaches first: clients reference them
const SPACES: Space[] = ['pub', 'cli', 'pkg', 'mem'];
const COACH: Record<Key, Key | null> = { X: null, Y: null, I: 'X', O: 'X', E: 'X', M: 'X', N: null, Z: 'Y' };
const ROLE = (k: Key) => (k === 'X' || k === 'Y' ? 'coach' : 'student');
const VISIBILITY: Record<Space, string> = { pub: 'public', cli: 'clients', pkg: 'package', mem: 'members' };
// Who passes the rule in each of X's spaces once M has moved to Y.
const OPEN: Record<Space, Key[]> = {
  pub: ['X', 'I', 'M', 'N'], // the coach and whoever joined; M keeps it after the move
  cli: ['X', 'I', 'O', 'E'], // X's clients today
  pkg: ['X', 'I'], // X's clients holding a live purchase of a linked package
  mem: ['X', 'I'], // X's clients with an active row
};
// The space each person reads (1) before any 0 in their row.
const CONTROL: Record<Key, AnySpace> = { X: 'mem', Y: 'ymem', I: 'mem', O: 'cli', E: 'cli', M: 'pub', N: 'pub', Z: 'ymem' };
const DENIED = '42501';
const COMMENT = 'community_post_comment';
const EDIT_OWN = `UPDATE "community_messages" SET "body" = "body"`;

(DB_URL ? describe : describe.skip)('one rule decides who reads or writes a community space', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const access = new CommunityAccessService(stub<PrismaService>(prisma));
  const foundation = new CommunityRepository(stub<PrismaService>(prisma));
  const messages = new CommunityMessagesRepository(stub<PrismaService>(prisma));
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const ALL: AnySpace[] = [...SPACES, 'ymem'];
  const id = uuids(PEOPLE);
  const sub = uuids(PEOPLE);
  const ws = uuids(['X', 'Y'] as const);
  const space = uuids(ALL);
  const msg = uuids(ALL);
  const post = uuids(ALL);
  const comment = uuids(ALL);
  const row = uuids(['Imem', 'Mmem', 'Npub'] as const);
  const hall = randomUUID();
  const run = randomUUID().slice(0, 8);
  const pkg = `pkg-${run}`;
  const wsOf = (s: AnySpace) => (s === 'ymem' ? ws.Y : ws.X);
  const cohort = (s: AnySpace) => ({ id: space[s], workspace_id: wsOf(s) });
  const user = (k: Key) => ({ id: id[k], role: ROLE(k) });

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const count = (k: Key, table: string, rowId: string) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id" = $1::uuid`, rowId))
      .then((r) => r[0].n);
  // Rows written, or the SQLSTATE of the refusal.
  const write = async (k: Key, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      return await as(k, (tx) => tx.$executeRawUnsafe(sql, ...params));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const MESSAGE = `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "sender_id", "body", "plan_context_type", "plan_context_id", "updated_at")
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'cohort', $4, 'RLS message', $5::varchar, $6::uuid, now())`;
  const send = (k: Key, s: AnySpace) => write(k, MESSAGE, randomUUID(), wsOf(s), space[s], id[k], null, null);
  const reply = (k: Key, s: AnySpace) => write(k, MESSAGE, randomUUID(), wsOf(s), space[s], id[k], COMMENT, post[s]);
  const rule = (k: Key, s: AnySpace) =>
    as(k, (tx) => tx.$queryRaw<{ ok: boolean }[]>`SELECT app.community_can_access(${space[s]}::uuid, ${id[k]}) AS "ok"`).then((r) => r[0].ok);
  const moveM = (to: Key) => prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id[to]} WHERE "id" = ${id.M}`;
  const purchase = (k: Key, expires: string | null) => prisma.$executeRawUnsafe(
    `INSERT INTO "ClientPurchase" ("id", "client_user_id", "coach_user_id", "package_id", "amount_cents", "stripe_checkout_session_id",
       "idempotency_key", "status", "entitlement_active", "access_expires_at", "updated_at")
     VALUES ($1, $2, $3, $4, 1000, $1, $1, 'active', true, ${expires ?? 'NULL'}, now())`, `cp-${run}-${k}`, id[k], id.X, pkg);

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`space-access-${id[k]}`}, 'RLS person', ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as Key] : null})`;
    }
    for (const c of ['X', 'Y'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`space-access-${run}-${c}`}, now())`;
    }
    for (const s of ALL) {
      const by = s === 'ymem' ? id.Y : id.X;
      await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "updated_at")
        VALUES (${space[s]}::uuid, ${wsOf(s)}::uuid, ${`RLS ${s}`}, now())`;
      await prisma.$executeRawUnsafe(MESSAGE, msg[s], wsOf(s), space[s], by, null, null);
      await prisma.$executeRaw`INSERT INTO "community_posts" ("id", "workspace_id", "cohort_id", "author_id", "scope", "updated_at")
        VALUES (${post[s]}::uuid, ${wsOf(s)}::uuid, ${space[s]}::uuid, ${by}, 'cohort', now())`;
      await prisma.$executeRawUnsafe(MESSAGE, comment[s], wsOf(s), space[s], by, COMMENT, post[s]);
    }
    await prisma.$executeRaw`INSERT INTO "community_posts" ("id", "workspace_id", "author_id", "scope", "updated_at")
      VALUES (${hall}::uuid, ${ws.X}::uuid, ${id.X}, 'hall', now())`;
    const rows: [string, Key, AnySpace][] = [[row.Imem, 'I', 'mem'], [randomUUID(), 'I', 'pub'], [row.Mmem, 'M', 'mem'],
      [randomUUID(), 'M', 'pub'], [row.Npub, 'N', 'pub'], [randomUUID(), 'Z', 'ymem']];
    for (const [rowId, k, s] of rows) {
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES (${rowId}::uuid, ${wsOf(s)}::uuid, ${space[s]}::uuid, ${id[k]}, 'student', 'active', now())`;
    }
    await prisma.$executeRaw`INSERT INTO "CoachPackage" ("id", "coach_id", "name", "amount_cents", "updated_at")
      VALUES (${pkg}, ${id.X}, 'RLS package', 1000, now())`;
    await purchase('I', null);
    await purchase('M', `(now() AT TIME ZONE 'UTC') + interval '30 days'`);
    await purchase('E', `(now() AT TIME ZONE 'UTC') - interval '1 day'`);
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  describe('the spaces that exist today (chosen members)', () => {
    it('a client who moves loses the old coach\'s spaces at once; the old coach and the members lose their row', async () => {
      expect(await count('M', 'community_messages', msg.mem)).toBe(1);
      expect(await count('X', 'community_memberships', row.Mmem)).toBe(1);
      expect(await count('I', 'community_memberships', row.Mmem)).toBe(1);
      expect(await access.canAccessCohort(cohort('mem'), user('M'))).toBe(true);
      expect([await send('M', 'mem'), await write('M', EDIT_OWN)]).toEqual([1, 1]); // edits their own message
      await moveM('Y');
      expect(await write('M', EDIT_OWN)).toBe(0); // no filter, so only the update rule decides
      expect(await count('M', 'community_messages', msg.mem)).toBe(0);
      expect(await count('M', 'community_messages', comment.mem)).toBe(0);
      expect(await count('M', 'community_posts', post.mem)).toBe(0);
      expect(await send('M', 'mem')).toBe(DENIED);
      expect(await count('X', 'community_memberships', row.Mmem)).toBe(0);
      expect(await count('I', 'community_memberships', row.Mmem)).toBe(0);
      expect(await count('M', 'community_memberships', row.Mmem)).toBe(1); // their own row stays theirs
      expect(await access.canAccessCohort(cohort('mem'), user('M'))).toBe(false);
      expect(await access.membershipInWorkspace(ws.X, id.M)).toBeNull();
      expect(await foundation.findActiveMembershipForUser(id.M)).toBeNull(); // /me no longer lands in X's community
      expect(await foundation.cohortMemberCount(space.mem)).toBe(1);
      const push = await messages.listCohortPushRecipients({ workspaceId: ws.X, cohortId: space.mem, senderId: id.X });
      expect(push.map((r) => r.user_id)).toEqual([id.I]);
      expect(await count('I', 'community_messages', msg.mem)).toBe(1); // the client who stayed keeps everything
      expect(await send('I', 'mem')).toBe(1);
      expect(await count('I', 'community_memberships', row.Imem)).toBe(1);
    });
  });

  describe('every visibility', () => {
    beforeAll(async () => {
      for (const s of ['pub', 'cli', 'pkg'] as const) {
        await prisma.$executeRawUnsafe(`UPDATE "community_cohorts" SET "visibility" = $1::"CommunitySpaceVisibility" WHERE "id" = $2::uuid`,
          VISIBILITY[s], space[s]);
      }
      await prisma.$executeRaw`INSERT INTO "community_cohort_packages" ("cohort_id", "package_id") VALUES (${space.pkg}::uuid, ${pkg})`;
    });

    it('a space is a chosen-members space unless the coach says otherwise', async () => {
      const [r] = await prisma.$queryRaw<{ v: string }[]>`SELECT "visibility"::text AS "v" FROM "community_cohorts" WHERE "id" = ${space.mem}::uuid`;
      expect(r.v).toBe(VISIBILITY.mem);
    });

    it.each(PEOPLE)('%s reads and writes exactly the spaces the rule opens, at the row layer and in the server', async (k) => {
      expect(await count(k, 'community_messages', msg[CONTROL[k]])).toBe(1);
      for (const s of SPACES) {
        const open = OPEN[s].includes(k);
        const n = open ? 1 : 0;
        expect([s, await rule(k, s), await access.canAccessCohort(cohort(s), user(k))]).toEqual([s, open, open]);
        expect([s, await count(k, 'community_messages', msg[s]), await count(k, 'community_messages', comment[s])]).toEqual([s, n, n]);
        expect([s, await count(k, 'community_posts', post[s])]).toEqual([s, n]);
        expect([s, await send(k, s), await reply(k, s)]).toEqual(open ? [s, 1, 1] : [s, DENIED, DENIED]);
      }
      // Membership rows: read by the people who may read that space (and by their owner).
      expect(await count(k, 'community_memberships', row.Imem)).toBe(OPEN.mem.includes(k) ? 1 : 0);
      expect(await count(k, 'community_memberships', row.Npub)).toBe(OPEN.pub.includes(k) ? 1 : 0);
      // Workspace-wide surfaces (the Hall, DMs, workspace lists) open with a space that is not public.
      const circle = (['cli', 'pkg', 'mem'] as const).some((s) => OPEN[s].includes(k));
      expect(await count(k, 'community_posts', hall)).toBe(circle ? 1 : 0);
      expect(await access.canAccessWorkspace(ws.X, user(k))).toBe(circle);
      const mine = SPACES.filter((s) => OPEN[s].includes(k)).map((s) => space[s]).sort();
      expect((await access.listAccessibleCohortIds(ws.X, id[k])).sort()).toEqual(mine);
      const listed = await foundation.findCohortsForUser({ userId: id[k], role: ROLE(k) as 'student' | 'coach' });
      expect(listed.filter((c) => c.workspace_id === ws.X).map((c) => c.id).sort()).toEqual(mine);
    });

    it('access ends the moment the rule turns false (a package ends, a public member is removed, a ban); the team always', async () => {
      expect(await count('I', 'community_messages', msg.pkg)).toBe(1);
      await prisma.$executeRaw`UPDATE "ClientPurchase" SET "access_expires_at" = (now() AT TIME ZONE 'UTC') - interval '1 minute'
        WHERE "client_user_id" = ${id.I}`;
      expect(await count('I', 'community_messages', msg.pkg)).toBe(0);
      expect(await count('I', 'community_messages', msg.cli)).toBe(1);
      expect(await count('N', 'community_messages', msg.pub)).toBe(1);
      await prisma.$executeRaw`UPDATE "community_memberships" SET "status" = 'removed' WHERE "id" = ${row.Npub}::uuid`;
      expect(await count('N', 'community_messages', msg.pub)).toBe(0);
      expect(await send('N', 'pub')).toBe(DENIED);
      expect(await count('O', 'community_messages', msg.cli)).toBe(1);
      await prisma.$executeRaw`INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id") VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${id.O})`;
      expect(await count('O', 'community_messages', msg.cli)).toBe(0);
      expect(await access.canAccessCohort(cohort('cli'), user('O'))).toBe(false);
      expect(await count('X', 'community_messages', msg.cli)).toBe(1); // the coach always
      // The coach's team: a co-coach row opens the space whoever coaches them.
      expect(await count('Y', 'community_messages', msg.ymem)).toBe(1);
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${space.mem}::uuid, ${id.Y}, 'assistant', 'active', now())`;
      expect([await count('Y', 'community_messages', msg.mem), await send('Y', 'mem')]).toEqual([1, 1]);
    });
  });
});
