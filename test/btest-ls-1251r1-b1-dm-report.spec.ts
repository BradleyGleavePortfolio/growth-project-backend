/**
 * B-TEST LS-1251R1 B1 (b#1251 @ 09a99e06): the report of a DM message is a DM path the class list missed. Coach K
 * and a former client X keep their thread (203-D12): open, read, send, react and acknowledge answer 200, but a report
 * of a message in that thread answers 404 community.moderation.not_found both ways
 * (src/community/moderation/community-moderation.service.ts resolveReportTarget: the place test canAccessWorkspace
 * refuses X, the author test authorStays refuses K), where the same report by K and a current client A is filed.
 * Disposable postgres:15 from test/ls-1197-live-fixture.ts; the services run on the app's own connection.
 */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';
import { CommunityAccessService } from '../src/community/community-access.service';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { CommunityDmsService } from '../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../src/community/dms/community-dms.repository';
import { CommunityMessagesRepository } from '../src/community/messages/community-messages.repository';
import { CommunityPostsRepository } from '../src/community/posts/community-posts.repository';
import { CommunityModerationService } from '../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../src/community/moderation/community-moderation.repository';

jest.setTimeout(600_000);

type Key = 'K' | 'L' | 'A' | 'X' | 'T';
const PEOPLE: Key[] = ['K', 'L', 'A', 'X', 'T'];
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', A: 'student', X: 'student', T: 'student' };
const stub = <T>(v: unknown): T => v as T;

describe('B-TEST LS-1251R1 B1: a report inside the kept thread', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  let dms: CommunityDmsService;
  let moderation: CommunityModerationService;
  const id = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = randomUUID();
  const space = randomUUID();
  // d<from><to>: the DM `from` wrote to `to`.
  const msg = { dXK: randomUUID(), dKX: randomUUID(), dAK: randomUUID(), dKA: randomUUID(), dTK: randomUUID() };
  const u = (k: Key) => stub<User>({ id: id[k], role: ROLE[k] });
  const su = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const say = (m: string, from: Key, to: Key) =>
    su(`INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'See you at the session', now())`, m, ws, CommunityDmsRepository.dmKey(ws, id[from], id[to]), id[to], id[from]);
  /** '200', or the status and code the call is refused with. */
  const outcome = (q: Promise<unknown>) => q.then(() => '200', (e: unknown) => {
    if (!(e instanceof HttpException)) throw e;
    return `${e.getStatus()} ${(e.getResponse() as { code?: string }).code}`;
  });
  const report = (who: Key, m: string) => outcome(moderation.report(u(who), 'message', m, 'spam', undefined));

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of PEOPLE) {
      await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'class user', $4::"Role", $5)`,
        id[k], randomUUID(), `btest-${id[k]}`, ROLE[k], ROLE[k] === 'student' ? id.K : null);
    }
    await su(`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'class workspace', $3, now())`, ws, id.K, `btest-${run}`);
    await su(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at") VALUES ($1::uuid, $2::uuid, 'class space', 'members'::"CommunitySpaceVisibility", now())`, space, ws);
    for (const k of ['A', 'X'] as const) {
      await su(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`, randomUUID(), ws, space, id[k]);
    }
    await say(msg.dXK, 'X', 'K');
    await say(msg.dKX, 'K', 'X');
    await say(msg.dAK, 'A', 'K');
    await say(msg.dKA, 'K', 'A');
    await say(msg.dTK, 'T', 'K');
    // X and T move to coach L. X keeps an active row in K's community and a thread: the 203-D12 pair. T holds no row.
    for (const k of ['X', 'T'] as const) await su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id.L, id[k]);
    const access = new CommunityAccessService(db.db);
    const safety = new CommunitySafetyService(db.db);
    const quiet = { channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' }, cohortShard: () => 0, broadcastCommunityEvent: async () => undefined };
    const push = { pushEnabled: () => true, sendCommunityPush: async () => undefined };
    dms = new CommunityDmsService(access, new CommunityDmsRepository(db.db), stub(quiet), stub(push), safety);
    moderation = new CommunityModerationService(access, new CommunityModerationRepository(db.db), new CommunityMessagesRepository(db.db), new CommunityPostsRepository(db.db),
      stub(quiet), stub(push), db.db, stub({}));
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('control: the thread is open both ways for K and X, and for K and a current client A; closed for T (no row)', async () => {
    expect({
      KX: await outcome(dms.openThread(u('K'), ws, id.X)), XK: await outcome(dms.openThread(u('X'), ws, id.K)),
      KA: await outcome(dms.openThread(u('K'), ws, id.A)), AK: await outcome(dms.openThread(u('A'), ws, id.K)),
      KT: await outcome(dms.openThread(u('K'), ws, id.T)),
    }).toEqual({ KX: '200', XK: '200', KA: '200', AK: '200', KT: '404 community.dm.not_found' });
  });

  it('control: K and a current client A report each other\'s DM message; a closed pair (T, no row) stays refused', async () => {
    expect({ KonA: await report('K', msg.dAK), AonK: await report('A', msg.dKA), KonT: await report('K', msg.dTK) })
      .toEqual({ KonA: '200', AonK: '200', KonT: '404 community.moderation.not_found' });
  });

  it('B1: K and the former client X report each other\'s message in their kept thread, as K and a current client do', async () => {
    expect({ KonX: await report('K', msg.dXK), XonK: await report('X', msg.dKX) }).toEqual({ KonX: '200', XonK: '200' });
  });
});
