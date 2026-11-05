// VOICE-INBOX (owner "#167-4 VOICE-INBOX - op 1"): a client's voice note in the coach's own space is a row in that
// coach's community inbox, with the typed rows' rules. Live, on the replayed migration chain, through the real
// voice repository (the note and its chat message are written as the app writes them). A and B coach; O, X and Y
// are A's clients in A's space; A blocked X; Y is banned from A's workspace; W is B's client in B's space. Row reads
// run as role authenticated; each person's first read is their control read, so every 0 follows a 1.
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityCoachInboxRepository } from '../../src/community/inbox/community-coach-inbox.repository';
import { CommunityCoachInboxService } from '../../src/community/inbox/community-coach-inbox.service';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-coach-inbox-voice-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'X' | 'Y' | 'W';
const PEOPLE: Key[] = ['A', 'B', 'O', 'X', 'Y', 'W']; // coaches first: clients reference them
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', X: 'A', Y: 'A', W: 'B' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
const SPACE_OF: Record<Key, 'A' | 'B'> = { A: 'A', B: 'B', O: 'A', X: 'A', Y: 'A', W: 'B' };

(DB_URL ? describe : describe.skip)('VOICE-INBOX: a client\'s voice note is a row in their coach\'s inbox, and no one else\'s', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const notes = new CommunityVoiceRepository(db);
  const inbox = new CommunityCoachInboxService(new CommunityAccessService(db), new CommunityCoachInboxRepository(db));
  const id = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const ws = { A: randomUUID(), B: randomUUID() };
  const space = { A: randomUUID(), B: randomUUID() };
  const run = randomUUID().slice(0, 8);
  const row: Record<string, string> = {};
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const say = async (k: Key, durationMs: number, answersClients = false) => {
    const note = await notes.createVoiceNote({ workspaceId: ws[SPACE_OF[k]], cohortId: space[SPACE_OF[k]], conversationId: null,
      authorId: id[k], storageKey: `${id[k]}/1700000000000-${randomUUID().replace(/-/g, '').slice(0, 16)}.m4a`, durationMs,
      bytes: 1000, mimeType: 'audio/mp4', waveformPeaks: null, parent: null, answersClients });
    return note.row.id;
  };
  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const count = (k: Key, table: string, key: string) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id"::text = $1`, row[key]))
      .then((r) => r[0].n);
  const KEY = () => Object.fromEntries(Object.entries(row).map(([k, v]) => [v, k]));
  const rows = async (k: Key) => (await inbox.list(user(k), {})).items.map((i) => `${KEY()[i.id]} ${i.kind} ${i.preview}`).sort();

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`voice-inbox-${id[k]}`}, ${`RLS person ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`voice-inbox-${run}-${c}`}, now())`;
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, 'clients'::"CommunitySpaceVisibility", 'active', now())`, space[c], ws[c], `RLS space ${c}`);
    }
    for (const k of ['O', 'X', 'Y', 'W'] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[SPACE_OF[k]], space[SPACE_OF[k]], id[k]);
    }
    await prisma.userBlock.create({ data: { blocker_id: id.A, blocked_id: id.X } });
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.Y, banned_by_id: id.A } });
    const typed = await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.A, scope: 'cohort',
      sender_id: id.O, body: 'RLS typed question' } });
    row.mO = typed.id;
    row.vO = await say('O', 42_000);
    row.vX = await say('X', 5_000);
    row.vY = await say('Y', 5_000);
    row.vW = await say('W', 7_000);
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security, on tables that force it', async () => {
    expect(await as('O', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    const tables = ['community_messages', 'community_voice_notes'];
    const forced = await prisma.$queryRaw<{ t: string }[]>`SELECT c."relname" AS "t" FROM pg_class c JOIN pg_namespace n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relname" = ANY(${tables}) AND c."relrowsecurity" AND c."relforcerowsecurity"`;
    expect(forced.map((r) => r.t).sort()).toEqual([...tables].sort());
  });

  it('the coach sees their client\'s note as a "Voice note" row with its length; never a blocked or banned author\'s', async () => {
    expect(await rows('A')).toEqual(['mO text RLS typed question', 'vO voice Voice note']);
    const voice = (await inbox.list(user('A'), {})).items.find((i) => i.id === row.vO);
    expect(voice).toMatchObject({ type: 'message', cohort_id: space.A, author_user_id: id.O, voice: { note_id: row.vO, duration_ms: 42_000 } });
  });

  it('another coach never sees it: B\'s inbox holds only B\'s client (control read first)', async () => {
    expect(await rows('B')).toEqual(['vW voice Voice note']);
  });

  it('the row layer agrees: B and W read 1 of W\'s note, then 0 of O\'s; A reads O\'s note and its chat message', async () => {
    const seen: string[] = [];
    for (const [k, table, key] of [['B', 'community_voice_notes', 'vW'], ['B', 'community_voice_notes', 'vO'],
      ['B', 'community_messages', 'vO'], ['W', 'community_voice_notes', 'vW'], ['W', 'community_voice_notes', 'vO'],
      ['W', 'community_messages', 'vO'], ['A', 'community_voice_notes', 'vO'], ['A', 'community_messages', 'vO']] as const) {
      seen.push(`${k} ${table} ${key} ${await count(k, table, key)}`);
    }
    expect(seen).toEqual(['B community_voice_notes vW 1', 'B community_voice_notes vO 0', 'B community_messages vO 0',
      'W community_voice_notes vW 1', 'W community_voice_notes vO 0', 'W community_messages vO 0',
      'A community_voice_notes vO 1', 'A community_messages vO 1']);
  });

  it('a deleted note leaves the inbox', async () => {
    row.vO2 = await say('O', 3_000);
    expect(await rows('A')).toContain('vO2 voice Voice note');
    const gone = await notes.findById(row.vO2);
    await notes.softDeleteWithErasure({ id: row.vO2, storage_key: gone?.storage_key ?? '', author_id: gone?.author_id ?? '' }, 'author_delete');
    expect(await rows('A')).toEqual(['mO text RLS typed question', 'vO voice Voice note']);
  });

  it('the coach\'s own voice reply answers the space as a typed reply does, and is never a row itself', async () => {
    row.vA = await say('A', 9_000, true);
    expect(await rows('A')).toEqual([]);
    expect(await rows('B')).toEqual(['vW voice Voice note']);
  });
});

// VOICE-INBOX fix round (Sol B1-B3 on b#1134), with owner rule D (SPACE-OWNER-ALERTS): one rule for every inbox
// row, typed words, voice notes and posts. The authors authorsWhoLeft names (b#1141: moved away, banned, in a block
// either way with the coach) stay out. In a public space every row reaches the space owner and their team, whoever
// the poster's coach is, and also the poster's own current coach (a coachless poster: the owner's side only). Pages:
// each stream is asked one row past the page, an answered post never uses up a place, and a cursor (milliseconds)
// never hands back a row (microseconds). A, B, C and D coach; T is on A's team in P (an assistant membership). In
// A's clients space S: O and M (A's clients), X (A blocked X), V (V blocked A), Y (banned), L (ban lifted). In A's
// public space P: O and M (A's clients), N (no coach), W (B's client) and G (B's client, banned from A's
// community). B's space SB holds W. C's space SC holds K1, K2 and Z (banned). D, E and F each hold one stream only:
// typed (K3), voice (K4), posts (K5). Each 0 follows its control 1.
type K2 = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'T' | 'O' | 'M' | 'X' | 'V' | 'Y' | 'L' | 'N' | 'W' | 'G' | 'K1' | 'K2' | 'Z'
  | 'K3' | 'K4' | 'K5';
const COACHES: K2[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const CLIENT_OF: Partial<Record<K2, K2>> = { O: 'A', M: 'A', X: 'A', V: 'A', Y: 'A', L: 'A', W: 'B', G: 'B', K1: 'C', K2: 'C',
  Z: 'C', K3: 'D', K4: 'E', K5: 'F' };
const P_ROWS = (k: K2) => [`${k}.P.post`, `${k}.P.typed`, `${k}.P.voice`];

(DB_URL ? describe : describe.skip)('VOICE-INBOX rules: every row kind, public spaces and pages', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const notes = new CommunityVoiceRepository(db);
  const repo = new CommunityCoachInboxRepository(db);
  const inbox = new CommunityCoachInboxService(new CommunityAccessService(db), repo);
  const people: K2[] = [...COACHES, 'T', 'O', 'M', 'X', 'V', 'Y', 'L', 'N', 'W', 'G', 'K1', 'K2', 'Z', 'K3', 'K4', 'K5'];
  const id = Object.fromEntries(people.map((k) => [k, randomUUID()])) as Record<K2, string>;
  const sub = Object.fromEntries(people.map((k) => [k, randomUUID()])) as Record<K2, string>;
  const ws = Object.fromEntries(COACHES.map((k) => [k, randomUUID()])) as Record<K2, string>;
  const space = { S: randomUUID(), P: randomUUID(), SB: randomUUID(), SC: randomUUID(), SD: randomUUID(), SE: randomUUID(),
    SF: randomUUID() };
  type Space = keyof typeof space;
  const owner: Record<Space, K2> = { S: 'A', P: 'A', SB: 'B', SC: 'C', SD: 'D', SE: 'E', SF: 'F' };
  const run = randomUUID().slice(0, 8);
  const label: Record<string, string> = {};
  const isCoach = (k: K2) => COACHES.includes(k) || k === 'T';
  const user = (k: K2) => stub<User>({ id: id[k], role: isCoach(k) ? 'coach' : 'student', coach_id: CLIENT_OF[k] ? id[CLIENT_OF[k] as K2] : null });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const voice = async (k: K2, s: Space, tag = '') => {
    const note = await notes.createVoiceNote({ workspaceId: ws[owner[s]], cohortId: space[s], conversationId: null, authorId: id[k],
      storageKey: `${id[k]}/1700000000000-${randomUUID().replace(/-/g, '').slice(0, 16)}.m4a`, durationMs: 4_000, bytes: 1000,
      mimeType: 'audio/mp4', waveformPeaks: null, parent: null, answersClients: false });
    label[note.row.id] = `${k}.${s}.voice${tag}`;
    await tick();
  };
  // Typed words as Postgres stamps them: clock_timestamp() keeps microseconds, which a JS Date cursor drops.
  const typed = async (k: K2, s: Space, tag = '') => {
    const m = randomUUID();
    await prisma.$executeRaw`INSERT INTO "community_messages" ("id", "created_at", "workspace_id", "cohort_id", "scope", "sender_id", "body", "updated_at")
      VALUES (${m}::uuid, clock_timestamp(), ${ws[owner[s]]}::uuid, ${space[s]}::uuid, 'cohort', ${id[k]}, ${`words of ${k}`}, now())`;
    label[m] = `${k}.${s}.typed${tag}`;
    await tick();
  };
  const post = async (k: K2, s: Space, answeredBy?: K2, tag = '') => {
    const p = await prisma.communityPost.create({ data: { workspace_id: ws[owner[s]], cohort_id: space[s], author_id: id[k], scope: 'cohort', body: `post of ${k}` } });
    if (answeredBy) {
      await prisma.communityMessage.create({ data: { workspace_id: ws[owner[s]], cohort_id: space[s], scope: 'cohort', sender_id: id[answeredBy],
        body: 'answer', plan_context_type: 'community_post_comment', plan_context_id: p.id } });
    }
    label[p.id] = answeredBy ? `${k}.${s}.answered` : `${k}.${s}.post${tag}`;
    await tick();
  };
  const rows = async (k: K2) => (await inbox.list(user(k), {})).items.map((i) => label[i.id] ?? i.id).sort();
  const pages = async (k: K2, limit: number) => {
    const out: string[][] = [];
    let cursor: string | null = null;
    do {
      const page = await inbox.list(user(k), { limit: String(limit), ...(cursor ? { cursor } : {}) });
      out.push(page.items.map((i) => label[i.id] ?? i.id));
      cursor = page.next_cursor;
    } while (cursor && out.length < 10);
    return out;
  };
  const reads = (k: K2, table: string, rowId: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(k) ? 'coach' : 'student');
      const r = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id"::text = $1`, rowId);
      return r[0].n;
    });
  const idOf = (l: string) => Object.keys(label).find((k) => label[k] === l) ?? '';

  beforeAll(async () => {
    for (const k of people) {
      const coach = CLIENT_OF[k] ? id[CLIENT_OF[k] as K2] : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`voice-inbox-rules-${id[k]}`}, ${`RLS person ${k}`}, ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coach})`;
    }
    for (const c of COACHES) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`voice-inbox-rules-${run}-${c}`}, now())`;
    }
    for (const s of Object.keys(space) as Space[]) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], ws[owner[s]], `RLS space ${s}`,
        s === 'P' ? 'public' : 'clients');
    }
    const members: Array<[K2, Space]> = [['O', 'S'], ['M', 'S'], ['X', 'S'], ['V', 'S'], ['Y', 'S'], ['L', 'S'], ['O', 'P'], ['M', 'P'],
      ['N', 'P'], ['W', 'P'], ['G', 'P'], ['T', 'P'], ['W', 'SB'], ['K1', 'SC'], ['K2', 'SC'], ['Z', 'SC'], ['K3', 'SD'], ['K4', 'SE'],
      ['K5', 'SF']];
    for (const [k, s] of members) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"CommunityMembershipRole", 'active', now())`, randomUUID(), ws[owner[s]], space[s], id[k],
        k === 'T' ? 'assistant' : 'student');
    }
    await prisma.userBlock.create({ data: { blocker_id: id.A, blocked_id: id.X } });
    await prisma.userBlock.create({ data: { blocker_id: id.V, blocked_id: id.A } });
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.Y, banned_by_id: id.A } });
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.L, banned_by_id: id.A, lifted_at: new Date() } });
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.C, user_id: id.Z, banned_by_id: id.C } });
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.G, banned_by_id: id.A } });
    for (const k of ['O', 'M', 'X', 'V', 'Y', 'L'] as K2[]) {
      await typed(k, 'S');
      await post(k, 'S');
      await voice(k, 'S');
    }
    for (const k of ['O', 'M', 'N', 'W', 'G'] as K2[]) {
      await typed(k, 'P');
      await post(k, 'P');
      await voice(k, 'P');
    }
    await typed('W', 'SB');
    // C's queue, oldest first: three answered posts, then m1 v1 p1 m2 v2 m3, with banned Z's three rows in between.
    for (let i = 0; i < 3; i += 1) await post('K1', 'SC', 'C');
    await typed('K1', 'SC');
    await typed('Z', 'SC');
    await voice('Z', 'SC');
    await post('Z', 'SC');
    await voice('K2', 'SC');
    await post('K2', 'SC');
    await typed('K2', 'SC');
    await voice('K1', 'SC');
    await typed('K1', 'SC');
    // D, E and F: one stream each (typed, voice, posts behind two answered ones).
    for (const tag of ['1', '2', '3']) await typed('K3', 'SD', tag);
    for (const tag of ['1', '2', '3']) await voice('K4', 'SE', tag);
    for (let i = 0; i < 2; i += 1) await post('K5', 'SF', 'F');
    for (const tag of ['1', '2', '3']) await post('K5', 'SF', undefined, tag);
  });
  afterAll(() => prisma.$disconnect());

  it('a blocked, blocking or banned author has no row of any kind; own clients and a lifted ban have all three', async () => {
    expect(await rows('A')).toEqual(['L.S.post', 'L.S.typed', 'L.S.voice', ...P_ROWS('M'), 'M.S.post', 'M.S.typed', 'M.S.voice',
      ...P_ROWS('N'), ...P_ROWS('O'), 'O.S.post', 'O.S.typed', 'O.S.voice', ...P_ROWS('W')]);
  });

  // Rule D, the three posters: a coachless one (N), one with a different coach (W, B's client) and the space owner's own
  // client (O). Control first: B's own space SB gives B W's typed row (1) before any count of 0.
  it('rule D: a public-space row reaches the space owner, the team and the poster\'s own coach (N: no coach)', async () => {
    expect(await rows('B')).toEqual([...P_ROWS('W'), 'W.SB.typed']);
    expect(await rows('T')).toEqual([...P_ROWS('M'), ...P_ROWS('N'), ...P_ROWS('O'), ...P_ROWS('W')]);
    expect((await rows('A')).filter((r) => r.includes('.P.'))).toEqual([...P_ROWS('M'), ...P_ROWS('N'), ...P_ROWS('O'), ...P_ROWS('W')]);
    for (const k of ['C', 'D'] as K2[]) expect((await rows(k)).filter((r) => r.includes('.P.'))).toEqual([]);
    // The row layer agrees: B reads W's three rows (1 each), then 0 of N's, O's and banned G's; A and T read N's note.
    const seen: string[] = [];
    for (const [k, table, l] of [['B', 'community_voice_notes', 'W.P.voice'], ['B', 'community_messages', 'W.P.voice'],
      ['B', 'community_messages', 'W.P.typed'], ['B', 'community_posts', 'W.P.post'], ['B', 'community_voice_notes', 'N.P.voice'],
      ['B', 'community_messages', 'N.P.typed'], ['B', 'community_posts', 'O.P.post'], ['B', 'community_voice_notes', 'G.P.voice'],
      ['B', 'community_messages', 'G.P.typed'], ['B', 'community_posts', 'G.P.post'], ['A', 'community_voice_notes', 'N.P.voice'],
      ['T', 'community_voice_notes', 'N.P.voice'], ['T', 'community_posts', 'W.P.post']] as const) {
      seen.push(`${k} ${table} ${l} ${await reads(k, table, idOf(l))}`);
    }
    expect(seen).toEqual(['B community_voice_notes W.P.voice 1', 'B community_messages W.P.voice 1', 'B community_messages W.P.typed 1',
      'B community_posts W.P.post 1', 'B community_voice_notes N.P.voice 0', 'B community_messages N.P.typed 0',
      'B community_posts O.P.post 0', 'B community_voice_notes G.P.voice 0', 'B community_messages G.P.typed 0',
      'B community_posts G.P.post 0', 'A community_voice_notes N.P.voice 1', 'T community_voice_notes N.P.voice 1',
      'T community_posts W.P.post 1']);
  });

  it('a client who moves: the former coach keeps every public-space row and loses S; the new coach gets the public ones', async () => {
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.B} WHERE "id" = ${id.M}`;
    expect(await rows('A')).toEqual(['L.S.post', 'L.S.typed', 'L.S.voice', ...P_ROWS('M'), ...P_ROWS('N'), ...P_ROWS('O'),
      'O.S.post', 'O.S.typed', 'O.S.voice', ...P_ROWS('W')]);
    expect(await rows('B')).toEqual([...P_ROWS('M'), ...P_ROWS('W'), 'W.SB.typed']);
    const seen: string[] = [];
    for (const [k, table, l] of [['B', 'community_voice_notes', 'M.P.voice'], ['B', 'community_posts', 'M.P.post'],
      ['B', 'community_voice_notes', 'M.S.voice'], ['B', 'community_posts', 'M.S.post'], ['A', 'community_voice_notes', 'M.P.voice'],
      ['A', 'community_voice_notes', 'M.S.voice']] as const) {
      seen.push(`${k} ${table} ${l} ${await reads(k, table, idOf(l))}`);
    }
    expect(seen).toEqual(['B community_voice_notes M.P.voice 1', 'B community_posts M.P.post 1', 'B community_voice_notes M.S.voice 0',
      'B community_posts M.S.post 0', 'A community_voice_notes M.P.voice 1', 'A community_voice_notes M.S.voice 0']);
  });

  it('the AI triage reads typed words only, under the same rules, for the space owner and the poster\'s own coach', async () => {
    const words = async (k: K2) => (await repo.unansweredMessages({ cohortIds: await repo.coachedCohortIds(id[k]), limit: 50,
      after: null, viewerId: id[k] })).map((m) => label[m.id]).sort();
    expect(await words('A')).toEqual(['L.S.typed', 'M.P.typed', 'N.P.typed', 'O.P.typed', 'O.S.typed', 'W.P.typed']);
    expect(await words('B')).toEqual(['M.P.typed', 'W.P.typed', 'W.SB.typed']);
    expect(await words('T')).toEqual(['M.P.typed', 'N.P.typed', 'O.P.typed', 'W.P.typed']);
  });

  // 20270502009800 down.sql takes the poster's own coach's read away; migration.sql gives it back.
  it('down.sql takes the poster\'s own coach\'s read away (the space owner keeps theirs); migration.sql restores it', async () => {
    const dir = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502009800_community_public_space_own_coach');
    const apply = (file: string) => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const sql = readFileSync(join(dir, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m).map((x) => x.trim());
      for (const x of sql.filter((y) => y && !/^(BEGIN|COMMIT)$/i.test(y))) await tx.$executeRawUnsafe(x);
    });
    const now = async () => [await reads('A', 'community_voice_notes', idOf('W.P.voice')),
      await reads('B', 'community_voice_notes', idOf('W.P.voice')), await reads('B', 'community_posts', idOf('W.P.post'))];
    expect(await now()).toEqual([1, 1, 1]);
    await apply('down.sql');
    try {
      expect(await now()).toEqual([1, 0, 0]);
    } finally {
      await apply('migration.sql');
    }
    expect(await now()).toEqual([1, 1, 1]);
  });

  it('pages walk every unanswered row once, in order, across voice, typed and post rows; answered posts use no place', async () => {
    expect(await pages('C', 2)).toEqual([['K1.SC.typed', 'K2.SC.voice'], ['K2.SC.post', 'K2.SC.typed'], ['K1.SC.voice', 'K1.SC.typed']]);
    expect(await pages('C', 4)).toEqual([['K1.SC.typed', 'K2.SC.voice', 'K2.SC.post', 'K2.SC.typed'], ['K1.SC.voice', 'K1.SC.typed']]);
    expect((await pages('C', 6)).length).toBe(1);
  });

  it('a backlog in one stream alone still gives a next page, and the cursor row never comes back', async () => {
    expect(await pages('E', 2)).toEqual([['K4.SE.voice1', 'K4.SE.voice2'], ['K4.SE.voice3']]);
    expect(await pages('F', 2)).toEqual([['K5.SF.post1', 'K5.SF.post2'], ['K5.SF.post3']]);
    expect(await pages('D', 2)).toEqual([['K3.SD.typed1', 'K3.SD.typed2'], ['K3.SD.typed3']]);
    expect(await pages('D', 1)).toEqual([['K3.SD.typed1'], ['K3.SD.typed2'], ['K3.SD.typed3']]);
    expect(await pages('D', 3)).toEqual([['K3.SD.typed1', 'K3.SD.typed2', 'K3.SD.typed3']]);
  });
});
