// BPF-1 (agent 180): a voice note for a space answers to that space's own rule, the one a text message there
// answers to, so a member of a public space may send one there. Live, on the replayed migration chain, with the
// real voice and chat services, their repositories and CommunitySafetyService. A and B coach. A's spaces: pub
// (public) and priv (chosen members). P is B's client and Q has no coach; both joined pub, their only space of
// A's, so A's Hall is closed to them (it opens with a space that is not public). O is A's client in priv and pub.
//  - B-TEST: P and Q send a text message in pub, but their voice upload for pub and their voice note there are
//    refused (404) before the fix.
import { randomUUID } from 'crypto';
import { PrismaClient, type User } from '@prisma/client';
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
  throw new Error('community-voice-space-target-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'P' | 'Q' | 'O';
type Space = 'pub' | 'priv';
const PEOPLE: Key[] = ['A', 'B', 'P', 'Q', 'O']; // coaches first: clients reference them
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, P: 'B', Q: null, O: 'A' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
const VISIBILITY: Record<Space, string> = { pub: 'public', priv: 'members' };
const MEMBERS: Record<Space, Key[]> = { pub: ['P', 'Q', 'O'], priv: ['O'] };

(DB_URL ? describe : describe.skip)('BPF-1: a member of a space sends a voice note there (live)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const safety = new CommunitySafetyService(db);
  const realtime = stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined });
  const chat = new CommunityMessagesService(access, new CommunityMessagesRepository(db), realtime,
    stub<PlanContextService>({}), safety, stub<CommunityNotificationsService>({ pushEnabled: () => false }));
  const upload = stub<VoiceUploadProvider>({
    bucket: () => 'voice-notes',
    ttlSeconds: () => 600,
    createSignedUploadWithKey: async (owner: string) => ({ upload_url: 'https://voice.test/put', public_url: '',
      expires_at: new Date(Date.now() + 600_000).toISOString(), storage_key: mintVoiceKey(owner, 'm4a') }),
    statObject: async () => ({ state: 'present', size: 1000, contentType: 'audio/mp4' }),
    createSignedDownload: async () => 'https://voice.test/note',
  });
  const voice = new CommunityVoiceService(access, new CommunityVoiceRepository(db), upload, realtime,
    stub<AnalyticsService>({ capture: () => undefined }), safety);
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids(PEOPLE);
  const ws = uuids(['A', 'B'] as const);
  const space = uuids(['pub', 'priv'] as const);
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  // The upload input, with the space the note is for when there is one (the field the send already takes).
  const uploadFor = (cohortId?: string) => ({
    duration_ms: 4000, bytes: 1000, mime_type: 'audio/mp4' as const, ...(cohortId ? { cohort_id: cohortId } : {}),
  });
  const note = (k: Key, cohortId?: string, extra: Record<string, unknown> = {}) => ({
    storage_key: mintVoiceKey(id[k], 'm4a'), ...(cohortId ? { cohort_id: cohortId } : {}), duration_ms: 4000, bytes: 1000,
    mime_type: 'audio/mp4' as const, ...extra,
  });
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? String(e));

  beforeAll(async () => {
    process.env.VOICE_KEY_SIGNING_SECRET = process.env.VOICE_KEY_SIGNING_SECRET || 'voice-space-target-rls-secret';
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${randomUUID()}, ${`space-target-${id[k]}`}, ${`Person ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`space-target-${run}-${c}`}, now())`;
    }
    for (const s of ['pub', 'priv'] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], ws.A, `RLS ${s}`, VISIBILITY[s]);
      for (const k of MEMBERS[s]) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws.A, space[s], id[k]);
      }
    }
  });
  afterAll(() => prisma.$disconnect());

  it('B-TEST: a member of the public space only sends a voice note there as they send a text message there', async () => {
    for (const k of ['P', 'Q'] as const) {
      const got = {
        text: await status(chat.send(user(k), space.pub, 'RLS hello')),
        upload: await status(voice.issueUploadUrl(user(k), ws.A, uploadFor(space.pub))),
        voice: await status(voice.create(user(k), ws.A, note(k, space.pub))),
      };
      expect({ who: k, ...got }).toEqual({ who: k, text: 200, upload: 200, voice: 200 });
    }
  });
});
