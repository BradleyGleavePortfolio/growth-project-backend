// BPF-1 (agent 180): a voice note for a space answers to that space's own rule, the one a text message there
// answers to, so a member of a public space may send one there. Live, on the replayed migration chain, with the
// real voice and chat services, their repositories and CommunitySafetyService. A and B coach. A's spaces: pub
// (public), priv (chosen members) and cpub (public, coach-only); B's: bpub (public). P is B's client and Q has no
// coach; both joined pub and cpub, their only spaces of A's, so A's Hall is closed to them (it opens with a space
// that is not public). O is A's client in priv and pub. X is B's client in pub, banned from A's community. M was
// A's client in priv and pub and moved to B. O blocked Q.
//  - B-TEST: P and Q send a text message in pub, but their voice upload for pub and their voice note there are
//    refused (404) before the fix.
//  - Each boundary: in each space, the voice upload and note get the text message's answer (a private space, a
//    ban, a move, another community, coach-only, a block, a reply's thread); the Hall and direct messages keep
//    their own rules; the entitlement switch keeps its plan check.
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
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

type Key = 'A' | 'B' | 'P' | 'Q' | 'O' | 'X' | 'M';
type Space = 'pub' | 'priv' | 'cpub' | 'bpub';
const PEOPLE: Key[] = ['A', 'B', 'P', 'Q', 'O', 'X', 'M']; // coaches first: clients reference them
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, P: 'B', Q: null, O: 'A', X: 'B', M: 'B' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
const SPACE: Record<Space, { ws: 'A' | 'B'; visibility: string; posting: string; members: Key[] }> = {
  pub: { ws: 'A', visibility: 'public', posting: 'all', members: ['P', 'Q', 'O', 'X', 'M'] },
  priv: { ws: 'A', visibility: 'members', posting: 'all', members: ['O', 'M'] },
  cpub: { ws: 'A', visibility: 'public', posting: 'coach', members: ['P', 'Q'] },
  bpub: { ws: 'B', visibility: 'public', posting: 'all', members: ['P'] },
};
const ENTITLEMENT = 'FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT';

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
  const space = uuids(['pub', 'priv', 'cpub', 'bpub'] as const);
  const msg = uuids(['coachThread', 'memberThread', 'byO', 'replyToO'] as const);
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
  // 'ok', or the refusal as "<status> <code>".
  const said = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => {
    const body = e instanceof HttpException ? e.getResponse() : null;
    if (e instanceof HttpException && body && typeof body === 'object' && 'code' in body) return `${e.getStatus()} ${String(body.code)}`;
    throw e;
  });
  // A text message, a voice upload and a voice note by k in space s, as the server answers.
  const all3 = async (k: Key, s: Space, parent?: string) => ({
    text: await said(chat.send(user(k), space[s], 'RLS text', undefined, parent)),
    upload: await said(voice.issueUploadUrl(user(k), ws[SPACE[s].ws], uploadFor(space[s]))),
    voice: await said(voice.create(user(k), ws[SPACE[s].ws], note(k, space[s], parent ? { parent_message_id: parent } : {}))),
  });
  const NOT_FOUND = '404 community.voice.not_found';
  const CHAT_NOT_FOUND = '404 community.message.not_found';
  const READ_ONLY = '403 community.space.read_only';
  // The answers a space gives (each route's own words): sent; the space is closed to them; a new message is
  // the coach's (the upload only asks access); the message replied to is closed to them.
  const SENT = { text: 'ok', upload: 'ok', voice: 'ok' };
  const CLOSED = { text: CHAT_NOT_FOUND, upload: NOT_FOUND, voice: NOT_FOUND };
  const COACH_ONLY = { text: READ_ONLY, upload: 'ok', voice: READ_ONLY };
  const PARENT_CLOSED = { text: CHAT_NOT_FOUND, upload: 'ok', voice: CHAT_NOT_FOUND };

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
    for (const s of ['pub', 'priv', 'cpub', 'bpub'] as const) {
      const { ws: w, visibility, posting, members } = SPACE[s];
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "posting_policy", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", $5::"CommunityPostingPolicy", 'active', now())`,
      space[s], ws[w], `RLS ${s}`, visibility, posting);
      for (const k of members) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[w], space[s], id[k]);
      }
    }
    await prisma.$executeRaw`INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id", "banned_by_id")
      VALUES (${randomUUID()}::uuid, ${ws.A}::uuid, ${id.X}, ${id.A})`;
    await prisma.$executeRaw`INSERT INTO "UserBlock" ("id", "blocker_id", "blocked_id") VALUES (${randomUUID()}, ${id.O}, ${id.Q})`;
    // cpub: A's thread, and Q's from before the space went coach-only. pub: O's message and P's reply to it.
    const at: Partial<Record<keyof typeof msg, Date>> = {};
    const rows: [keyof typeof msg, Space, Key, keyof typeof msg | null][] = [['coachThread', 'cpub', 'A', null],
      ['memberThread', 'cpub', 'Q', null], ['byO', 'pub', 'O', null], ['replyToO', 'pub', 'P', 'byO']];
    for (const [m, s, k, parent] of rows) {
      const row = await prisma.communityMessage.create({ data: { id: msg[m], workspace_id: ws[SPACE[s].ws], cohort_id: space[s],
        scope: 'cohort', sender_id: id[k], body: 'RLS text', parent_message_id: parent && msg[parent],
        parent_message_at: parent && at[parent] } });
      at[m] = row.created_at;
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

  // [case, who, space, reply to, what the text message, the voice upload and the voice note get]
  it.each<[string, Key, Space, keyof typeof msg | null, typeof SENT]>([
    ['A\'s client in the public space', 'O', 'pub', null, SENT],
    ['the coach in the public space', 'A', 'pub', null, SENT],
    ['another coach\'s client in a chosen-members space they are not in', 'P', 'priv', null, CLOSED],
    ['another coach, not a member, in the public space', 'B', 'pub', null, CLOSED],
    ['a member banned from the community, in its public space', 'X', 'pub', null, CLOSED],
    ['a client who moved to another coach, in a chosen-members space', 'M', 'priv', null, CLOSED],
    ['a client who moved to another coach, in the public space (public keeps them)', 'M', 'pub', null, SENT],
    ['another coach\'s client in their own coach\'s public space', 'P', 'bpub', null, SENT],
    ['a new message in a coach-only public space', 'P', 'cpub', null, COACH_ONLY],
    ['a reply in the coach\'s thread in a coach-only public space', 'P', 'cpub', 'coachThread', SENT],
    ['a person with no coach replying in the coach\'s thread there', 'Q', 'cpub', 'coachThread', SENT],
    ['a reply in a member\'s thread in a coach-only public space', 'P', 'cpub', 'memberThread', COACH_ONLY],
    ['a reply to a message by someone who blocked the sender', 'Q', 'pub', 'byO', PARENT_CLOSED],
    ['a reply to a reply in a thread started by someone who blocked the sender', 'Q', 'pub', 'replyToO', PARENT_CLOSED],
  ])('%s: the voice upload and note get the text message\'s answer', async (_case, k, s, parent, answer) => {
    const notes = await prisma.communityVoiceNote.count({ where: { author_id: id[k] } });
    expect(await all3(k, s, parent ? msg[parent] : undefined)).toEqual(answer);
    expect(await prisma.communityVoiceNote.count({ where: { author_id: id[k] } })).toBe(notes + (answer.voice === 'ok' ? 1 : 0));
  });

  it('a space of another community, through this community\'s path, is the same 404 and writes nothing', async () => {
    const notes = await prisma.communityVoiceNote.count({ where: { author_id: id.P } });
    expect([await said(voice.issueUploadUrl(user('P'), ws.A, uploadFor(space.bpub))),
      await said(voice.create(user('P'), ws.A, note('P', space.bpub))),
      await said(voice.list(user('P'), ws.A, { cohort_id: space.bpub }))]).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    expect(await prisma.communityVoiceNote.count({ where: { author_id: id.P } })).toBe(notes);
  });

  it('the Hall keeps its rule: a member of public spaces only gets 404; A\'s client does not', async () => {
    for (const k of ['P', 'Q'] as const) {
      expect([k, await said(voice.issueUploadUrl(user(k), ws.A, uploadFor())), await said(voice.create(user(k), ws.A, note(k))),
        await said(voice.list(user(k), ws.A, {}))]).toEqual([k, NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    }
    expect([await said(voice.issueUploadUrl(user('O'), ws.A, uploadFor())), await said(voice.create(user('O'), ws.A, note('O')))])
      .toEqual(['ok', 'ok']);
  });

  it('direct messages keep theirs: no voice notes there, and a space and a direct message at once is refused', async () => {
    const conversation_id = randomUUID();
    expect(await said(voice.create(user('P'), ws.A, note('P', undefined, { conversation_id })))).toBe(NOT_FOUND);
    expect(await said(voice.create(user('O'), ws.A, note('O', undefined, { conversation_id }))))
      .toBe('400 community.voice.dm_not_supported');
    expect(await said(voice.create(user('O'), ws.A, note('O', space.pub, { conversation_id }))))
      .toBe('400 community.voice.ambiguous_target');
    expect(await said(voice.create(user('P'), ws.A, note('P', space.pub, { conversation_id }))))
      .toBe('400 community.voice.ambiguous_target');
  });

  it('the space\'s note reads where its text does: the space list, the chat, the note itself', async () => {
    const sent = (await voice.create(user('Q'), ws.A, note('Q', space.pub))).voice_note.id;
    expect((await voice.list(user('Q'), ws.A, { cohort_id: space.pub })).voice_notes.map((n) => n.id)).toContain(sent);
    expect(await said(voice.list(user('Q'), ws.A, { cohort_id: space.priv }))).toBe(NOT_FOUND);
    expect((await chat.list(user('P'), space.pub, {})).messages.find((m) => m.id === sent)).toMatchObject({ kind: 'voice',
      voice_note: expect.objectContaining({ id: sent }) });
    expect([await status(voice.getOne(user('P'), sent)), await status(voice.getOne(user('M'), sent)),
      await status(voice.getOne(user('X'), sent)), await status(voice.getOne(user('B'), sent))]).toEqual([200, 200, 404, 404]);
    // O blocked Q: neither O's chat nor the note itself shows Q's note to O.
    expect((await chat.list(user('O'), space.pub, {})).messages.some((m) => m.id === sent)).toBe(false);
    expect(await status(voice.getOne(user('O'), sent))).toBe(404);
  });

  it('with the entitlement switch on, a note for the space needs no Hall membership; the Hall and the plan check stay', async () => {
    const before = process.env[ENTITLEMENT];
    process.env[ENTITLEMENT] = 'true';
    try {
      expect([await said(voice.issueUploadUrl(user('P'), ws.A, uploadFor(space.pub))), await said(voice.create(user('P'), ws.A, note('P', space.pub))),
        await said(voice.issueUploadUrl(user('P'), ws.A, uploadFor()))]).toEqual(['ok', 'ok', NOT_FOUND]);
      const free = stub<User>({ ...user('P'), plan_tier: 'free' });
      expect(await said(voice.issueUploadUrl(free, ws.A, uploadFor(space.pub)))).toBe('403 community.voice.not_entitled');
    } finally {
      if (before === undefined) delete process.env[ENTITLEMENT];
      else process.env[ENTITLEMENT] = before;
    }
  });
});
