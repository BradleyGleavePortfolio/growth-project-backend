/**
 * B-TEST LS-1245R1 B1 (lens, never merge): the 01:0x operator ruling puts the DM responses policies inside the class
 * b#1245 must close ("every row policy that lets a coach, or any member, read direct-message content between two other
 * people ... and the DM responses policy"). At 6ab82b1a community_responses_coach_all and _member_select are unchanged,
 * so the community's coach and a third member still read a reaction on a DM between two other people.
 * Runs on a disposable Postgres carrying the whole chain (role authenticated, app.current_user_id set). Fails at the head.
 */
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';

jest.setTimeout(900_000);

type Key = 'K' | 'A' | 'B' | 'D';
const ROLE: Record<Key, string> = { K: 'coach', A: 'student', B: 'student', D: 'student' };

describe('B-TEST LS-1245R1 B1: a reaction on a DM between two other people reads for nobody else', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  const keys: Key[] = ['K', 'A', 'B', 'D'];
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const ws = randomUUID(); const space = randomUUID(); const dAB = randomUUID(); const rAB = randomUUID();

  const reads = (who: Key, table: string, rowId: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE authenticated`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who]);
      return tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id" = $1::uuid`, rowId);
    }).then((r) => r[0].n);

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of keys) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`btest-${id[k]}`}, 'btest user', ${ROLE[k]}::"Role", ${k === 'K' ? null : id.K})`;
    }
    await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
      VALUES (${ws}::uuid, ${id.K}, 'btest workspace', ${`btest-${ws.slice(0, 8)}`}, now())`;
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "updated_at")
      VALUES (${space}::uuid, ${ws}::uuid, 'btest members space', now())`;
    for (const k of ['A', 'B', 'D'] as Key[]) {
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ws}::uuid, ${space}::uuid, ${id[k]}, now())`;
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
       VALUES ($1::uuid, $2::uuid, NULL, 'dm', $3, $4, $5, 'btest words of A to B', now())`,
      dAB, ws, `dm-${[id.A, id.B].sort().join('-')}`, id.B, id.A);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "target_created_at", "user_id", "response_kind")
       VALUES ($1::uuid, $2::uuid, 'message', $3::uuid, now(), $4, 'heart')`, rAB, ws, dAB, id.A);
  });
  afterAll(async () => { await db?.stop(); });

  it('controls: the DM reads for its two people only; the reaction reads for both of them', async () => {
    expect(await reads('A', 'community_messages', dAB)).toBe(1);
    expect(await reads('B', 'community_messages', dAB)).toBe(1);
    expect(await reads('K', 'community_messages', dAB)).toBe(0);
    expect(await reads('D', 'community_messages', dAB)).toBe(0);
    expect(await reads('A', 'community_responses', rAB)).toBe(1);
    expect(await reads('B', 'community_responses', rAB)).toBe(1);
  });

  it("the community's coach reads no reaction on a DM between two of his clients (community_responses_coach_all)", async () => {
    expect(await reads('K', 'community_responses', rAB)).toBe(0);
  });

  it('a third member of the community reads no reaction on a DM between two other people (community_responses_member_select)', async () => {
    expect(await reads('D', 'community_responses', rAB)).toBe(0);
  });
});
