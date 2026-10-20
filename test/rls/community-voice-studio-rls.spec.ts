// VOICE-BE (agent 163): voice notes, server half. Live, on the replayed migration chain: the real voice and
// chat services with the real CommunitySafetyService; row reads and writes on the two new tables run as role
// authenticated. A coaches O, V and N; O and V are members of A's members-only space "mem", N is not; X is a
// client of coach B (another tenant) in B's space "bmem". Each "0" follows a control read of 1.
//  - a space voice note is a kind 'voice' chat message (same id) that only the space's members read;
//  - author name and coach flag, waveform peaks round trip, reply link to a chat message;
//  - the heard marker is per listener (own rows only; never on a note the person cannot read);
//  - the consent flag is the person's own row;
//  - only the author deletes (a member gets 403; the chat message goes too); other tenants get 404.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../src/community/plan-context/plan-context.service';
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
  throw new Error('community-voice-studio-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'V' | 'N' | 'X';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'N', 'X']; // coaches first: clients reference them
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', V: 'A', N: 'A', X: 'B' };
const NAME: Record<Key, string> = { A: 'Ada Stone', B: 'Ben Hale', O: 'Olive Reed', V: 'Vera Lane', N: 'Nia Park', X: 'Xan Field' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');

(DB_URL ? describe : describe.skip)('VOICE-BE: voice notes in a space (names, waveform, heard, consent, reply link)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const safety = new CommunitySafetyService(db);
  const realtime = stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined });
  const push = stub<CommunityNotificationsService>({ pushEnabled: () => false });
  const chat = new CommunityMessagesService(access, new CommunityMessagesRepository(db), realtime,
    stub<PlanContextService>({}), safety, push);
  const upload = stub<VoiceUploadProvider>({
    bucket: () => 'voice-notes',
    statObject: async () => ({ state: 'present', size: 1000, contentType: 'audio/mp4' }),
    createSignedDownload: async () => 'https://voice.test/note',
    removeObjects: async () => ({ removed: 1, failed: false }),
    objectGone: async () => true,
  });
  const voice = new CommunityVoiceService(access, new CommunityVoiceRepository(db), upload, realtime,
    stub<AnalyticsService>({ capture: () => undefined }), safety);
  const ids = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = ids(PEOPLE);
  const sub = ids(PEOPLE);
  const ws = ids(['A', 'B'] as const);
  const space = ids(['mem', 'bmem'] as const);
  const textId = randomUUID(); // A's text message in mem: the reply parent
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const note = (k: Key, cohortId: string, extra: Record<string, unknown> = {}) => ({
    storage_key: mintVoiceKey(id[k], 'm4a'), cohort_id: cohortId, duration_ms: 4000, bytes: 1000,
    mime_type: 'audio/mp4' as const, ...extra,
  });
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const count = (k: Key, sql: string, ...args: unknown[]) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM ${sql}`, ...args)).then((r) => r[0].n);
  const chatRows = (k: Key, msg: string) => count(k, `"community_messages" WHERE "id" = $1::uuid`, msg);
  const heardRows = (k: Key, n: string) => count(k, `"community_voice_note_listens" WHERE "voice_note_id" = $1::uuid`, n);
  const consentRows = (k: Key, of: Key) => count(k, `"community_voice_consents" WHERE "user_id" = $1`, id[of]);
  const insertHeard = (k: Key, n: string, who: Key) =>
    as(k, (tx) => tx.$executeRawUnsafe(`INSERT INTO "community_voice_note_listens" ("voice_note_id", "user_id") VALUES ($1::uuid, $2)`, n, id[who]));
  const insertConsent = (k: Key, who: Key) =>
    as(k, (tx) => tx.$executeRawUnsafe(`INSERT INTO "community_voice_consents" ("user_id") VALUES ($1)`, id[who]));

  let noteO = '';

  beforeAll(async () => {
    process.env.VOICE_KEY_SIGNING_SECRET = process.env.VOICE_KEY_SIGNING_SECRET || 'voice-studio-rls-secret';
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`studio-${id[k]}`}, ${NAME[k]}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`studio-${run}-${c}`}, now())`;
    }
    const spaces: Array<['mem' | 'bmem', 'A' | 'B', Key[]]> = [['mem', 'A', ['O', 'V']], ['bmem', 'B', ['X']]];
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

  it('runs as a role that does not bypass row security, on new tables that force it', async () => {
    expect(await as('V', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    const tables = ['community_voice_note_listens', 'community_voice_consents'];
    const forced = await prisma.$queryRaw<{ t: string }[]>`SELECT c."relname" AS "t" FROM pg_class c JOIN pg_namespace n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relname" = ANY(${tables}) AND c."relrowsecurity" AND c."relforcerowsecurity"`;
    expect(forced.map((r) => r.t).sort()).toEqual([...tables].sort());
  });

  it('a reply note with peaks is a voice chat message in its space: name, coach flag, waveform, link', async () => {
    const res = await voice.create(user('O'), ws.A, note('O', space.mem, { waveform_peaks: [0, 0.5, 1], parent_message_id: textId }));
    noteO = res.voice_note.id;
    expect(res.voice_note).toMatchObject({ author_name: 'Olive', author_is_coach: false, waveform_peaks: [0, 0.502, 1],
      has_waveform: true, heard_at: null, message_id: noteO, parent_message_id: textId });
    const coach = await voice.create(user('A'), ws.A, note('A', space.mem));
    expect(coach.voice_note).toMatchObject({ author_name: 'Ada', author_is_coach: true, waveform_peaks: null,
      message_id: coach.voice_note.id, parent_message_id: null });
    const row = await prisma.communityMessage.findFirst({ where: { id: noteO } });
    expect(row).toMatchObject({ kind: 'voice', scope: 'cohort', cohort_id: space.mem, sender_id: id.O, body: null,
      voice_duration_ms: 4000, parent_message_id: textId, deleted_at: null });
    const page = await chat.list(user('V'), space.mem, {});
    expect(page.messages.find((m) => m.id === noteO)).toMatchObject({ kind: 'voice', parent_message_id: textId,
      voice_note: { id: noteO, duration_ms: 4000, waveform_peaks: [0, 0.502, 1], heard_at: null } });
    expect(page.messages.find((m) => m.id === textId)).toMatchObject({ kind: 'text', voice_note: null, parent_message_id: null });
  });

  it('only the space reads it: a member reads 1; a same-coach non-member and another tenant read 0 and get 404', async () => {
    expect(await chatRows('V', noteO)).toBe(1);
    expect(await chatRows('N', noteO)).toBe(0);
    expect(await chatRows('X', noteO)).toBe(0);
    expect(await status(voice.getOne(user('V'), noteO))).toBe(200);
    expect(await status(voice.getOne(user('N'), noteO))).toBe(404);
    expect(await status(voice.getOne(user('X'), noteO))).toBe(404);
    expect(await status(chat.getOne(user('X'), noteO))).toBe(404);
  });

  it('a reply only links to a chat message of its own space (other tenant: 404, nothing written)', async () => {
    expect(await status(voice.create(user('X'), ws.B, note('X', space.bmem, { parent_message_id: textId })))).toBe(404);
    expect(await prisma.communityVoiceNote.count({ where: { author_id: id.X } })).toBe(0);
  });

  it('heard is per listener: own row only, and only on a note the person can read', async () => {
    const heard = await voice.markHeard(user('V'), noteO);
    expect(heard.voice_note_id).toBe(noteO);
    expect((await voice.getOne(user('V'), noteO)).voice_note.heard_at).toBe(heard.heard_at);
    expect((await voice.markHeard(user('V'), noteO)).heard_at).toBe(heard.heard_at); // the first time is kept
    expect((await voice.getOne(user('O'), noteO)).voice_note.heard_at).toBeNull();
    const v = (await chat.list(user('V'), space.mem, {})).messages.find((m) => m.id === noteO);
    expect(v?.voice_note?.heard_at).toBe(heard.heard_at);
    expect(await status(voice.markHeard(user('N'), noteO))).toBe(404);
    expect(await status(voice.markHeard(user('X'), noteO))).toBe(404);
    // Row level: O marks their own (control 1 of the 2 rows), never reads V's.
    await insertHeard('O', noteO, 'O');
    expect(await prisma.communityVoiceNoteListen.count({ where: { voice_note_id: noteO } })).toBe(2);
    expect(await heardRows('O', noteO)).toBe(1);
    expect(await heardRows('N', noteO)).toBe(0);
    await expect(insertHeard('V', noteO, 'O')).rejects.toThrow(/row-level security/);
    await expect(insertHeard('N', noteO, 'N')).rejects.toThrow(/row-level security/);
    await expect(insertHeard('X', noteO, 'X')).rejects.toThrow(/row-level security/);
  });

  it('consent is the person\'s own row, shown once', async () => {
    expect(await voice.consent(user('O'))).toEqual({ seen: false, seen_at: null });
    const first = await voice.markConsentSeen(user('O'));
    expect(first.seen).toBe(true);
    expect(await voice.markConsentSeen(user('O'))).toEqual(first);
    expect(await voice.consent(user('O'))).toEqual(first);
    await insertConsent('V', 'V');
    expect(await consentRows('V', 'V')).toBe(1);
    expect(await consentRows('V', 'O')).toBe(0);
    expect(await consentRows('O', 'O')).toBe(1);
    await expect(insertConsent('X', 'O')).rejects.toThrow(/row-level security/);
  });

  it('only the author deletes: a member gets 403, another tenant 404; the chat message goes with the note', async () => {
    expect(await status(voice.delete(user('V'), noteO))).toBe(403);
    expect(await status(voice.delete(user('X'), noteO))).toBe(404);
    expect(await status(chat.remove(user('O'), noteO))).toBe(404); // the voice route deletes a voice message
    expect(await chatRows('V', noteO)).toBe(1);
    expect(await voice.delete(user('O'), noteO)).toEqual({ deleted: true });
    expect(await prisma.communityMessage.findFirst({ where: { id: noteO } })).toMatchObject({ deleted_at: expect.any(Date) });
    expect((await chat.list(user('V'), space.mem, {})).messages.map((m) => m.id)).not.toContain(noteO);
    expect(await status(voice.getOne(user('V'), noteO))).toBe(404);
  });
});
