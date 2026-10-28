// C6-WINS-MOVE (agent 159), owner: "history always follows the client; a former coach loses every read of a
// moved client except their own money records". A client who moves to another coach leaves the former
// coach's community: the former coach and the former coach's clients read nothing they wrote in its Hall or
// in its spaces that are not public (posts, comments, chat, voice notes, wins); public spaces stay public;
// the client keeps their own wins; the new coach's circle never sees the old circle's wins or posts. Owner rule D
// (SPACE-OWNER-ALERTS): what the client writes in a public space reaches the space owner, and also the client's
// current coach (the new coach's inbox gets M's public-space post; never N's, who has no coach).
// Live, on the replayed migration chain: the real services with the real CommunitySafetyService; row reads
// run as role authenticated. A, B coach; O and V are A's clients; M was A's client and is now B's (M keeps
// an active row in A's cli and a row in A's public space); W is B's client; N has no coach and joined A's
// public space. Each person's first read is their control read, so every 0 follows a 1.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import type { AiGatewayRequest, AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { AiTriageService } from '../../src/community/ai-triage/ai-triage.service';
import { TriageCacheService } from '../../src/community/ai-triage/triage-cache.service';
import { TRIAGE_CATEGORIES } from '../../src/community/ai-triage/triage-output.schema';
import { CommunityCohortMembersRepository } from '../../src/community/cohorts/community-cohort-members.repository';
import { CommunityCohortMembersService } from '../../src/community/cohorts/community-cohort-members.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import { CommunityCoachInboxRepository } from '../../src/community/inbox/community-coach-inbox.repository';
import { CommunityCoachInboxService } from '../../src/community/inbox/community-coach-inbox.service';
import {
  COMMENT_CONTEXT_TYPE,
  CommunityMessagesRepository,
} from '../../src/community/messages/community-messages.repository';
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
import { CommunitySearchRepository } from '../../src/community/search/community-search.repository';
import { CommunitySearchService } from '../../src/community/search/community-search.service';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import { CommunityVoiceService } from '../../src/community/voice/community-voice.service';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import type { PrismaService } from '../../src/prisma.service';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-moved-client-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'V' | 'M' | 'W' | 'N';
type Coach = 'A' | 'B';
type Space = 'cli' | 'pub' | 'bcli';
type Place = Space | 'hallA' | 'hallB';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'M', 'W', 'N']; // coaches first: clients reference them
const COACH: Record<Key, Coach | null> = { A: null, B: null, O: 'A', V: 'A', M: 'B', W: 'B', N: null };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
const SPACES: Space[] = ['cli', 'pub', 'bcli'];
const VISIBILITY: Record<Space, string> = { cli: 'clients', pub: 'public', bcli: 'clients' };
const ROWS: Record<Space, Key[]> = { cli: ['V', 'M'], pub: ['V', 'M', 'N'], bcli: [] }; // M's cli row is left from before
// The one rule (app.community_can_access): who opens each place. M is out of A's cli and Hall, row or not.
const OPENS: Record<Place, Key[]> = { hallA: ['A', 'O', 'V'], cli: ['A', 'O', 'V'], pub: ['A', 'V', 'M', 'N'],
  hallB: ['B', 'M', 'W'], bcli: ['B', 'M', 'W'] };
const COMMUNITY: Record<Place, Coach> = { hallA: 'A', cli: 'A', pub: 'A', hallB: 'B', bcli: 'B' };
const POSTS: Record<string, [Key, Place]> = { hA: ['A', 'hallA'], hO: ['O', 'hallA'], hM: ['M', 'hallA'], sO: ['O', 'cli'],
  sM: ['M', 'cli'], pM: ['M', 'pub'], pN: ['N', 'pub'], hB: ['B', 'hallB'] };
const COMMENTS: Record<string, Key> = { cO: 'O', cM: 'M' }; // on sO
const CHAT: Record<string, Key> = { mO: 'O', mM: 'M' }; // in cli
const VOICE: Record<string, Key> = { vO: 'O', vM: 'M' }; // in cli
const WINS: Record<string, [Key, Coach]> = { wO: ['O', 'A'], wM: ['M', 'A'], wM2: ['M', 'B'], wW: ['W', 'B'] }; // [author, coach_id]
const FINDS: Record<string, [Key, Place]> = { fO: ['O', 'hallA'], fM: ['M', 'hallA'], fOc: ['O', 'cli'], fMc: ['M', 'cli'],
  fMp: ['M', 'pub'], fMb: ['M', 'hallB'], fWb: ['W', 'bcli'] }; // search index rows, [author, place]
// The fix: an author stays in a place unless they are a client the place's coach no longer coaches, outside a
// public space. A person always reads their own row.
const stays = (a: Key, p: Place) => p === 'pub' || ROLE(a) === 'coach' || COACH[a] === COMMUNITY[p];
const sees = (k: Key, a: Key, p: Place) => OPENS[p].includes(k) && (a === k || stays(a, p));
const keys = <T>(rows: Record<string, T>, keep: (r: T) => boolean) => Object.keys(rows).filter((r) => keep(rows[r])).sort();
const circleOf = (k: Key): Key | null => (ROLE(k) === 'coach' ? k : COACH[k]);
const winsOf = (k: Key) => keys(WINS, ([a, c]) => a === k || (c === circleOf(k) && (a === c || COACH[a] === c)));
const boardOf = (k: Key) => [...PEOPLE].filter((p) => COACH[k] !== null && COACH[p] === COACH[k]).sort();

(DB_URL ? describe : describe.skip)('C6-WINS-MOVE: a moved client leaves the former coach\'s community', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const safety = new CommunitySafetyService(db);
  const realtime = stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined });
  const push = stub<CommunityNotificationsService>({ pushEnabled: () => false });
  const messagesRepo = new CommunityMessagesRepository(db);
  const postsRepo = new CommunityPostsRepository(db);
  const posts = new CommunityPostsService(access, postsRepo, messagesRepo, realtime, push, safety, new CommunityReactionsRepository(db));
  const chat = new CommunityMessagesService(access, messagesRepo, realtime, stub<PlanContextService>({}), safety, push);
  const voice = new CommunityVoiceService(access, new CommunityVoiceRepository(db),
    stub<VoiceUploadProvider>({ createSignedDownload: async () => 'https://voice.test/note' }), realtime,
    stub<AnalyticsService>({ capture: () => undefined }), safety);
  const members = new CommunityCohortMembersService(access, new CommunityCohortMembersRepository(db), safety);
  const community = new CommunityService(db, new CommunityRepository(db), safety);
  const moderation = new CommunityModerationService(access, new CommunityModerationRepository(db), messagesRepo, postsRepo, realtime,
    push, db, stub<VoiceUploadProvider>({}));
  const uuids = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids([...PEOPLE, ...Object.keys(POSTS), ...Object.keys(COMMENTS), ...Object.keys(CHAT), ...Object.keys(VOICE),
    ...Object.keys(WINS), ...Object.keys(FINDS)]);
  const KEY = Object.fromEntries(Object.entries(id).map(([k, v]) => [v, k]));
  const sub = uuids(PEOPLE);
  const ws = uuids(['A', 'B'] as const);
  const space = uuids(SPACES);
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as Coach] : null });
  const where = (p: Place) => (p === 'hallA' || p === 'hallB' ? null : space[p]);
  const wsOf = (p: Place) => ws[COMMUNITY[p]];

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  // "id" is uuid on the three community tables and text on CommunityWin and the search index, so compare as text.
  const count = (k: Key, table: string, row: string) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id"::text = $1`, id[row]))
      .then((r) => r[0].n);
  // The keys a read hands the person, sorted; null when it answers 404.
  const read = async <T>(p: Promise<T>, ids: (r: T) => string[]): Promise<string[] | null> => {
    try {
      return ids(await p).map((v) => String(KEY[v])).sort();
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  };
  const byId = async (list: string[], one: (row: string) => Promise<unknown>) => {
    const got: string[] = [];
    for (const row of list) if ((await read(one(row), () => [])) !== null) got.push(row);
    return got.sort();
  };
  const inSpace = (k: Key, p: Place, rows: Record<string, Key>) => (OPENS[p].includes(k) ? keys(rows, (a) => sees(k, a, p)) : null);
  const postsIn = (c: Coach) => Object.fromEntries(Object.entries(POSTS).filter(([, [, p]]) => COMMUNITY[p] === c));

  // Every read of what a person wrote in a community (the PR body's rule list), as [path, read, want, clients only].
  type Read = [string, (k: Key) => Promise<string[] | null>, (k: Key) => string[] | null, boolean?];
  const READS: Read[] = [
    ...(['A', 'B'] as const).map((c): Read => [`the Hall of ${c}`,
      (k) => read(posts.list(user(k), ws[c], {}), (r) => r.posts.map((p) => p.id)),
      (k) => (OPENS[c === 'A' ? 'hallA' : 'hallB'].includes(k) ? keys(postsIn(c), ([a, p]) => sees(k, a, p)) : null)]),
    ['a post by id', (k) => byId(Object.keys(POSTS), (r) => posts.getOne(user(k), id[r])), (k) => keys(POSTS, ([a, p]) => sees(k, a, p))],
    ['the comments on sO', (k) => read(posts.listComments(user(k), id.sO), (r) => r.comments.map((c) => c.id)), (k) => inSpace(k, 'cli', COMMENTS)],
    ['the chat of cli', (k) => read(chat.list(user(k), space.cli, {}), (r) => r.messages.map((m) => m.id)), (k) => inSpace(k, 'cli', CHAT)],
    ['a chat message by id', (k) => byId(Object.keys(CHAT), (r) => chat.getOne(user(k), id[r])), (k) => inSpace(k, 'cli', CHAT) ?? []],
    ['the voice notes of cli', (k) => read(voice.list(user(k), ws.A, { cohort_id: space.cli }), (r) => r.voice_notes.map((v) => v.id)),
      (k) => inSpace(k, 'cli', VOICE)],
    ['a voice note by id', (k) => byId(Object.keys(VOICE), (r) => voice.getOne(user(k), id[r])), (k) => inSpace(k, 'cli', VOICE) ?? []],
    ['wins', (k) => read(community.getFeed(id[k]), (r) => r.map((w) => w.id)), winsOf],
    ['the leaderboard', (k) => read(community.getLeaderboard(id[k]), (r) => r.map((e) => e.user_id)), boardOf, true],
    // A report puts the row in front of the workspace's moderators, so it is a read too.
    ['report a post by id', (k) => byId(Object.keys(POSTS), (r) => moderation.report(user(k), 'post', id[r], 'spam', undefined)),
      (k) => keys(POSTS, ([a, p]) => sees(k, a, p))],
    ['report a chat message by id', (k) => byId(Object.keys(CHAT), (r) => moderation.report(user(k), 'message', id[r], 'spam', undefined)),
      (k) => inSpace(k, 'cli', CHAT) ?? []],
    ['report a voice note by id', (k) => byId(Object.keys(VOICE), (r) => moderation.report(user(k), 'voice_note', id[r], 'spam', undefined)),
      (k) => inSpace(k, 'cli', VOICE) ?? []],
    ['report a win by id', (k) => byId(Object.keys(WINS), (r) => moderation.report(user(k), 'win', id[r], 'spam', undefined)), winsOf],
  ];
  const CONTROL: Record<Key, string> = { A: 'the Hall of A', B: 'the Hall of B', O: 'the Hall of A', V: 'the Hall of A',
    M: 'the Hall of B', W: 'the Hall of B', N: 'a post by id' };

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id", "show_on_leaderboard")
        VALUES (${id[k]}, ${sub[k]}, ${`moved-${id[k]}`}, ${`RLS person ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as Coach] : null}, true)`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`moved-${run}-${c}`}, now())`;
    }
    for (const s of SPACES) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], wsOf(s), `RLS ${s}`, VISIBILITY[s]);
      for (const k of ROWS[s]) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), wsOf(s), space[s], id[k]);
      }
    }
    for (const [key, [a, p]] of Object.entries(POSTS)) {
      await prisma.communityPost.create({ data: { id: id[key], workspace_id: wsOf(p), cohort_id: where(p), author_id: id[a],
        scope: where(p) ? 'cohort' : 'hall', title: `RLS post ${key}` } });
    }
    for (const [key, a] of Object.entries(COMMENTS)) {
      await prisma.communityMessage.create({ data: { id: id[key], workspace_id: ws.A, cohort_id: space.cli, scope: 'cohort',
        sender_id: id[a], body: `RLS comment ${key}`, plan_context_type: COMMENT_CONTEXT_TYPE, plan_context_id: id.sO } });
    }
    for (const [key, a] of Object.entries(CHAT)) {
      await prisma.communityMessage.create({ data: { id: id[key], workspace_id: ws.A, cohort_id: space.cli, scope: 'cohort',
        sender_id: id[a], body: `RLS chat ${key}` } });
    }
    for (const [key, a] of Object.entries(VOICE)) {
      await prisma.communityVoiceNote.create({ data: { id: id[key], workspace_id: ws.A, cohort_id: space.cli, author_id: id[a],
        storage_key: `${id[a]}/1700000000000-0123456789abcdef.m4a`, duration_ms: 5000, bytes: BigInt(1000), mime_type: 'audio/mp4' } });
    }
    for (const [key, [a, c]] of Object.entries(WINS)) {
      await prisma.communityWin.create({ data: { id: id[key], user_id: id[a], coach_id: id[c], title: 'RLS win', description: 'RLS win' } });
    }
    for (const [key, [a, p]] of Object.entries(FINDS)) {
      await prisma.communitySearchEntry.create({ data: { id: id[key], workspaceId: wsOf(p), cohortId: where(p), kind: 'post',
        targetId: id[key], authorId: id[a], excerpt: `kettlebell ${key}`, visibleToRoles: ['coach', 'assistant', 'student'] } });
    }
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security, on tables that force it', async () => {
    expect(await as('V', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    const tables = ['CommunityWin', 'community_messages', 'community_posts', 'community_search_entries', 'community_voice_notes'];
    const forced = await prisma.$queryRaw<{ t: string }[]>`SELECT c."relname" AS "t" FROM pg_class c JOIN pg_namespace n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relname" = ANY(${tables}) AND c."relrowsecurity" AND c."relforcerowsecurity"`;
    expect(forced.map((r) => r.t).sort()).toEqual([...tables].sort());
  });

  it('every read of what a person wrote follows the client (control read first)', async () => {
    for (const k of PEOPLE) {
      const mine = READS.filter(([, , , clientsOnly]) => !clientsOnly || ROLE(k) === 'student');
      const order = [...mine.filter(([path]) => path === CONTROL[k]), ...mine.filter(([path]) => path !== CONTROL[k])];
      const first = await order[0][1](k);
      expect({ who: k, control: order[0][0], got: (first ?? []).length > 0 }).toEqual({ who: k, control: CONTROL[k], got: true });
      const seen: Record<string, string[] | null> = { [order[0][0]]: first };
      for (const [path, take] of order.slice(1)) seen[path] = await take(k);
      expect({ who: k, seen }).toEqual({ who: k, seen: Object.fromEntries(order.map(([path, , want]) => [path, want(k)])) });
    }
  });

  // C6-MOVED-PRIVILEGED-READS: the coach inbox (and the AI triage, which reads through the same repository)
  // leaves the moved client out in the query. Control first: O's chat and post in cli (1 each).
  it('the former coach\'s inbox leaves the moved client out of cli; the public space stays', async () => {
    const inbox = new CommunityCoachInboxService(access, new CommunityCoachInboxRepository(db));
    const got = await read(inbox.list(user('A'), {}), (r) => r.items.map((i) => i.id));
    expect({ mO: got?.includes('mO'), sO: got?.includes('sO') }).toEqual({ mO: true, sO: true });
    expect(got).toEqual(['mO', 'pM', 'pN', 'sO']); // mM and sM: 0; M's post in the public space stays
    const page = new CommunityCoachInboxRepository(db);
    const one = await page.unansweredMessages({ cohortIds: [space.cli], limit: 1, after: null });
    expect(one.map((m) => KEY[m.id])).toEqual(['mO']); // a page of 1 is O's, whichever row is older
  });

  // Rule D: the new coach's inbox holds M's post in A's public space (1); N's post there (no coach) is not B's (0).
  it('the new coach\'s inbox gets the moved client\'s public-space post, and nobody else\'s from that space', async () => {
    const inbox = new CommunityCoachInboxService(access, new CommunityCoachInboxRepository(db));
    expect(await read(inbox.list(user('B'), {}), (r) => r.items.map((i) => i.id))).toEqual(['pM']);
  });

  it('the inbox reads under forced row security agree: the former coach reads 1 of O, then 0 of M', async () => {
    const seen = await as('A', async (tx) => {
      const repo = new CommunityCoachInboxRepository(stub<PrismaService>(tx));
      const chatRows = await repo.unansweredMessages({ cohortIds: [space.cli], limit: 50, after: null });
      const postRows = await repo.unansweredPosts({ cohortIds: [space.cli], limit: 50, after: null });
      return [...chatRows, ...postRows].map((r) => String(KEY[r.id])).sort();
    });
    expect(seen).toEqual(['mO', 'sO']);
  });

  // C6-AI-TRIAGE: the former coach's AI triage takes its candidates from the inbox's two reads, so the moved
  // client's words and name reach neither the prompt, the consent list nor the answer. The fake model names every
  // seeded row (an id the reads did not hand over is dropped). Comments and Hall posts are never candidates.
  const kind = (r: string) => (r in POSTS ? 'post' : r in CHAT ? 'chat' : 'comment');
  const triageOf = (reads: PrismaService, repo = new CommunityCoachInboxRepository(reads)) => {
    const sent: AiGatewayRequest[] = [];
    const rows = [...Object.keys(POSTS), ...Object.keys(COMMENTS), ...Object.keys(CHAT)];
    const items = rows.map((r) => ({ source_item_id: id[r], source_kind: kind(r) === 'post' ? 'post' : 'message',
      category: 'general', summary: ' ' }));
    const reply = JSON.stringify({ buckets: TRIAGE_CATEGORIES.map((category) => ({ category, items: category === 'general' ? items : [] })) });
    const gateway = stub<AiGatewayService>({ invoke: async (req: AiGatewayRequest) => {
      sent.push(req);
      return { reply, model: 'fake' };
    } });
    const triage = new AiTriageService(gateway, repo, new CommunityAccessService(reads), new TriageCacheService(), grantAllEgress());
    return async () => {
      const answer = await triage.generateForCoach(user('A'));
      const prompt = sent[sent.length - 1]?.userMessage ?? '';
      return { calls: sent.length, sent: rows.filter((r) => prompt.includes(id[r])).sort(),
        words: rows.filter((r) => prompt.includes(`RLS ${kind(r)} ${r}`)).sort(),
        clients: (sent[sent.length - 1]?.dataClientIds ?? []).map((v) => String(KEY[v])).sort(),
        answer: answer.source_item_ids.map((v) => String(KEY[v])).sort(),
        nameOfM: [prompt, JSON.stringify(answer.buckets)].map((t) => t.split('RLS person M').length - 1) };
    };
  };

  it('the former coach\'s AI triage: the moved client is in it before the move, out after it, never from the cache', async () => {
    const triage = triageOf(db);
    const coachOfM = (coach: string | null) => prisma.user.update({ where: { id: id.M }, data: { coach_id: coach } });
    const before = ['mM', 'mO', 'pM', 'pN', 'sM', 'sO'];
    const after = ['mO', 'pM', 'pN', 'sO']; // M's post in the public space stays, as in the inbox
    const want = (calls: number, ids: string[], m: number) => ({ calls, sent: ids, words: ids, clients: ['M', 'N', 'O'],
      answer: ids, nameOfM: [m, m] });
    try {
      await coachOfM(id.A); // control: before the move M is A's client, so M's chat and post in cli are in (1 each)
      expect(await triage()).toEqual(want(1, before, 3));
      await coachOfM(null); // M leaves A for no coach: a fresh prompt without M's cli rows (0)
      expect(await triage()).toEqual(want(2, after, 1));
    } finally {
      await coachOfM(id.B); // the world's state: M is B's client
    }
    expect(await triage()).toEqual(want(2, after, 1)); // the same four items: the cache answers, still without M's cli rows
  });

  it('the AI triage reads under forced row security agree: the former coach reads 1 of O, then 0 of M', async () => {
    // cli only: as authenticated a coach reads only current clients' User rows (20270502000000); the server
    // connects as service_role, so the public space's authors are proven on the app connection above.
    const got = await as('A', (tx) => {
      const reads = stub<PrismaService>(tx);
      return triageOf(reads, Object.assign(new CommunityCoachInboxRepository(reads), { coachedCohortIds: async () => [space.cli] }))();
    });
    expect(got).toEqual({ calls: 1, sent: ['mO', 'sO'], words: ['mO', 'sO'], clients: ['O'], answer: ['mO', 'sO'], nameOfM: [0, 0] });
  });

  it('the former coach\'s roster of cli leaves the moved client out', async () => {
    const roster = await read(members.list(user('A'), space.cli, {}), (r) => r.members.map((m) => m.user_id));
    expect({ O: roster?.includes('O'), V: roster?.includes('V'), M: roster?.includes('M') }).toEqual({ O: true, V: true, M: false });
  });

  // C6-MOVED-SEARCH: community search asks the same rule in its query. Control first: while M is A's client,
  // A, O and V find M's Hall and cli rows (1 each); after the move they do not (0), the public space stays,
  // and M's new community finds M. Everyone else is answered 404.
  it('community search follows the client: found before the move, not by the old circle after it, found by the new', async () => {
    const search = new CommunitySearchService(new CommunitySearchRepository(db), access,
      stub<AnalyticsService>({ capture: () => undefined }), safety);
    const find = (k: Key, c: Coach) => read(search.search(user(k), ws[c], { q: 'kettlebell' }), (r) => r.results.map((f) => f.targetId));
    const inWs = (c: Coach, keep: (a: Key, p: Place) => boolean) => keys(FINDS, ([a, p]) => COMMUNITY[p] === c && keep(a, p));
    try {
      await prisma.user.update({ where: { id: id.M }, data: { coach_id: id.A } });
      for (const k of ['A', 'O', 'V'] as const) {
        expect({ k, got: await find(k, 'A') }).toEqual({ k, got: inWs('A', (_a, p) => OPENS[p].includes(k)) });
      }
    } finally {
      await prisma.user.update({ where: { id: id.M }, data: { coach_id: id.B } });
    }
    for (const k of PEOPLE) {
      for (const c of ['A', 'B'] as const) {
        const want = OPENS[c === 'A' ? 'hallA' : 'hallB'].includes(k) ? inWs(c, (a, p) => sees(k, a, p)) : null;
        expect({ k, c, got: await find(k, c) }).toEqual({ k, c, got: want });
      }
    }
  });

  // The row layer: [viewer, table, row, rows read]; each viewer's first read is a 1.
  const ROW_READS: Array<[Key, Array<[string, string, 0 | 1]>]> = [
    ...(['A', 'V'] as const).map((k): [Key, Array<[string, string, 0 | 1]>] => [k, [
      ['community_posts', 'hO', 1], ['community_posts', 'hM', 0], ['community_posts', 'sM', 0], ['community_posts', 'pM', 1],
      ['community_messages', 'cO', 1], ['community_messages', 'cM', 0], ['community_messages', 'mO', 1], ['community_messages', 'mM', 0],
      ['community_voice_notes', 'vO', 1], ['community_voice_notes', 'vM', 0], ['CommunityWin', 'wO', 1], ['CommunityWin', 'wM', 0],
      ['community_search_entries', 'fO', 1], ['community_search_entries', 'fM', 0], ['community_search_entries', 'fMc', 0],
      ['community_search_entries', 'fMp', 1]]]),
    ['B', [['community_posts', 'hB', 1], ['community_posts', 'pM', 1], ['community_posts', 'pN', 0], ['community_posts', 'hA', 0],
      ['community_posts', 'hO', 0], ['community_posts', 'sO', 0],
      ['community_messages', 'mO', 0], ['community_voice_notes', 'vO', 0], ['community_search_entries', 'fMb', 1],
      ['community_search_entries', 'fO', 0]]],
    ['W', [['CommunityWin', 'wW', 1], ['CommunityWin', 'wM', 0], ['community_posts', 'hM', 0], ['community_posts', 'hO', 0],
      ['community_search_entries', 'fMb', 1]]],
    ['M', [['CommunityWin', 'wM', 1], ['CommunityWin', 'wM2', 1], ['community_search_entries', 'fMb', 1]]],
  ];

  it('the row layer agrees: the former coach and circle read 0 of the moved client, the new coach 0 of the old community', async () => {
    // Rule D: but for M's post in the public space (B's ROW_READS: pM 1, pN 0).
    for (const [k, rows] of ROW_READS) {
      expect(rows[0][2]).toBe(1);
      const seen: string[] = [];
      for (const [table, row] of rows) seen.push(`${table} ${row} ${await count(k, table, row)}`);
      expect({ who: k, seen }).toEqual({ who: k, seen: rows.map(([table, row, n]) => `${table} ${row} ${n}`) });
    }
  });
});
