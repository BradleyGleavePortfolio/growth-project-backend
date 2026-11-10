/**
 * LO-1245R1 B1 B-TEST (lens, b#1245 @ 6ab82b1a): the operator's 01:0x class ruling puts "the DM responses
 * policy" inside this one migration: a reaction on a community DM reads only for the DM's sender and
 * recipient, and a reaction on a non-DM row reads as before. At the head community_responses_coach_all and
 * community_responses_member_select (20261212000000 :608-617) are unchanged, so the workspace coach and every
 * member read a reaction on a DM between two others. Expected red at 6ab82b1a (K and M read 1).
 * Disposable postgres:15 from test/ls-1197-live-fixture.ts; principals as test/rls/community-dm-select-rls.spec.ts :73-88.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';

type Key = 'K' | 'A' | 'B' | 'M';
const ROLE: Record<Key, string> = { K: 'coach', A: 'student', B: 'student', M: 'student' };

describe('LO-1245R1 B1: a reaction on a community DM reads only for the DM\'s two people', () => {
  let fx: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  const id = { K: randomUUID(), A: randomUUID(), B: randomUUID(), M: randomUUID() } as Record<Key, string>;
  const ws = randomUUID();
  const space = randomUUID();
  const msg = { dAB: randomUUID(), dKA: randomUUID(), inS: randomUUID() };
  const resp = { onDAB: randomUUID(), onDKA: randomUUID(), onInS: randomUUID() };

  const reads = (who: Key, responseId: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: id[who], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who]);
      const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS "n" FROM "community_responses" WHERE "id" = $1::uuid`, responseId);
      return row.n;
    });

  beforeAll(async () => {
    fx = await ls1197Database();
    prisma = fx.prisma;
    for (const k of ['K', 'A', 'B', 'M'] as Key[]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${randomUUID()}, ${`lo-1245r1-b1-${id[k]}`}, 'b1 user', ${ROLE[k]}::"Role", ${k === 'K' ? null : id.K})`;
    }
    await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
      VALUES (${ws}::uuid, ${id.K}, 'b1 workspace', ${`lo-1245r1-b1-${ws}`}, now())`;
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "updated_at")
      VALUES (${space}::uuid, ${ws}::uuid, 'b1 space', now())`;
    for (const k of ['A', 'B', 'M'] as Key[]) {
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ws}::uuid, ${space}::uuid, ${id[k]}, now())`;
    }
    const dm = (rowId: string, from: Key, to: Key) => prisma.$executeRawUnsafe(
      `INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'b1 words', now())`,
      rowId, ws, `dm-${[id[from], id[to]].sort().join('-')}`, id[to], id[from]);
    await dm(msg.dAB, 'A', 'B');
    await dm(msg.dKA, 'K', 'A');
    await prisma.$executeRawUnsafe(
      `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "sender_id", "body", "updated_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'cohort', $4, 'b1 space words', now())`, msg.inS, ws, space, id.B);
    const react = (rowId: string, who: Key, target: string) => prisma.$executeRawUnsafe(
      `INSERT INTO "community_responses" ("id", "workspace_id", "target_type", "target_id", "user_id", "response_kind")
       VALUES ($1::uuid, $2::uuid, 'message', $3::uuid, $4, 'like')`, rowId, ws, target, id[who]);
    await react(resp.onDAB, 'B', msg.dAB);
    await react(resp.onDKA, 'A', msg.dKA);
    await react(resp.onInS, 'A', msg.inS);
  }, 240_000);
  afterAll(async () => { await fx?.stop(); });

  it('the workspace coach and a third member read no reaction on a DM between two clients; both people do', async () => {
    expect(await reads('A', resp.onDAB)).toBe(1); // control: the DM's sender
    expect(await reads('B', resp.onDAB)).toBe(1); // control: the DM's recipient, who reacted
    expect(await reads('K', resp.onDAB)).toBe(0);
    expect(await reads('M', resp.onDAB)).toBe(0);
  });

  it('a reaction on the coach\'s own DM reads for him and his client, not for another member', async () => {
    expect(await reads('K', resp.onDKA)).toBe(1);
    expect(await reads('A', resp.onDKA)).toBe(1);
    expect(await reads('M', resp.onDKA)).toBe(0);
  });

  it('a reaction on a space row still reads for the coach and every member (control)', async () => {
    for (const k of ['K', 'A', 'B', 'M'] as Key[]) expect(await reads(k, resp.onInS)).toBe(1);
  });
});
