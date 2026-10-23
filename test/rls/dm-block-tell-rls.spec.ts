// BLOCK-TELL (agent 169), owner #169-5 CLOSED-LINE: in a one-to-one DM the blocked person is told ("{N} has blocked
// you"), the thread stays listed for both people as a closed row, and nobody else learns. Live, on the replayed
// migration chain, with the real DM service: coach A; V and X are A's clients in A's clients space. The block row
// itself stays readable only by its owner under forced row security (control read of 1 before each 0).
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityDmsRepository } from '../../src/community/dms/community-dms.repository';
import { CommunityDmsService } from '../../src/community/dms/community-dms.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('dm-block-tell-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'V' | 'X';
const NAME: Record<Key, string> = { A: 'Avery Coach', V: 'Vera Member', X: 'Xavi Member' };

(DB_URL ? describe : describe.skip)('#169-5: a DM block tells the blocked person; the block row stays its owner\'s', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const safety = new CommunitySafetyService(db);
  const dms = new CommunityDmsService(new CommunityAccessService(db), new CommunityDmsRepository(db),
    stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined }),
    stub<CommunityNotificationsService>({ sendCommunityPush: async () => undefined }), safety);
  const id = { A: randomUUID(), V: randomUUID(), X: randomUUID() };
  const ws = randomUUID();
  const space = randomUUID();
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: k === 'A' ? 'coach' : 'student', coach_id: k === 'A' ? null : id.A });
  const rowWith = async (k: Key, other: Key) =>
    (await dms.listThreads(user(k), ws, {})).threads.find((t) => t.other_user_id === id[other]);
  // Reads and deletes on "UserBlock" as `who`, under forced row security (non-bypass role).
  const asUser = <T>(who: Key, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: randomUUID(), role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, who === 'A' ? 'coach' : 'student');
      return fn(tx);
    });
  const blocksSeenBy = (who: Key) =>
    asUser(who, async (tx) => (await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "UserBlock"
      WHERE "blocker_id" = ${id.X} AND "blocked_id" = ${id.V}`)[0].n);

  beforeAll(async () => {
    for (const k of ['A', 'V', 'X'] as Key[]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${randomUUID()}, ${`blocktell-${id[k]}`}, ${NAME[k]}, ${k === 'A' ? 'coach' : 'student'}::"Role", ${k === 'A' ? null : id.A})`;
    }
    await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "dm_enabled_default", "updated_at")
      VALUES (${ws}::uuid, ${id.A}, 'RLS workspace', ${`blocktell-${run}`}, true, now())`;
    await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
      VALUES ($1::uuid, $2::uuid, 'RLS space', 'clients'::"CommunitySpaceVisibility", 'active', now())`, space, ws);
    for (const k of ['V', 'X'] as Key[]) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws, space, id[k]);
    }
    await dms.send(user('V'), ws, id.X, 'hello');
  });
  afterAll(() => prisma.$disconnect());

  it('both people keep a closed row; the blocked person is told; unblock reopens', async () => {
    expect(await rowWith('V', 'X')).toMatchObject({ closed: false, blocked_by_me: false, other_display_name: 'Xavi Member' });
    await prisma.userBlock.create({ data: { blocker_id: id.X, blocked_id: id.V } }); // X blocked V
    expect(await rowWith('X', 'V')).toMatchObject({
      closed: true, blocked_by_me: true, last_message_at: null, other_display_name: 'Vera Member',
    });
    expect(await rowWith('V', 'X')).toMatchObject({
      closed: true, blocked_by_me: false, last_message_at: null, other_display_name: 'Xavi Member',
    });
    await expect(dms.send(user('V'), ws, id.X, 'again')).rejects.toMatchObject({
      status: 403, response: { error: 'forbidden', code: 'community.dm.blocked_by_them' },
    });
    await expect(dms.listThread(user('X'), ws, id.V, {})).rejects.toMatchObject({
      status: 403, response: { code: 'community.dm.blocked_by_you' },
    });
    await prisma.userBlock.deleteMany({ where: { blocker_id: id.X } });
    expect(await rowWith('V', 'X')).toMatchObject({ closed: false, last_message_at: expect.any(String) });
    await expect(dms.send(user('V'), ws, id.X, 'back')).resolves.toBeDefined();
  });

  it('under row security only the blocker reads the block row; the blocked person cannot delete it', async () => {
    await prisma.userBlock.create({ data: { blocker_id: id.X, blocked_id: id.V } });
    expect(await blocksSeenBy('X')).toBe(BigInt(1)); // control: the owner reads it
    expect(await blocksSeenBy('V')).toBe(BigInt(0)); // the blocked person does not
    expect(await blocksSeenBy('A')).toBe(BigInt(0)); // nor their coach
    // No row reaches the blocked person's delete (0 rows, or no delete right at all).
    const deleted = await asUser('V', (tx) => tx.$executeRaw`DELETE FROM "UserBlock" WHERE "blocker_id" = ${id.X}`)
      .catch((e: unknown) => (/permission denied/.test(String(e)) ? 0 : Promise.reject(e)));
    expect(deleted).toBe(0);
    expect(await prisma.userBlock.count({ where: { blocker_id: id.X, blocked_id: id.V } })).toBe(1);
    await prisma.userBlock.deleteMany({ where: { blocker_id: id.X } });
  });
});
