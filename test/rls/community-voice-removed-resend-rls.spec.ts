// REMOVED-BY-BE x VOICE-IDEM-BE (agent 175): a voice note a coach removed, then sent again with the same
// storage key (a lost-reply resend), stays removed. Live, on the replayed migration chain, with the real voice
// service, repository and CommunitySafetyService. A coaches O and V; both are members of A's space "mem".
//  - the resend is the existing refusal (409 community.voice.already_posted), both through the key check and
//    when the resend misses that check and meets the primary key the id is derived from;
//  - nothing is written: the note row stays soft-deleted with removed_by_user_id = A, the chat row stays hidden
//    with removed_by_user_id = A, no new note, chat or search row, no notice, no ping;
//  - the space's voice list still shows the coach-removed placeholder (no audio) to the author and a member.
import { randomUUID } from 'crypto';
import { PrismaClient, type User } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import { CommunityVoiceService, VOICE_KEY_ALREADY_USED } from '../../src/community/voice/community-voice.service';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import { mintVoiceKey } from '../../src/community/voice/voice-storage-key';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-voice-removed-resend-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'O' | 'V';
const PEOPLE: Key[] = ['A', 'O', 'V']; // the coach first: clients reference them
const ROLE = (k: Key) => (k === 'A' ? 'coach' : 'student');

/** The real repository, except the next `miss` key checks find nothing: a resend that misses the check. */
class MissingKeyCheckRepository extends CommunityVoiceRepository {
  miss = 0;
  override async findByStorageKey(storageKey: string) {
    if (this.miss > 0) {
      this.miss -= 1;
      return null;
    }
    return super.findByStorageKey(storageKey);
  }
}

(DB_URL ? describe : describe.skip)('REMOVED-BY-BE: a coach-removed voice note sent again stays removed (live)', () => {
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
  const repo = new MissingKeyCheckRepository(db);
  const voice = new CommunityVoiceService(new CommunityAccessService(db), repo, upload,
    realtime, stub<AnalyticsService>({ capture: () => undefined }), new CommunitySafetyService(db));
  const id: Record<Key, string> = { A: randomUUID(), O: randomUUID(), V: randomUUID() };
  const ws = randomUUID();
  const mem = randomUUID();
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: k === 'A' ? null : id.A });
  const body = (storageKey: string) => ({
    storage_key: storageKey, cohort_id: mem, duration_ms: 4000, bytes: 1000, mime_type: 'audio/mp4' as const,
  });
  const refusal = (p: Promise<unknown>) => p.then(
    () => 'posted',
    (e: { getStatus?: () => number; getResponse?: () => unknown }) => ({ status: e.getStatus?.(), body: e.getResponse?.() }),
  );
  // Everything a resend could write or bring back for this note, read without row security.
  const state = async (noteId: string, storageKey: string) => ({
    notes: await prisma.communityVoiceNote.findMany({ where: { OR: [{ id: noteId }, { storage_key: storageKey }] } }),
    chats: await prisma.communityMessage.findMany({ where: { id: noteId } }),
    search: await prisma.communitySearchEntry.findMany({ where: { targetId: noteId } }),
    notices: await prisma.notification.count({ where: { user_id: id.O } }),
    pings: pings.filter((p) => p === noteId).length,
  });
  const settle = () => new Promise((r) => setImmediate(r));

  beforeAll(async () => {
    process.env.VOICE_KEY_SIGNING_SECRET = process.env.VOICE_KEY_SIGNING_SECRET || 'voice-removed-resend-rls-secret';
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${randomUUID()}, ${`removed-resend-${id[k]}`}, ${`Person ${k}`}, ${ROLE(k)}::"Role", ${k === 'A' ? null : id.A})`;
    }
    await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
      VALUES (${ws}::uuid, ${id.A}, 'RLS workspace', ${`removed-resend-${run}`}, now())`;
    await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
      VALUES ($1::uuid, $2::uuid, 'RLS mem', 'members'::"CommunitySpaceVisibility", 'active', now())`, mem, ws);
    for (const k of ['O', 'V'] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws, mem, id[k]);
    }
  });
  afterAll(() => prisma.$disconnect());

  it('the resend is refused (409), nothing is written, and the list keeps the removed placeholder', async () => {
    const key = mintVoiceKey(id.O, 'm4a');
    const noteId = (await voice.create(user('O'), ws, body(key))).voice_note.id;
    // The note's transcript row, as the search indexer writes it.
    await prisma.communitySearchEntry.create({ data: { workspaceId: ws, cohortId: mem, kind: 'voice_note_transcript',
      targetId: noteId, authorId: id.O, excerpt: 'voice note transcript', visibleToRoles: ['coach', 'student'] } });

    expect(await voice.delete(user('A'), noteId)).toEqual({ deleted: true });
    await settle();
    const removed = await state(noteId, key);
    expect(removed.notes).toEqual([expect.objectContaining({ id: noteId, soft_deleted_at: expect.any(Date), removed_by_user_id: id.A })]);
    expect(removed.chats).toEqual([expect.objectContaining({ kind: 'voice', deleted_at: expect.any(Date), visibility: 'hidden', removed_by_user_id: id.A })]);
    expect(removed.search).toEqual([expect.objectContaining({ softDeletedAt: expect.any(Date) })]);

    // The lost-reply resend, then the same resend missing the key check (the derived primary key refuses it).
    const refused = { status: 409, body: VOICE_KEY_ALREADY_USED };
    expect(await refusal(voice.create(user('O'), ws, body(key)))).toEqual(refused);
    repo.miss = 1;
    expect(await refusal(voice.create(user('O'), ws, body(key)))).toEqual(refused);
    expect(repo.miss).toBe(0);
    await settle();
    expect(await state(noteId, key)).toEqual(removed);

    for (const k of ['O', 'V'] as const) {
      const list = await voice.list(user(k), ws, { cohort_id: mem });
      expect(list.voice_notes.filter((n) => n.id === noteId)).toEqual([expect.objectContaining({
        url: null, duration_ms: 0, waveform_peaks: null, removed_by: expect.objectContaining({ role: 'coach', user_id: id.A }),
      })]);
    }
  });
});
