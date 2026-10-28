// FR-1173, fix round 1 on b#1173 SPACE-OWNER-ALERTS (owner rule D, decision #178-2 op 1; LS-INBOX2 B1-B4). Rule D for
// a public space: every alert and item reaches the space owner and their team, plus the poster's own current coach (a
// coachless poster: the owner's side only). Each block below was a failing test first (B-TEST), then fixed:
//   B4 a ban on the reading coach in the space's community takes the own-coach rows away, in the inbox and the rows;
//   B3 one coach's Acknowledge clears the row for every coach the inbox lists it to, and for the AI triage;
//   B1 the report queue for a public-space row reaches the owner's team and the poster's own coach, to read;
//   B2 whoever the inbox lists a row to can open it and acknowledge it (the post, the ack, the photo's row).
// A runs community WA: public space P and clients space S. T is on A's team in P (an assistant membership). B coaches
// W and is in no space of A's (B runs SB); C is an unrelated coach (runs SC). In P: W (B's client), N (no coach) and
// O (A's client); O is in S too. Real repositories and services; row reads run as role authenticated under forced RLS.
import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { AckRepository } from '../../src/community/ack/ack.repository';
import { AckService } from '../../src/community/ack/ack.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityCoachInboxRepository } from '../../src/community/inbox/community-coach-inbox.repository';
import { CommunityCoachInboxService } from '../../src/community/inbox/community-coach-inbox.service';
import { COMMENT_CONTEXT_TYPE, CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityModerationRepository } from '../../src/community/moderation/community-moderation.repository';
import { CommunityModerationService } from '../../src/community/moderation/community-moderation.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityPostsService } from '../../src/community/posts/community-posts.service';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-rule-d-readers-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'C' | 'T' | 'W' | 'N' | 'O';
const PEOPLE: Key[] = ['A', 'B', 'C', 'T', 'W', 'N', 'O']; // coaches first: clients reference them
const COACH: Partial<Record<Key, Key>> = { W: 'B', O: 'A' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' || k === 'C' || k === 'T' ? 'coach' : 'student');
const LISTED: Key[] = ['A', 'T', 'B']; // everyone the inbox lists W's public-space rows to

(DB_URL ? describe : describe.skip)('FR-1173 rule D readers: the space owner, their team and the poster\'s own coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const safety = new CommunitySafetyService(db);
  const repo = new CommunityCoachInboxRepository(db);
  const inbox = new CommunityCoachInboxService(access, repo);
  const notes = new CommunityVoiceRepository(db);
  const ack = new AckService(new AckRepository(db), access, stub<AnalyticsService>({ capture: jest.fn() }), safety);
  const messages = new CommunityMessagesRepository(db);
  const postsRepo = new CommunityPostsRepository(db);
  const posts = new CommunityPostsService(access, postsRepo, messages, stub<CommunityRealtimeService>({}),
    stub<CommunityNotificationsService>({}), safety, new CommunityReactionsRepository(db));
  const moderation = new CommunityModerationService(access, new CommunityModerationRepository(db), messages, postsRepo,
    stub<CommunityRealtimeService>({}), stub<CommunityNotificationsService>({}), db,
    stub<VoiceUploadProvider>({ createSignedDownload: async () => 'signed://voice' }));
  const id = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const ws = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
  const space = { P: randomUUID(), S: randomUUID(), SB: randomUUID(), SC: randomUUID() };
  const run = randomUUID().slice(0, 8);
  const row: Record<string, string> = {};
  const label = (rowId: string) => Object.entries(row).find(([, v]) => v === rowId)?.[0] ?? rowId;
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as Key] : null });
  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const count = (k: Key, table: string, rowId: string, column = 'id') =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "${column}"::text = $1`, rowId))
      .then((r) => r[0].n);
  const rows = async (k: Key) => (await inbox.list(user(k), {})).items.map((i) => label(i.id)).sort();
  const words = async (k: Key) => (await repo.unansweredMessages({ cohortIds: await repo.coachedCohortIds(id[k]), limit: 50,
    after: null, viewerId: id[k] })).map((m) => label(m.id)).sort();
  const say = async (k: Key, body: string, kind: 'text' | 'image' = 'text', s: 'P' | 'S' = 'P') =>
    (await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space[s], scope: 'cohort', kind, sender_id: id[k], body } })).id;
  const refused = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) =>
    (e instanceof NotFoundException ? 404 : e instanceof ForbiddenException ? 403 : String(e)));
  const ban = (k: Key, w: 'A' | 'C', lifted: Date | null) => prisma.communityWorkspaceBan.upsert({
    where: { workspace_id_user_id: { workspace_id: ws[w], user_id: id[k] } },
    create: { workspace_id: ws[w], user_id: id[k], banned_by_id: id[w] },
    update: { lifted_at: lifted, lifted_by_id: lifted ? id[w] : null } });

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`rule-d-${id[k]}`}, ${`RLS person ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as Key] : null})`;
    }
    for (const c of ['A', 'B', 'C'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`rule-d-${run}-${c}`}, now())`;
    }
    for (const [s, w, visibility] of [['P', 'A', 'public'], ['S', 'A', 'clients'], ['SB', 'B', 'clients'], ['SC', 'C', 'clients']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], ws[w], `RLS space ${s}`, visibility);
    }
    for (const [k, s, role] of [['T', 'P', 'assistant'], ['W', 'P', 'student'], ['N', 'P', 'student'], ['O', 'P', 'student'],
      ['O', 'S', 'student']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"CommunityMembershipRole", 'active', now())`, randomUUID(), ws.A, space[s], id[k], role);
    }
    row.wTyped = await say('W', 'typed one');
    row.wTyped2 = await say('W', 'typed two');
    row.wPhoto = await say('W', '', 'image');
    await prisma.communityMessageImage.create({ data: { message_id: row.wPhoto, cohort_id: space.P, author_id: id.W,
      storage_key: `${id.W}/${row.wPhoto}.jpg`, width: 4, height: 3, size_bytes: 100, mime: 'image/jpeg' } });
    row.wVoice = (await notes.createVoiceNote({ workspaceId: ws.A, cohortId: space.P, conversationId: null, authorId: id.W,
      storageKey: `${id.W}/1700000000000-${randomUUID().replace(/-/g, '').slice(0, 16)}.m4a`, durationMs: 7_000, bytes: 1000,
      mimeType: 'audio/mp4', waveformPeaks: null, parent: null, answersClients: false })).row.id;
    row.nTyped = await say('N', 'typed by N');
    row.oTyped = await say('O', 'typed by O');
    row.oS = await say('O', 'typed by O in S', 'text', 'S');
    for (const k of ['W', 'N'] as const) {
      row[`${k.toLowerCase()}Post`] = (await prisma.communityPost.create({ data: { workspace_id: ws.A, cohort_id: space.P,
        author_id: id[k], scope: 'cohort', body: `post of ${k}` } })).id;
    }
    for (const k of ['W', 'O', 'N'] as const) {
      row[`c${k}`] = (await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.P, scope: 'cohort',
        sender_id: id[k], body: `comment of ${k}`, plan_context_type: COMMENT_CONTEXT_TYPE, plan_context_id: row.wPost } })).id;
    }
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security, on tables that force it', async () => {
    expect(await as('W', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    const tables = ['community_messages', 'community_voice_notes', 'community_posts', 'community_message_images'];
    const forced = await prisma.$queryRaw<{ t: string }[]>`SELECT c."relname" AS "t" FROM pg_class c JOIN pg_namespace n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relname" = ANY(${tables}) AND c."relrowsecurity" AND c."relforcerowsecurity"`;
    expect(forced.map((r) => r.t).sort()).toEqual([...tables].sort());
  });

  // B4 (LS-INBOX2): the own-coach arm asked whether the author was banned, never the reading coach, in the API
  // (clientsPublicSpaceIds) and in the row rule (app.community_public_row_of_my_client).
  describe('B4: a ban on the reading coach in the space\'s community', () => {
    const W_ROWS = ['wPhoto', 'wPost', 'wTyped', 'wTyped2', 'wVoice'];
    const reads = async () => [await count('B', 'community_messages', row.wTyped), await count('B', 'community_voice_notes', row.wVoice),
      await count('B', 'community_posts', row.wPost)].join(' ');

    it('control: B, in no space of A\'s, gets W\'s public-space rows and reads them at the row layer', async () => {
      expect([await rows('B'), await reads()]).toEqual([W_ROWS, '1 1 1']);
    });

    it('banned from A\'s community, B gets none of them and reads none; once the ban is lifted, all of them again', async () => {
      await ban('B', 'A', null);
      expect([await rows('B'), await reads()]).toEqual([[], '0 0 0']);
      await ban('B', 'A', new Date());
      expect([await rows('B'), await reads()]).toEqual([W_ROWS, '1 1 1']);
    });

    it('a ban in another coach\'s community (C\'s) changes nothing in A\'s public space', async () => {
      await ban('B', 'C', null);
      expect([await rows('B'), await reads()]).toEqual([W_ROWS, '1 1 1']);
      await ban('B', 'C', new Date());
    });
  });

  // B3 (LS-INBOX2; rule D (d)): Acknowledge stamps coach_acked_at, but the inbox and the AI triage asked only for no
  // reply, so an acknowledged row stayed for every coach. Seen is not an acknowledgement and leaves the row.
  describe('B3: one coach\'s Acknowledge clears the row for every coach', () => {
    const open = async (k: Key, of: string[]) => [k, (await rows(k)).filter((r) => of.includes(r))];

    it('Seen leaves the row in every inbox that lists it', async () => {
      await ack.applyTransition(user('A'), row.wTyped, 'seen');
      for (const k of LISTED) expect(await open(k, ['wTyped'])).toEqual([k, ['wTyped']]);
      expect(await words('B')).toContain('wTyped');
    });

    it('A\'s Acknowledge on a typed row and a voice row takes both out of A\'s, T\'s and B\'s inbox and the AI triage', async () => {
      await ack.applyTransition(user('A'), row.wTyped, 'acked');
      await ack.applyTransition(user('A'), row.wVoice, 'acked');
      for (const k of LISTED) {
        expect(await open(k, ['wTyped', 'wVoice'])).toEqual([k, []]);
        expect([k, (await words(k)).includes('wTyped')]).toEqual([k, false]);
      }
      expect(await words('B')).toEqual(['wPhoto', 'wTyped2']);
    });
  });
});
