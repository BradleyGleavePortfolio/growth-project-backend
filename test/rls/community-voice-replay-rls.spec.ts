// VOICE-IDEM-BE (agent 174): a voice note sent again after a lost reply posts once. Live, on the replayed
// migration chain, with the real voice service, repository and CommunitySafetyService. A coaches O, V and N;
// O and V are members of A's members-only space "mem", N is not; X is a client of coach B (another tenant).
// Row reads run as role authenticated; each "0" follows a control read of 1.
//  - the same create sent again returns the first note (same id and body): one note row, one chat row;
//  - three racing creates of one key write one note row and one chat row (the id comes from the key, so the
//    primary key admits one) and ping once; all three get the same note;
//  - the replayed note is read only by the space: a member reads 1, a same-coach non-member and another
//    tenant read 0;
//  - the key sent again in another place, with another parent or after the note was deleted is 409, nothing written.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import { CommunityVoiceService } from '../../src/community/voice/community-voice.service';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import { mintVoiceKey } from '../../src/community/voice/voice-storage-key';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-voice-replay-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'V' | 'N' | 'X';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'N', 'X']; // coaches first: clients reference them
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', V: 'A', N: 'A', X: 'B' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');

(DB_URL ? describe : describe.skip)('VOICE-IDEM-BE: a voice note sent again posts once (live)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const pings: string[] = [];
  const realtime = stub<CommunityRealtimeService>({
    broadcastCommunityEvent: async (_to: unknown, _event: string, body: { id: string }) => { pings.push(body.id); },
  });
  const upload = stub<VoiceUploadProvider>({
    bucket: () => 'voice-notes',
    statObject: async () => ({ state: 'present', size: 1000, contentType: 'audio/mp4' }),
    createSignedDownload: async () => 'https://voice.test/note',
    removeObjects: async () => ({ removed: 1, failed: false }),
    objectGone: async () => true,
  });
  const voice = new CommunityVoiceService(new CommunityAccessService(db), new CommunityVoiceRepository(db), upload,
    realtime, stub<AnalyticsService>({ capture: () => undefined }), new CommunitySafetyService(db));
  const ids = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = ids(PEOPLE);
  const sub = ids(PEOPLE);
  const ws = ids(['A', 'B'] as const);
  const space = ids(['mem', 'other', 'bmem'] as const);
  const textId = randomUUID(); // A's text message in mem: a reply parent
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const body = (storageKey: string, cohortId: string, extra: Record<string, unknown> = {}) => ({
    storage_key: storageKey, cohort_id: cohortId, duration_ms: 4000, bytes: 1000, mime_type: 'audio/mp4' as const, ...extra,
  });
  const status = (p: Promise<unknown>) => p.then(() => 201, (e: { status?: number }) => e.status ?? 500);
  const noteRows = (storageKey: string) => prisma.communityVoiceNote.count({ where: { storage_key: storageKey } });
  const chatCount = (noteId: string) => prisma.communityMessage.count({ where: { id: noteId } });

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const chatRows = (k: Key, msg: string) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id" = $1::uuid`, msg))
      .then((r) => r[0].n);

  beforeAll(async () => {
    process.env.VOICE_KEY_SIGNING_SECRET = process.env.VOICE_KEY_SIGNING_SECRET || 'voice-replay-rls-secret';
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`replay-${id[k]}`}, ${`Person ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`replay-${run}-${c}`}, now())`;
    }
    const spaces: Array<['mem' | 'other' | 'bmem', 'A' | 'B', Key[]]> = [['mem', 'A', ['O', 'V']], ['other', 'A', ['O']], ['bmem', 'B', ['X']]];
    for (const [s, c, members] of spaces) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, 'members'::"CommunitySpaceVisibility", 'active', now())`, space[s], ws[c], `RLS ${s}`);
      for (const k of members) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[c], space[s], id[k]);
      }
    }
    await prisma.communityMessage.create({ data: { id: textId, workspace_id: ws.A, cohort_id: space.mem, scope: 'cohort',
      sender_id: id.A, body: 'RLS text' } });
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('V', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('the same create sent again returns the first note: one note row, one chat row, one ping', async () => {
    const key = mintVoiceKey(id.O, 'm4a');
    const first = await voice.create(user('O'), ws.A, body(key, space.mem));
    const again = await voice.create(user('O'), ws.A, body(key, space.mem));
    expect(again).toEqual(first);
    expect(await noteRows(key)).toBe(1);
    expect(await chatCount(first.voice_note.id)).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(pings.filter((p) => p === first.voice_note.id)).toHaveLength(1);
  });

  it('three racing creates of one key write one note row and one chat row; all get the same note', async () => {
    const key = mintVoiceKey(id.O, 'm4a');
    const send = () => voice.create(user('O'), ws.A, body(key, space.mem, { parent_message_id: textId }));
    const got = await Promise.all([send(), send(), send()]);
    const noteId = got[0].voice_note.id;
    expect(got.map((g) => g.voice_note.id)).toEqual([noteId, noteId, noteId]);
    expect(got.map((g) => g.voice_note.parent_message_id)).toEqual([textId, textId, textId]);
    expect(await noteRows(key)).toBe(1);
    expect(await prisma.communityMessage.count({ where: { id: noteId, kind: 'voice', parent_message_id: textId } })).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(pings.filter((p) => p === noteId)).toHaveLength(1);
    // Only the space reads it: a member reads 1 (the control), a same-coach non-member and another tenant 0.
    expect(await chatRows('V', noteId)).toBe(1);
    expect(await chatRows('N', noteId)).toBe(0);
    expect(await chatRows('X', noteId)).toBe(0);
  });

  it('the key sent again in another space, with another parent or after a delete is 409; nothing written', async () => {
    const key = mintVoiceKey(id.O, 'm4a');
    const first = await voice.create(user('O'), ws.A, body(key, space.mem));
    expect(await status(voice.create(user('O'), ws.A, body(key, space.other)))).toBe(409);
    expect(await status(voice.create(user('O'), ws.A, body(key, space.mem, { parent_message_id: textId })))).toBe(409);
    expect(await status(voice.create(user('X'), ws.B, body(key, space.bmem)))).toBe(400); // the key is O's
    expect(await voice.delete(user('O'), first.voice_note.id)).toEqual({ deleted: true });
    expect(await status(voice.create(user('O'), ws.A, body(key, space.mem)))).toBe(409);
    expect(await noteRows(key)).toBe(1);
    expect(await chatCount(first.voice_note.id)).toBe(1);
    expect(await prisma.communityMessage.findFirst({ where: { id: first.voice_note.id } })).toMatchObject({ deleted_at: expect.any(Date) });
  });

  it('a non-member resending a member\'s note is refused as a first create is (404), not shown the note', async () => {
    const key = mintVoiceKey(id.N, 'm4a');
    expect(await status(voice.create(user('N'), ws.A, body(key, space.mem)))).toBe(404);
    expect(await status(voice.create(user('N'), ws.A, body(key, space.mem)))).toBe(404);
    expect(await noteRows(key)).toBe(0);
  });
});
