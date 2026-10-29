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
import { CommunityLeaveMuteService } from '../../src/community/leave-mute/community-leave-mute.service';
import { COMMENT_CONTEXT_TYPE, CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import { CommunityModerationRepository } from '../../src/community/moderation/community-moderation.repository';
import { CommunityModerationService } from '../../src/community/moderation/community-moderation.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityPostsService } from '../../src/community/posts/community-posts.service';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import { CommunityVoiceService } from '../../src/community/voice/community-voice.service';
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
  const chat = new CommunityMessagesService(access, messages, stub<CommunityRealtimeService>({}),
    stub<PlanContextService>({}), safety, stub<CommunityNotificationsService>({}));
  const voice = new CommunityVoiceService(access, notes,
    stub<VoiceUploadProvider>({ createSignedDownload: async () => 'https://voice.test/note' }),
    stub<CommunityRealtimeService>({}), stub<AnalyticsService>({}), safety);
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

  describe('LS-1173R3 independent current-reader audit', () => {
    it('leaving a public space keeps the current coach historical rows readable and in the open inbox', async () => {
      const quiet = new CommunityLeaveMuteService(db, access, safety,
        stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined }));
      expect((await inbox.rows(user('B'))).rows.map((r) => r.message_id)).toContain(row.wTyped);
      expect(await count('B', 'community_messages', row.wTyped)).toBe(1);
      try {
        await quiet.leave(user('W'), space.P);
        expect((await inbox.rows(user('B'))).rows.map((r) => r.message_id)).toContain(row.wTyped);
        expect(await refused(chat.getOne(user('B'), row.wTyped))).toBe('ok');
        expect(await count('B', 'community_messages', row.wTyped)).toBe(1);
      } finally {
        await quiet.join(user('W'), space.P);
      }
    });

    it('transfer revokes each outside API read and SQL word read, and grants the new coach without joining', async () => {
      const readAll = async (k: Key) => [
        await refused(chat.getOne(user(k), row.wPhoto)),
        await refused(voice.getOne(user(k), row.wVoice)),
        await refused(posts.getOne(user(k), row.wPost)),
      ];
      expect(await readAll('B')).toEqual(['ok', 'ok', 'ok']);
      expect(await readAll('C')).toEqual([404, 404, 404]);
      for (const [table, target] of [
        ['community_messages', row.wPhoto],
        ['community_voice_notes', row.wVoice],
        ['community_posts', row.wPost],
      ]) expect(await count('B', table, target)).toBe(1);
      try {
        await prisma.user.update({ where: { id: id.W }, data: { coach_id: id.C } });
        expect(await readAll('B')).toEqual([404, 404, 404]);
        expect(await readAll('C')).toEqual(['ok', 'ok', 'ok']);
        for (const [table, target] of [
          ['community_messages', row.wPhoto],
          ['community_voice_notes', row.wVoice],
          ['community_posts', row.wPost],
        ]) {
          expect(await count('C', table, target)).toBe(1);
          expect(await count('B', table, target)).toBe(0);
        }
        expect(await refused(ack.applyTransition(user('B'), row.wPhoto, 'seen'))).toBe(404);
        expect(await prisma.communityMembership.count({ where: { cohort_id: space.P, user_id: { in: [id.B, id.C] } } })).toBe(0);
      } finally {
        await prisma.user.update({ where: { id: id.W }, data: { coach_id: id.B } });
      }
    });

    it('a same-client reply quote remains readable, but a block revokes row, quote and acknowledgement together', async () => {
      const parentId = await say('W', 'audit parent');
      const reply = await prisma.communityMessage.create({ data: {
        workspace_id: ws.A, cohort_id: space.P, scope: 'cohort', sender_id: id.W,
        body: 'audit reply', parent_message_id: parentId,
        parent_message_at: (await prisma.communityMessage.findFirstOrThrow({ where: { id: parentId } })).created_at,
      } });
      expect((await chat.getOne(user('B'), reply.id)).message.parent).toMatchObject({ id: parentId, gone: false, snippet: 'audit parent' });
      expect(await count('B', 'community_messages', reply.id)).toBe(1);
      const blocked = await prisma.userBlock.create({ data: { blocker_id: id.W, blocked_id: id.B } });
      try {
        expect(await refused(chat.getOne(user('B'), reply.id))).toBe(404);
        expect(await refused(ack.applyTransition(user('B'), reply.id, 'acked'))).toBe(404);
        expect(await count('B', 'community_messages', reply.id)).toBe(0);
      } finally {
        await prisma.userBlock.delete({ where: { id: blocked.id } });
        await prisma.communityMessage.deleteMany({ where: { id: { in: [parentId, reply.id] } } });
      }
    });

    it('outside readers receive no unrelated photo quote or signed photo, while an ordinary member still does', async () => {
      const parentId = await say('O', '', 'image');
      await prisma.communityMessageImage.create({ data: { message_id: parentId, cohort_id: space.P, author_id: id.O,
        storage_key: `${id.O}/${parentId}.jpg`, width: 4, height: 3, size_bytes: 100, mime: 'image/jpeg' } });
      const parent = await prisma.communityMessage.findFirstOrThrow({ where: { id: parentId } });
      const reply = await prisma.communityMessage.create({ data: {
        workspace_id: ws.A, cohort_id: space.P, scope: 'cohort', sender_id: id.W,
        body: 'audit own reply', parent_message_id: parentId, parent_message_at: parent.created_at,
      } });
      const sign = jest.fn(async () => 'https://image.test/audit');
      const reader = new CommunityMessagesService(access, messages, stub<CommunityRealtimeService>({}),
        stub<PlanContextService>({}), safety, stub<CommunityNotificationsService>({}), stub({ createSignedDownload: sign }));
      try {
        expect((await reader.getOne(user('T'), reply.id)).message.parent).toMatchObject({ id: parentId, gone: false, kind: 'image' });
        expect(sign).toHaveBeenCalledTimes(1);
        sign.mockClear();
        expect((await reader.getOne(user('B'), reply.id)).message.parent).toEqual({
          id: parentId, gone: true, kind: null, sender_name: null, snippet: null, voice_duration_ms: null,
        });
        expect(sign).not.toHaveBeenCalled();
      } finally {
        await prisma.communityMessageImage.deleteMany({ where: { message_id: parentId } });
        await prisma.communityMessage.deleteMany({ where: { id: { in: [parentId, reply.id] } } });
      }
    });
  });

  it('runs as a role that does not bypass row security, on tables that force it', async () => {
    expect(await as('W', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    const tables = ['community_messages', 'community_voice_notes', 'community_posts', 'community_message_images'];
    const forced = await prisma.$queryRaw<{ t: string }[]>`SELECT c."relname" AS "t" FROM pg_class c JOIN pg_namespace n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relname" = ANY(${tables}) AND c."relrowsecurity" AND c."relforcerowsecurity"`;
    expect(forced.map((r) => r.t).sort()).toEqual([...tables].sort());
  });

  // LS-1173R2: the SQL grant is not enough. Exercise the service reached by
  // the phone's detail/playback request, with the same real author relationship.
  describe('B2 carried: the own coach opens each row their inbox lists', () => {
    it.each(['wTyped', 'wPhoto', 'wVoice'])('%s opens for the own coach, not just the space owner', async (key) => {
      expect(await rows('B')).toContain(key);
      const open = async (k: Key) => key === 'wVoice'
        ? (await voice.getOne(user(k), row[key])).voice_note.id
        : (await chat.getOne(user(k), row[key])).message.id;
      expect(await open('A')).toBe(row[key]); // the storage and row are usable
      await expect(open('B')).resolves.toBe(row[key]);
      expect(await refused(open('C'))).toBe(404);
    });

    // FR-1173R2: that row only. A reply by W quoting N (not B's client) shows B no words of N's; quoting W's own
    // row it shows them. The space's owner still sees both quotes.
    it('the own coach sees a quoted message only when it is a row of theirs to read', async () => {
      const reply = (parent: string) => prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.P,
        scope: 'cohort', kind: 'text', sender_id: id.W, body: 'a reply', parent_message_id: parent } });
      const made = [await reply(row.nTyped), await reply(row.wTyped)];
      try {
        const quote = async (k: Key, m: string) => (await chat.getOne(user(k), m)).message.parent;
        expect(await quote('B', made[0].id)).toEqual(expect.objectContaining({ id: row.nTyped, gone: true, snippet: null }));
        expect(await quote('B', made[1].id)).toEqual(expect.objectContaining({ id: row.wTyped, gone: false, snippet: 'typed one' }));
        expect(await quote('A', made[0].id)).toEqual(expect.objectContaining({ id: row.nTyped, gone: false, snippet: 'typed by N' }));
        expect(await refused(chat.getOne(user('C'), made[1].id))).toBe(404);
      } finally {
        await prisma.communityMessage.deleteMany({ where: { id: { in: made.map((m) => m.id) } } });
      }
    });

    it('a removed row stays the space\'s: its placeholder does not open outside', async () => {
      await prisma.communityMessage.updateMany({ where: { id: row.wTyped2 }, data: { deleted_at: new Date(), removed_by_user_id: id.A } });
      try {
        expect(await refused(chat.getOne(user('B'), row.wTyped2))).toBe(404);
        expect((await chat.getOne(user('A'), row.wTyped2)).message.id).toBe(row.wTyped2);
      } finally {
        await prisma.communityMessage.updateMany({ where: { id: row.wTyped2 }, data: { deleted_at: null, removed_by_user_id: null } });
      }
    });
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

  // B1 (LS-INBOX2): the report queue read only the coach who runs the community. Rule D sends the report on a
  // public-space row to the owner's team and the poster's own coach too, to read, once each; Hide, Warn, Ban and
  // Dismiss stay the owner's. A report in a space that is not public stays the owner's alone.
  describe('B1: the report queue for a public-space row', () => {
    const rep: Record<string, string> = {};
    const t0 = Date.now() - 60_000; // one second apart, so oldest-first and newest-first are defined
    const report = async (type: 'message' | 'post' | 'voice_note', target: string, by: Key, n: number) =>
      (await prisma.communityModerationAction.create({ data: { workspace_id: ws.A, target_type: type, target_id: target,
        reported_by_id: id[by], reason: 'harassment', notes: `report by ${by}`, created_at: new Date(t0 + n * 1000) } })).id;
    // FR-1173R2 (LO-1173R2 B1): the reports a rule D reader may only read come on the flagged route when asked for.
    const flagged = async (k: Key) => (await moderation.listFlagged(user(k), { read_only: '1' })).items;
    const actable = async (k: Key) => (await moderation.listFlagged(user(k), {})).items;
    const view = (keys: string[], canAct: boolean) => keys.map((k) => expect.objectContaining({ id: rep[k], can_act: canAct }));
    const queue = async (k: Key) => (await moderation.listQueue(user(k), ws.A, {})).items
      .map((i) => `${Object.entries(rep).find(([, v]) => v === i.id)?.[0]} ${PEOPLE.find((k) => id[k] === i.reported_by_user_id) ?? 'none'}`);

    beforeAll(async () => {
      rep.w = await report('message', row.wTyped2, 'O', 1);
      rep.n = await report('post', row.nPost, 'O', 2);
      rep.s = await report('message', row.oS, 'O', 3);
      rep.v = await report('voice_note', row.wVoice, 'O', 4);
      rep.o = await report('message', row.oTyped, 'N', 5);
    });

    it('the coach who runs the community gets every report once, and may act on each (control)', async () => {
      expect(await flagged('A')).toEqual(view(['w', 'n', 's', 'v', 'o'], true));
    });

    it('the owner\'s team in P gets the reports on P\'s rows, to read; not the clients space\'s', async () => {
      expect(await flagged('T')).toEqual(view(['w', 'n', 'v', 'o'], false));
    });

    it('the flagged route by default (the shipped phone): the owner gets every report, the readers none', async () => {
      expect([await actable('A'), await actable('T'), await actable('B')]).toEqual([view(['w', 'n', 's', 'v', 'o'], true), [], []]);
    });

    it('W\'s own coach gets the reports on W\'s rows only, to read; an unrelated coach gets none', async () => {
      expect(await flagged('B')).toEqual(view(['w', 'v'], false));
      expect(await flagged('C')).toEqual([]);
    });

    it('the community\'s queue: the same rows for the team and the own coach, the reporter withheld; others still 403', async () => {
      expect(await queue('A')).toEqual(['o N', 'v O', 's O', 'n O', 'w O']); // newest first
      expect(await queue('T')).toEqual(['o none', 'v none', 'n none', 'w none']);
      expect(await queue('B')).toEqual(['v none', 'w none']);
      expect(await refused(moderation.listQueue(user('C'), ws.A, {}))).toBe(403);
    });

    it('reading is not acting: Hide and Dismiss stay the owner\'s (the same 404 as anyone outside), every report open', async () => {
      expect(await refused(moderation.act(user('B'), rep.w, 'hide', undefined))).toBe(404);
      expect(await refused(moderation.act(user('T'), rep.n, 'dismiss', undefined))).toBe(404);
      expect(await prisma.communityModerationAction.count({ where: { id: { in: Object.values(rep) }, status: 'open' } })).toBe(5);
    });

    it('a ban on the own coach in A\'s community takes the reports away too (B4); lifted, they are back', async () => {
      await ban('B', 'A', null);
      expect([await flagged('B'), await refused(moderation.listQueue(user('B'), ws.A, {}))]).toEqual([[], 403]);
      await ban('B', 'A', new Date());
      expect(await flagged('B')).toEqual(view(['w', 'v'], false));
    });

    it('B5: banning the author also removes that author\'s reported words and playback from Rule D readers', async () => {
      expect(await flagged('B')).toEqual(view(['w', 'v'], false));
      expect(await queue('B')).toEqual(['v none', 'w none']);
      try {
        await ban('W', 'A', null);
        // Controls: the same reader's SQL grant and ordinary inbox have lost
        // this author's rows. The read-only report route must not restore them.
        expect(await count('B', 'community_messages', row.wTyped2)).toBe(0);
        expect(await count('B', 'community_voice_notes', row.wVoice)).toBe(0);
        expect(await rows('B')).not.toContain('wTyped2');
        const read = await flagged('B');
        expect({
          flagged: read.map((r) => ({ id: r.id, content: r.content, media: r.media })),
          queue: await queue('B'),
        }).toEqual({ flagged: [], queue: [] });
      } finally {
        await ban('W', 'A', new Date());
      }
      expect(await flagged('B')).toEqual(view(['w', 'v'], false));
    });
  });

  // B2 (LS-INBOX2; LO-INBOX2 C1): the inbox lists a public-space row to the owner's team and the poster's own coach,
  // but the ack let in only the coach who runs the community, and the post read and the photo's row only a space
  // member. One row-scoped rule now (CommunityAccessService.isPublicRowOfMyClient, its SQL twin in 20270502009800):
  // this one row to its author's coach, read only, never the space or anyone else's rows, never while banned there.
  describe('B2: whoever the inbox lists a row to can open it and acknowledge it', () => {
    it('acknowledge: the owner\'s team (T) and W\'s own coach (B) may, and it clears the row for everyone', async () => {
      expect(await refused(ack.applyTransition(user('C'), row.wTyped2, 'acked'))).toBe(404);
      expect(await refused(ack.applyTransition(user('B'), row.nTyped, 'acked'))).toBe(404); // not B's client
      expect(await refused(ack.applyTransition(user('B'), row.wTyped2, 'acked'))).toBe('ok');
      expect(await refused(ack.applyTransition(user('T'), row.nTyped, 'acked'))).toBe('ok');
      for (const k of LISTED) expect([k, (await rows(k)).filter((r) => r === 'wTyped2' || r === 'nTyped')]).toEqual([k, []]);
    });

    it('open a post: B reads W\'s post and only W\'s own comments on it; T, on A\'s team, reads the whole thread', async () => {
      expect((await posts.getOne(user('B'), row.wPost)).post.id).toBe(row.wPost);
      expect((await posts.listComments(user('B'), row.wPost)).comments.map((c) => label(c.id))).toEqual(['cW']);
      expect((await posts.listComments(user('T'), row.wPost)).comments.map((c) => label(c.id)).sort()).toEqual(['cN', 'cO', 'cW']);
    });

    it('row-scoped: not another author\'s post, not for an unrelated coach, never a write, never while banned there', async () => {
      expect(await refused(posts.getOne(user('B'), row.nPost))).toBe(404);
      expect(await refused(posts.getOne(user('C'), row.wPost))).toBe(404);
      expect(await refused(posts.listComments(user('C'), row.wPost))).toBe(404);
      expect(await refused(posts.addComment(user('B'), row.wPost, 'hello from the coach'))).toBe(404);
      await ban('B', 'A', null);
      expect([await refused(posts.getOne(user('B'), row.wPost)), await refused(ack.applyTransition(user('B'), row.wPhoto, 'acked'))])
        .toEqual([404, 404]);
      await ban('B', 'A', new Date());
    });

    it('the photo\'s row: A, T and W\'s own coach B read W\'s image row; the unrelated coach C reads none', async () => {
      const image = (k: Key) => count(k, 'community_message_images', row.wPhoto, 'message_id');
      expect([await image('A'), await image('T'), await image('B'), await image('C')]).toEqual([1, 1, 1, 0]);
      await ban('B', 'A', null);
      expect(await image('B')).toBe(0);
      await ban('B', 'A', new Date());
    });
  });
});
