/**
 * LS-1253R1 lens probe (never merge): b#1253's three outputs on Postgres, with the real app.community_dm_former_client
 * and app.community_can_access. GET /community/me former_coach_dms, the coach's own DM list names, and the list's
 * former-client arm, for a former client, a banned one, a removed one, one with no thread, another coach's client,
 * a current client and both coaches. Disposable postgres:15 from test/ls-1197-live-fixture.ts.
 */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';
import { CommunityAccessService } from '../src/community/community-access.service';
import { CommunityRepository } from '../src/community/community.repository';
import { CommunityService } from '../src/community/community.service';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { CommunityDmsService } from '../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../src/community/dms/community-dms.repository';

jest.setTimeout(600_000);

type Key = 'K' | 'L' | 'K2' | 'A' | 'X' | 'V' | 'Z' | 'T' | 'Y';
const PEOPLE: Key[] = ['K', 'L', 'K2', 'A', 'X', 'V', 'Z', 'T', 'Y'];
const COACHES: Key[] = ['K', 'L', 'K2'];
const stub = <T>(v: unknown): T => v as T;
const SWITCHES = ['FEATURE_COMMUNITY_DM', 'FEATURE_COMMUNITY_API'] as const;

describe('LS-1253R1 live probe: /me former_coach_dms and the coach list names on Postgres', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  let access: CommunityAccessService;
  let safety: CommunitySafetyService;
  let dms: CommunityDmsService;
  let me: CommunityService;
  const saved: Record<string, string | undefined> = {};
  const id = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = randomUUID();
  const space = randomUUID();
  const ws3 = randomUUID();
  const space3 = randomUUID();
  const su = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const person = (k: Key) =>
    prisma.user.findUniqueOrThrow({ where: { id: id[k] } }) as Promise<User>;
  const say = (from: Key, to: Key, w = ws) =>
    su(
      `INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'See you at the session', now())`,
      randomUUID(),
      w,
      CommunityDmsRepository.dmKey(w, id[from], id[to]),
      id[to],
      id[from],
    );
  const join = (k: Key, w = ws, s = space) =>
    su(
      `INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
      randomUUID(),
      w,
      s,
      id[k],
    );
  /** The caller's GET W/dms rows as [other person, other_display_name], or the status and code it is refused with. */
  const list = async (k: Key, w = ws): Promise<Array<[string, unknown]> | string> => {
    try {
      return (await dms.listThreads(await person(k), w, {})).threads.map((t) => [
        t.other_user_id,
        stub<Record<string, unknown>>(t).other_display_name,
      ]);
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return `${e.getStatus()} ${(e.getResponse() as { code?: string }).code}`;
    }
  };
  const former = async (k: Key) =>
    stub<Record<string, unknown>>(await me.getMe(await person(k))).former_coach_dms;
  const NOT_FOUND = '404 community.dm.not_found';
  const KEPT = [{ workspace_id: ws, coach_user_id: id.K }];

  beforeAll(async () => {
    for (const s of SWITCHES) {
      saved[s] = process.env[s];
      process.env[s] = 'true';
    }
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of PEOPLE) {
      const coach = COACHES.includes(k);
      await su(
        `INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, $4, $5::"Role", $6)`,
        id[k],
        randomUUID(),
        `ls1253r1-${id[k]}`,
        `  Person ${k}  `,
        coach ? 'coach' : 'student',
        coach ? null : k === 'Y' ? id.L : id.K,
      );
    }
    await su(
      `INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'probe workspace', $3, now())`,
      ws,
      id.K,
      `ls1253r1-${run}`,
    );
    await su(
      `INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at") VALUES ($1::uuid, $2::uuid, 'probe space', 'members'::"CommunitySpaceVisibility", now())`,
      space,
      ws,
    );
    await su(
      `INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'probe workspace three', $3, now())`,
      ws3,
      id.K2,
      `ls1253r1-3-${run}`,
    );
    await su(
      `INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at") VALUES ($1::uuid, $2::uuid, 'probe space three', 'members'::"CommunitySpaceVisibility", now())`,
      space3,
      ws3,
    );
    for (const k of ['A', 'X', 'V', 'Z', 'T'] as const) await join(k);
    for (const k of ['A', 'X', 'V', 'Z'] as const) {
      await say(k, 'K');
      await say('K', k);
    }
    // X, V, Z and T move to coach L; V is then banned from K's community and Z's row is removed. T has no thread.
    for (const k of ['X', 'V', 'Z', 'T'] as const)
      await su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id.L, id[k]);
    await su(
      `INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id") VALUES ($1::uuid, $2::uuid, $3)`,
      randomUUID(),
      ws,
      id.V,
    );
    await su(
      `UPDATE "community_memberships" SET "status" = 'removed', "removed_at" = now() WHERE "workspace_id" = $1::uuid AND "user_id" = $2`,
      ws,
      id.Z,
    );
    access = new CommunityAccessService(db.db);
    safety = new CommunitySafetyService(db.db);
    const realtime = {
      channels: {
        cohort: () => 'cohort',
        workspace: () => 'workspace',
        user: () => 'user',
        moderation: () => 'moderation',
      },
      cohortShard: () => 0,
      broadcastCommunityEvent: async () => undefined,
    };
    const push = { pushEnabled: () => true, sendCommunityPush: async () => undefined };
    dms = new CommunityDmsService(
      access,
      new CommunityDmsRepository(db.db),
      stub(realtime),
      stub(push),
      safety,
    );
    me = new CommunityService(db.db, new CommunityRepository(db.db), safety, access);
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
    for (const s of SWITCHES) {
      if (saved[s] === undefined) delete process.env[s];
      else process.env[s] = saved[s];
    }
  });

  it("1. X, the former client: /me names W and K, its own community is coach L's, and its W list is K's thread with no name", async () => {
    const mine = await me.getMe(await person('X'));
    expect(stub<Record<string, unknown>>(mine).former_coach_dms).toEqual(KEPT);
    expect(mine.workspace_id).not.toBeNull();
    expect(mine.workspace_id).not.toBe(ws);
    expect(await access.membershipInWorkspace(ws, id.X)).toBeNull();
    expect(await list('X')).toEqual([[id.K, null]]);
  });

  it('2. nobody else is told W: the banned V, the removed Z, T with no thread, Y of another coach, the current client A, coaches K, L and K2', async () => {
    const got: Record<string, unknown> = {};
    for (const k of ['V', 'Z', 'T', 'Y', 'A', 'K', 'L', 'K2'] as const) got[k] = await former(k);
    expect(got).toEqual({ V: [], Z: [], T: [], Y: [], A: [], K: [], L: [], K2: [] });
    expect({
      V: await list('V'),
      Z: await list('Z'),
      T: await list('T'),
      Y: await list('Y'),
      L: await list('L'),
    }).toEqual({ V: NOT_FOUND, Z: NOT_FOUND, T: NOT_FOUND, Y: NOT_FOUND, L: NOT_FOUND });
  });

  it("3. K's own list names its rows (trimmed): the current client A and the former client X only; A's list carries no name", async () => {
    const rows = await list('K');
    expect(Array.isArray(rows)).toBe(true);
    expect([...(rows as Array<[string, unknown]>)].sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual(
      (
        [
          [id.A, 'Person A'],
          [id.X, 'Person X'],
        ] as Array<[string, unknown]>
      ).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
    expect(await list('A')).toEqual([[id.K, null]]);
  });

  it("4. a block either way: W leaves X's /me and both lists; lifted: back", async () => {
    for (const [a, b] of [
      ['X', 'K'],
      ['K', 'X'],
    ] as Array<[Key, Key]>) {
      await prisma.userBlock.create({ data: { blocker_id: id[a], blocked_id: id[b] } });
      try {
        expect([
          a,
          await former('X'),
          await list('X'),
          ((await list('K')) as Array<[string, unknown]>).map((r) => r[0]).includes(id.X),
        ]).toEqual([a, [], [], false]);
      } finally {
        await prisma.userBlock.deleteMany({ where: { blocker_id: id[a], blocked_id: id[b] } });
      }
      expect([a, await former('X')]).toEqual([a, KEPT]);
    }
  });

  it("5. a ban of X, then lifted; X's row removed, then restored: /me follows the list", async () => {
    const banId = randomUUID();
    await su(
      `INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id") VALUES ($1::uuid, $2::uuid, $3)`,
      banId,
      ws,
      id.X,
    );
    try {
      expect([await former('X'), await list('X')]).toEqual([[], NOT_FOUND]);
    } finally {
      await su(`DELETE FROM "community_workspace_bans" WHERE "id" = $1::uuid`, banId);
    }
    await su(
      `UPDATE "community_memberships" SET "status" = 'removed' WHERE "workspace_id" = $1::uuid AND "user_id" = $2`,
      ws,
      id.X,
    );
    try {
      expect([await former('X'), await list('X')]).toEqual([[], NOT_FOUND]);
    } finally {
      await su(
        `UPDATE "community_memberships" SET "status" = 'active' WHERE "workspace_id" = $1::uuid AND "user_id" = $2`,
        ws,
        id.X,
      );
    }
    expect([await former('X'), await list('X')]).toEqual([KEPT, [[id.K, null]]]);
  });

  it('6. FEATURE_COMMUNITY_DM unset: []', async () => {
    delete process.env.FEATURE_COMMUNITY_DM;
    try {
      expect(await former('X')).toEqual([]);
    } finally {
      process.env.FEATURE_COMMUNITY_DM = 'true';
    }
  });

  it("7. X back on K's roster: the member arm, W is X's own community and is not listed", async () => {
    await su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id.K, id.X);
    try {
      expect(await former('X')).toEqual([]);
      expect(await access.membershipInWorkspace(ws, id.X)).not.toBeNull();
    } finally {
      await su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id.L, id.X);
    }
  });

  it('8. X with a second kept thread, with K2 in W3: both, sorted by workspace_id; with no coach at all: the same list', async () => {
    await join('X', ws3, space3);
    await say('X', 'K2', ws3);
    const want = [...KEPT, { workspace_id: ws3, coach_user_id: id.K2 }].sort((a, b) =>
      a.workspace_id < b.workspace_id ? -1 : 1,
    );
    expect(await former('X')).toEqual(want);
    await su(`UPDATE "User" SET "coach_id" = NULL WHERE "id" = $1`, id.X);
    try {
      expect(await former('X')).toEqual(want);
    } finally {
      await su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id.L, id.X);
    }
  });
});
