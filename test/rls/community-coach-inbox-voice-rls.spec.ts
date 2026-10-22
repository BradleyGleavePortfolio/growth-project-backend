// VOICE-INBOX (owner "#167-4 VOICE-INBOX - op 1"): a client's voice note in the coach's own space is a row in that
// coach's community inbox, with the typed rows' rules. Live, on the replayed migration chain, through the real
// voice repository (the note and its chat message are written as the app writes them). A and B coach; O, X and Y
// are A's clients in A's space; A blocked X; Y is banned from A's workspace; W is B's client in B's space. Row reads
// run as role authenticated; each person's first read is their control read, so every 0 follows a 1.
import { randomUUID } from 'crypto';
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
    return note.id;
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
    await notes.softDeleteWithErasure({ id: row.vO2, storage_key: gone?.storage_key ?? '' }, 'author_delete');
    expect(await rows('A')).toEqual(['mO text RLS typed question', 'vO voice Voice note']);
  });

  it('the coach\'s own voice reply answers the space as a typed reply does, and is never a row itself', async () => {
    row.vA = await say('A', 9_000, true);
    expect(await rows('A')).toEqual([]);
    expect(await rows('B')).toEqual(['vW voice Voice note']);
  });
});
