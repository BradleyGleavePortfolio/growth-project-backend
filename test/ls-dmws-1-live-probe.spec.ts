/**
 * LS-DMWS-1 lens probe (never merge): attack-first probes on the DM routes' community id at the reviewed head of
 * b#1259 (DM-WS-ID-BE). Tries to split one thread into two, to reach another community's DM, to name a person by
 * another spelling of their id, and to use one Idempotency-Key under two spellings. Disposable postgres:15.
 */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import type { PrismaClient, User } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';
import { CommunityAccessService } from '../src/community/community-access.service';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { CommunityDmsService } from '../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../src/community/dms/community-dms.repository';
import { keyedSendId } from '../src/community/messages/message-idempotency';

jest.setTimeout(600_000);
const stub = <T>(v: unknown): T => v as T;

describe('LS-DMWS-1 live probe: the DM routes and the community id as typed', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  let dms: CommunityDmsService;
  const pushes: Array<{ recipientId: string; deepLink?: string; workspaceId?: string }> = [];
  const pings: Array<{ cohortId?: string }> = [];
  const K1 = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const K2 = randomUUID();
  const C = randomUUID();
  const w1 = randomUUID();
  const w2 = randomUUID();
  const s1 = randomUUID();
  const s2 = randomUUID();
  const su = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const person = (id: string, role: 'student' | 'coach', coach: string | null) => stub<User>({ id, role, coach_id: coach });
  const a = person(A, 'student', K1);
  const b = person(B, 'student', K1);
  const c = person(C, 'student', K2);
  const k1 = person(K1, 'coach', null);
  const k2 = person(K2, 'coach', null);
  const pairKey = (ws: string, x: string, y: string) => `${ws}:${[x, y].sort().join(':')}`;
  const SPELL: Record<string, (id: string) => string> = {
    canonical: (id) => id,
    upper: (id) => id.toUpperCase(),
    simple: (id) => id.replace(/-/g, ''),
    braced: (id) => `{${id}}`,
    urn: (id) => `urn:uuid:${id}`,
  };
  const outcome = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
      return 'ok';
    } catch (e) {
      if (e instanceof HttpException) {
        const body = e.getResponse();
        const code = typeof body === 'object' && body !== null ? (body as { code?: string }).code ?? '' : '';
        return `${e.getStatus()} ${code}`;
      }
      return `error ${(e as Error).name}`;
    }
  };
  const pairRows = (ws: string, x: string, y: string) =>
    prisma.communityMessage.findMany({
      where: {
        workspace_id: ws,
        scope: 'dm',
        OR: [
          { sender_id: x, recipient_user_id: y },
          { sender_id: y, recipient_user_id: x },
        ],
      },
    });

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    const user = (id: string, role: string, coach: string | null) =>
      su(
        `INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'probe person', $4::"Role", $5)`,
        id,
        randomUUID(),
        `lsdmws1-${id}`,
        role,
        coach,
      );
    await user(K1, 'coach', null);
    await user(K2, 'coach', null);
    await user(A, 'student', K1);
    await user(B, 'student', K1);
    await user(C, 'student', K2);
    for (const [ws, coach, space] of [[w1, K1, s1], [w2, K2, s2]] as const) {
      await su(
        `INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'probe workspace', $3, now())`,
        ws,
        coach,
        `lsdmws1-${ws.slice(0, 8)}`,
      );
      await su(
        `INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at") VALUES ($1::uuid, $2::uuid, 'probe space', 'members'::"CommunitySpaceVisibility", now())`,
        space,
        ws,
      );
    }
    for (const [ws, space, who] of [[w1, s1, A], [w1, s1, B], [w2, s2, C]] as const) {
      await su(
        `INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
        randomUUID(),
        ws,
        space,
        who,
      );
    }
    const realtime = {
      channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
      cohortShard: () => 0,
      broadcastCommunityEvent: async (_to: unknown, _event: unknown, payload: { cohortId?: string }) => {
        pings.push(payload);
      },
    };
    const push = {
      pushEnabled: () => true,
      sendCommunityPush: async (q: { recipientId: string; deepLink?: string; workspaceId?: string }) => {
        pushes.push(q);
      },
    };
    dms = new CommunityDmsService(
      new CommunityAccessService(db.db),
      new CommunityDmsRepository(db.db),
      stub(realtime),
      stub(push),
      new CommunitySafetyService(db.db),
    );
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('1. control and more spellings than the five: every send lands in the one stored thread', async () => {
    const key = pairKey(w1, A, B);
    const mixed = w1.split('').map((ch, i) => (i % 2 ? ch.toUpperCase() : ch)).join('');
    const spellings: Record<string, string> = {
      canonical: w1,
      upper: w1.toUpperCase(),
      simple: w1.replace(/-/g, ''),
      braced: `{${w1}}`,
      urn: `urn:uuid:${w1}`,
      mixed,
      upperSimple: w1.replace(/-/g, '').toUpperCase(),
      upperBraced: `{${w1.toUpperCase()}}`,
      upperUrn: `urn:uuid:${w1.toUpperCase()}`,
    };
    const got: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    for (const [label, spelled] of Object.entries(spellings)) {
      const pushesBefore = pushes.length;
      const pingsBefore = pings.length;
      const words = `Probe one ${label}`;
      const opened = await dms.openThread(a, spelled, B);
      const sent = await dms.send(a, spelled, B, words);
      const row = await prisma.communityMessage.findFirst({ where: { body: words } });
      const read = await dms.listThread(b, spelled, A, { limit: '100' });
      const list = await dms.listThreads(a, spelled, {});
      got[label] = {
        open: [opened.thread.thread_id, opened.thread.workspace_id],
        answer: sent.message.thread_id,
        row: [row?.dm_key, row?.workspace_id],
        push: pushes.slice(pushesBefore).map((q) => [q.recipientId, q.deepLink, q.workspaceId]),
        ping: pings.slice(pingsBefore).map((q) => q.cohortId),
        read: read.messages.some((m) => m.id === sent.message.id),
        readKeys: [...new Set(read.messages.map((m) => m.thread_id))],
        list: list.threads.map((t) => [t.thread_id, t.workspace_id, t.other_user_id]),
      };
      want[label] = {
        open: [key, w1],
        answer: key,
        row: [key, w1],
        push: [[B, `tgp://community/dm/${A}?workspace=${w1}`, w1]],
        ping: [key],
        read: true,
        readKeys: [key],
        list: [[key, w1, B]],
      };
    }
    expect(got).toEqual(want);
    const rows = await pairRows(w1, A, B);
    expect(rows.length).toBe(Object.keys(spellings).length);
    expect([...new Set(rows.map((r) => r.dm_key))]).toEqual([key]);
  });

  it('2. odd spellings: each is refused and writes nothing, or lands in the one stored thread', async () => {
    const key = pairKey(w1, A, B);
    const odd: Record<string, string> = {
      groupsOfFour: w1.replace(/-/g, '').replace(/(.{4})(?=.)/g, '$1-'),
      upperUrnPrefix: `URN:UUID:${w1}`,
      leadingSpace: ` ${w1}`,
      openBraceOnly: `{${w1}`,
      empty: '',
      notAnId: 'not-an-id',
    };
    const got: Record<string, string> = {};
    for (const [label, spelled] of Object.entries(odd)) {
      const words = `Probe two ${label}`;
      const sent = await outcome(() => dms.send(a, spelled, B, words));
      got[label] = [
        sent,
        await outcome(() => dms.openThread(a, spelled, B)),
        await outcome(() => dms.listThread(a, spelled, B, {})),
        await outcome(() => dms.listThreads(a, spelled, {})),
      ].join(' | ');
      const rows = await prisma.communityMessage.findMany({ where: { body: words } });
      expect(rows.map((r) => [r.dm_key, r.workspace_id])).toEqual(sent === 'ok' ? [[key, w1]] : []);
    }
    // Printed for the AUDIT: how each one is answered (the same lookup runs first on main).
    // eslint-disable-next-line no-console
    console.log(`LSDMWS1-PROBE-2 ${JSON.stringify(got)}`);
    expect([...new Set((await pairRows(w1, A, B)).map((r) => r.dm_key))]).toEqual([key]);
  });

  it('3. a person named by another spelling of their id is nobody: no second thread', async () => {
    const before = await prisma.communityMessage.count();
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    const refused = Array(3).fill('404 community.dm.not_found').join(' | ');
    for (const [label, spell] of Object.entries(SPELL)) {
      if (label === 'canonical') continue;
      const cases: Array<[string, User, string]> = [
        [`member to member ${label}`, a, spell(B)],
        [`member to coach ${label}`, a, spell(K1)],
        [`coach to client ${label}`, k1, spell(A)],
        [`oneself ${label}`, a, spell(A)],
      ];
      for (const [name, from, to] of cases) {
        got[name] = [
          await outcome(() => dms.openThread(from, w1, to)),
          await outcome(() => dms.send(from, w1, to, 'Probe three')),
          await outcome(() => dms.listThread(from, w1, to, {})),
        ].join(' | ');
        want[name] = refused;
      }
    }
    expect(got).toEqual(want);
    expect(await prisma.communityMessage.count()).toBe(before);
  });

  it('4. another community under any spelling stays closed, both ways', async () => {
    const before = await prisma.communityMessage.count();
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    const refused = (n: number) => Array(n).fill('404 community.dm.not_found').join(' | ');
    for (const [label, spell] of Object.entries(SPELL)) {
      got[`into w2 ${label}`] = [
        await outcome(() => dms.openThread(a, spell(w2), C)),
        await outcome(() => dms.send(a, spell(w2), C, 'Probe four')),
        await outcome(() => dms.listThread(a, spell(w2), C, {})),
        await outcome(() => dms.listThreads(a, spell(w2), {})),
        await outcome(() => dms.send(a, spell(w2), B, 'Probe four')),
        await outcome(() => dms.listThread(a, spell(w2), B, {})),
        await outcome(() => dms.openThread(k1, spell(w2), C)),
        await outcome(() => dms.listThreads(k1, spell(w2), {})),
        await outcome(() => dms.listThread(k1, spell(w2), A, {})),
      ].join(' | ');
      want[`into w2 ${label}`] = refused(9);
      got[`into w1 ${label}`] = [
        await outcome(() => dms.send(c, spell(w1), A, 'Probe four')),
        await outcome(() => dms.listThread(c, spell(w1), A, {})),
        await outcome(() => dms.listThreads(c, spell(w1), {})),
        await outcome(() => dms.openThread(k2, spell(w1), A)),
        await outcome(() => dms.listThread(k2, spell(w1), A, {})),
        await outcome(() => dms.listThreads(k2, spell(w1), {})),
      ].join(' | ');
      want[`into w1 ${label}`] = refused(6);
    }
    expect(got).toEqual(want);
    expect(await prisma.communityMessage.count()).toBe(before);
    expect(await prisma.communityMessage.count({ where: { workspace_id: w2 } })).toBe(0);
  });

  it('5. one Idempotency-Key under several spellings is one message, with the id main gives the stored spelling', async () => {
    const sendOnce = randomUUID();
    const words = 'Probe five once';
    const pushesBefore = pushes.length;
    const ids: string[] = [];
    for (const label of ['upper', 'braced', 'canonical', 'urn', 'simple']) {
      ids.push((await dms.send(a, SPELL[label](w1), B, words, sendOnce)).message.id);
    }
    expect([...new Set(ids)]).toEqual([keyedSendId('dm', A, pairKey(w1, A, B), sendOnce)]);
    expect(await prisma.communityMessage.count({ where: { body: words } })).toBe(1);
    expect(pushes.length - pushesBefore).toBe(1);
    // The same key on other words, under yet another spelling, is the same key: refused.
    expect(await outcome(() => dms.send(a, `{${w1.toUpperCase()}}`, B, 'Probe five other words', sendOnce))).toBe(
      '409 community.message.idempotency_key_reused',
    );
    expect(await prisma.communityMessage.count({ where: { body: 'Probe five other words' } })).toBe(0);
  });

  it('6. a row left under a typed key by a hand-built send before the fix: listed apart, never read into the thread', async () => {
    const key = pairKey(w1, A, B);
    const typedKey = pairKey(w1.toUpperCase(), A, B);
    const left = randomUUID();
    await prisma.communityMessage.create({
      data: {
        id: left, workspace_id: w1, scope: 'dm', kind: 'text', dm_key: typedKey,
        sender_id: A, recipient_user_id: B, body: 'Probe six left behind', visibility: 'active',
      },
    });
    const got: Record<string, unknown> = {};
    for (const label of ['canonical', 'upper']) {
      const read = await dms.listThread(b, SPELL[label](w1), A, { limit: '100' });
      const list = await dms.listThreads(b, SPELL[label](w1), {});
      got[label] = {
        readHasLeft: read.messages.some((m) => m.id === left),
        listKeys: list.threads.map((t) => [t.thread_id, t.other_user_id]).sort(),
      };
    }
    const both = [[key, A], [typedKey, A]].sort();
    expect(got).toEqual({
      canonical: { readHasLeft: false, listKeys: both },
      upper: { readHasLeft: false, listKeys: both },
    });
  });
});
