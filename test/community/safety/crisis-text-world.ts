/**
 * CRISIS-STAFF-OFF-BE (operator 203): the crisis table's world, moved here unchanged from
 * community-crisis-text.table.spec.ts (its world() and PATHS, the ROT13 samples, the ids and asSent) so that spec and
 * crisis-staff-off.spec.ts drive one copy. Only `export` was added. Samples stay ROT13-encoded and are described,
 * never quoted ([R22]).
 */
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { ArgumentsHost } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityPostsService } from '../../../src/community/posts/community-posts.service';
import { COMMENT_CONTEXT_TYPE } from '../../../src/community/messages/community-messages.repository';
import { CHALLENGE_COMMENT_CONTEXT_TYPE } from '../../../src/community/challenges/community-challenges.repository';
import { CommunityDmsService } from '../../../src/community/dms/community-dms.service';
import { CommunityChallengesService } from '../../../src/community/challenges/community-challenges.service';
import { CommunityService } from '../../../src/community/community.service';
import { HttpExceptionFilter } from '../../../src/filters/http-exception.filter';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';

export const rot13 = (s: string): string =>
  s.replace(/[a-z]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));
export const stub = <T>(v: unknown): T => v as T;

// A first-person statement of wanting to stop living (class self_harm).
export const SELF_HARM = rot13('ubarfgyl gurer vf ab ernfba gb xrrc tbvat nalzber');
// A person described as unresponsive right now (class emergency).
export const EMERGENCY = rot13('zl oebgure vf pbzcyrgryl haerfcbafvir ba gur tlz sybbe');
// Ordinary gym chat, no class at all.
export const ORDINARY = 'Leg day done, new squat best today';
// A figure of speech about too much of a supplement, which the lists narrow out (NOT_A_SUBSTANCE, ai-crisis-router.ts:52).
export const GYM_SUPPLEMENT = rot13('v guvax v bireqbfrq ba perngvar guvf zbeavat');
// Breathing during a named training activity, which the lists narrow out (ACTIVITY, ai-crisis-router.ts:67).
export const GYM_ACTIVITY = rot13('vg tbg uneq gb oerngur juvyr ehaavat gur uvyy gbqnl');
// A weight-loss medicine with a red-flag symptom (class urgent_symptoms).
export const URGENT = rot13('fgnegrq zbhawneb ynfg jrrx naq abguvat fgnlf qbja');
// A stated multi-day fast (class eating_disorder_risk).
export const EATING = rot13('tbvat gb snfg sbe guerr qnlf nsgre gur ubyvqnl');
// One term the word list refuses (also ROT13 in community-content-filter.ts).
export const REFUSED_TERM = rot13('ovgpu');
export const REFUSED_MATCH = `${SELF_HARM} ${REFUSED_TERM}`;
export const REFUSED_ORDINARY = `${ORDINARY} ${REFUSED_TERM}`;

export const TOKEN = 'ExponentPushToken[crisistextbe00000001]';
export const ZONE = 'America/New_York';
export const DAY = new Date('2026-06-02T18:00:00Z'); // 14:00 in New York
export const NIGHT = new Date('2026-06-03T03:30:00Z'); // 23:30 in New York: quiet hours

export const STAFF_A = '0a4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b60';
export const STAFF_B = '0b4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b61';
export const POSTER = '1d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';
export const MEMBER = '2e4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6b';
export const WS = '11111111-1111-4111-8111-111111111111';
export const SPACE = '22222222-2222-4222-8222-222222222222';
export const CHALLENGE = '55555555-5555-4555-8555-555555555555';
export const POSTER_NAME = 'Olive Quill';

export type Row = Record<string, unknown>;
export type Answer = Record<string, unknown>;
export interface WorldOptions {
  owners?: string[];
  at?: Date;
  prefs?: Record<string, unknown>;
  failNotification?: boolean;
  failPush?: boolean;
}

export function world(opts: WorldOptions = {}) {
  const owners = opts.owners ?? [STAFF_A, STAFF_B];
  const clock = { at: opts.at ?? DAY };
  const out = pushOutboxWorld({ now: () => clock.at, tokens: Object.fromEntries(owners.map((o) => [o, TOKEN])) });
  for (const o of owners) out.prefs[o] = { muted: false, timezone: ZONE, timezone_updated_at: DAY, ...opts.prefs };
  const inbox: Row[] = [];
  const db = {
    ...out.db,
    userBlock: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: Row }) => {
        inbox.push(a.data);
        return { id: `n-${inbox.length}`, ...a.data };
      }),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), {
    send: jest.fn(async (m: unknown[]) => m.map(() => ({ status: 'ok' as const, id: 't' }))),
    getReceipts: jest.fn(async () => ({})),
  });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery);
  if (opts.failNotification) jest.spyOn(notifications, 'createNotification').mockRejectedValue(new Error('row write failed'));
  if (opts.failPush) jest.spyOn(notifications, 'sendPush').mockRejectedValue(new Error('push write failed'));
  const prisma = {
    user: {
      findMany: jest.fn(async (a: { where: { role: string; deleted_at: null; deletion_scheduled_at: null; id: { not: string } } }) => {
        expect(a.where).toMatchObject({ role: 'owner', deleted_at: null, deletion_scheduled_at: null });
        return owners.filter((id) => id !== a.where.id.not).map((id) => ({ id }));
      }),
      findUnique: jest.fn(async () => ({ id: POSTER, role: 'student', coach_id: null })),
    },
    communityWin: {
      create: jest.fn(async (a: { data: Row }) => ({ id: randomUUID(), ...a.data, created_at: new Date(), user: { name: POSTER_NAME } })),
    },
    $queryRaw: jest.fn(async () => []),
  };
  const safety = new CommunitySafetyService(
    stub(prisma),
    stub<ModuleRef>({ get: (t: unknown) => (t === NotificationsService ? notifications : undefined) }),
  );

  const realtime = { broadcastCommunityEvent: jest.fn(async () => undefined) };
  const memberPush = { pushEnabled: () => true, sendCommunityPush: jest.fn(async () => undefined) };
  const access = {
    findCohort: async () => ({ id: SPACE, workspace_id: WS, kind: 'group', posting_policy: 'all' }),
    canAccessCohort: async () => true,
    assertCanPost: async () => undefined,
    isWorkspaceCoach: async () => false,
    findWorkspace: async () => ({ id: WS }),
    canAccessWorkspace: async () => true,
    membershipInWorkspace: async () => ({ workspace_id: WS }),
    readersOf: async () => [MEMBER],
  };

  // ── the stored rows ─────────────────────────────────────────────────────────────────
  const messages = new Map<string, Row>();
  const stamp = (r: Row): Row => {
    const row: Row = {
      id: r.id ?? randomUUID(),
      scope: 'cohort',
      workspace_id: WS,
      cohort_id: SPACE,
      sender_id: POSTER,
      kind: 'text',
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
      plan_context_type: null,
      plan_context_id: null,
      plan_context_payload: null,
      parent_message_id: null,
      high_alert: false,
      removed_by_user_id: null,
      voice_duration_ms: null,
      dm_key: null,
      recipient_user_id: null,
      ...r,
    };
    messages.set(String(row.id), row);
    return row;
  };
  const race = { landed: null as Row | null };
  const keyed = async (id: string, r: Row) => {
    if (race.landed) return { row: stamp({ ...r, ...race.landed, id }), replayed: true };
    return { row: stamp({ ...r, id }), replayed: false };
  };
  const messageRepo = {
    findById: async (id: string) => messages.get(id) ?? null,
    createCohortMessage: async (d: Row) => stamp({ body: d.body }),
    createKeyedCohortMessage: async (id: string, d: Row) => keyed(id, { body: d.body }),
    createImageMessage: async (d: Row) => stamp({ body: d.body, kind: 'image' }),
    createKeyedImageMessage: async (id: string, d: Row) => keyed(id, { body: d.body, kind: 'image' }),
    updateBody: async (m: Row, body: string) => stamp({ ...m, body, updated_at: new Date() }),
    imagesFor: async () => [],
    markCohortClientMessagesReplied: async () => undefined,
    listCohortPushRecipients: async () => [{ user_id: MEMBER, notify_level: 'all' }],
    listCohortMessages: async () => [...messages.values()],
    chatExtras: async () => ({ parents: [], people: new Map(), coachId: null, fullName: () => false }),
    voiceNotesFor: async () => new Map(),
    isPublicRowOfMyClient: async () => false,
  };
  const egress = {};
  const images = {
    check: async () => ({ result: 'ok', size: 10 }),
    removeObjects: async () => ({ failed: false }),
    publish: async () => undefined,
    createSignedDownload: async () => null,
  };
  const chat = new CommunityMessagesService(
    stub(access),
    stub(messageRepo),
    stub(realtime),
    stub({ validate: async () => null }),
    safety,
    stub(memberPush),
    stub(images),
    undefined,
    stub(egress),
    stub<ModuleRef>({ get: () => undefined }),
  );

  const postRows = new Map<string, Row>();
  const postView = (r: Row) => ({ id: r.id, title: r.title, body: r.body });
  const commentRow = (id: string | undefined, d: Row) =>
    stamp({ ...(id ? { id } : {}), body: d.body, plan_context_type: COMMENT_CONTEXT_TYPE, plan_context_id: d.postId });
  const posts = Object.assign(Object.create(CommunityPostsService.prototype) as Record<string, unknown>, {
    access,
    safety,
    realtime,
    communityPush: memberPush,
    posts: {
      findById: async (id: string) => postRows.get(id) ?? null,
      create: async (d: Row) => storePost(undefined, d),
      createKeyed: async (id: string, d: Row) =>
        race.landed ? { row: storePost(id, race.landed), replayed: true } : { row: storePost(id, d), replayed: false },
      update: async (id: string, d: Row) => {
        const row = { ...postRows.get(id)!, ...d };
        postRows.set(id, row);
        return row;
      },
    },
    messages: {
      findById: messageRepo.findById,
      createComment: async (d: Row) => commentRow(undefined, d),
      createKeyedComment: async (id: string, d: Row) =>
        race.landed ? { row: commentRow(id, { ...race.landed, postId: d.postId }), replayed: true } : { row: commentRow(id, d), replayed: false },
    },
    readablePost: async (_u: unknown, id: string) => postRows.get(id),
    visiblePost: async (_u: unknown, id: string) => ({ post: postRows.get(id), outside: false }),
    postResponse: async (_u: unknown, r: Row) => ({ post: postView(r) }),
    commentViews: async (_u: unknown, rows: Row[]) =>
      rows.map((r) => ({
        id: r.id,
        post_id: r.plan_context_id,
        author_user_id: r.sender_id,
        author_name: 'Olive',
        body: r.body,
        created_at: (r.created_at as Date).toISOString(),
        reactions: [],
      })),
    logger: new Logger('t'),
  });
  function storePost(id: string | undefined, d: Row): Row {
    const row: Row = {
      id: id ?? randomUUID(),
      workspace_id: WS,
      cohort_id: null,
      author_id: POSTER,
      title: d.title,
      body: d.body,
      created_at: new Date(),
      updated_at: new Date(),
    };
    postRows.set(String(row.id), row);
    return row;
  }
  const seedPost = (title: string, body: string) => String(storePost(undefined, { title, body }).id);
  const POST = seedPost('Morning crew', 'Who is in tomorrow');

  const dms = Object.assign(Object.create(CommunityDmsService.prototype) as Record<string, unknown>, {
    safety,
    realtime,
    communityPush: memberPush,
    authoriseDm: async () => 'dm-key',
    dms: {
      findById: messageRepo.findById,
      createDm: async (d: Row) => stamp({ body: d.body, scope: 'dm', dm_key: d.dmKey, recipient_user_id: d.recipientId }),
      createKeyedDm: async (id: string, d: Row) =>
        keyed(id, { body: d.body, scope: 'dm', dm_key: d.dmKey, recipient_user_id: d.recipientId }),
    },
  });

  const challengeRow = (d: Row) => ({
    body: d.body,
    plan_context_type: CHALLENGE_COMMENT_CONTEXT_TYPE,
    plan_context_id: CHALLENGE,
  });
  const challenges = Object.assign(Object.create(CommunityChallengesService.prototype) as Record<string, unknown>, {
    safety,
    readableChallenge: async () => ({ id: CHALLENGE, workspace_id: WS, cohort_id: null }),
    repo: {
      findCommentById: messageRepo.findById,
      createComment: async (d: Row) => stamp(challengeRow(d)),
      createKeyedComment: async (id: string, d: Row) => keyed(id, challengeRow(d)),
    },
  });

  const wins = new CommunityService(stub(prisma), stub({}), safety);

  return {
    clock, out, inbox, prisma, safety, notifications, realtime, memberPush, messages, postRows, race, POST, seedPost,
    chat, messageRepo, stamp, wins, access, delivery,
    posts: posts as unknown as CommunityPostsService,
    dms: dms as unknown as CommunityDmsService,
    challenges: challenges as unknown as CommunityChallengesService,
  };
}
export type World = ReturnType<typeof world>;

export const poster = stub<User>({ id: POSTER, role: 'student', coach_id: 'coach-1' });
export const answer = (a: unknown) => a as Answer;
/** The voided alert tail has finished. */
export const settled = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
};
export const pushesOf = (w: World) => w.out.rows;

// ─── The table ───────────────────────────────────────────────────────────────────────────

export interface PathRow {
  id: string;
  surface: string;
  /** One new write of `text`; `key` only where the route takes one. */
  write: (w: World, text: string, key?: string | null) => Promise<Answer>;
  /** The rest of the row's fields, to prove each alone. */
  fields?: Array<{ name: string; write: (w: World, text: string) => Promise<Answer> }>;
  keyed: boolean;
  /** Where a stored write of this path lands, to prove a refused write stored nothing. */
  stored: (w: World) => number;
}

export const PATHS: PathRow[] = [
  {
    id: 'S1 space chat send',
    surface: 'space_chat',
    keyed: true,
    stored: (w) => w.messages.size,
    write: async (w, text, key) => answer(await w.chat.send(poster, SPACE, text, undefined, undefined, undefined, undefined, key)),
  },
  {
    id: 'S2 space chat edit',
    surface: 'space_chat_edit',
    keyed: false,
    stored: (w) => [...w.messages.values()].filter((m) => m.body !== ORDINARY).length,
    write: async (w, text) => {
      const m = w.stamp({ body: ORDINARY });
      return answer(await w.chat.edit(poster, String(m.id), text));
    },
  },
  {
    id: 'S3 post create',
    surface: 'post',
    keyed: true,
    stored: (w) => w.postRows.size - 1,
    write: async (w, text, key) => answer(await w.posts.create(poster, WS, { title: text, body: ORDINARY }, key)),
    fields: [
      { name: 'title', write: async (w, text) => answer(await w.posts.create(poster, WS, { title: text, body: ORDINARY })) },
      { name: 'body', write: async (w, text) => answer(await w.posts.create(poster, WS, { title: ORDINARY, body: text })) },
    ],
  },
  {
    id: 'S4 post edit',
    surface: 'post_edit',
    keyed: false,
    stored: (w) => [...w.postRows.values()].filter((p) => p.title !== ORDINARY && p.title !== 'Morning crew').length,
    write: async (w, text) => {
      const id = w.seedPost(ORDINARY, ORDINARY);
      return answer(await w.posts.edit(poster, id, { title: text, body: ORDINARY }));
    },
    fields: [
      {
        name: 'title',
        write: async (w, text) => answer(await w.posts.edit(poster, w.seedPost(ORDINARY, ORDINARY), { title: text })),
      },
      { name: 'body', write: async (w, text) => answer(await w.posts.edit(poster, w.seedPost(ORDINARY, ORDINARY), { body: text })) },
    ],
  },
  {
    id: 'S5 post comment',
    surface: 'post_comment',
    keyed: true,
    stored: (w) => w.messages.size,
    write: async (w, text, key) => answer(await w.posts.addComment(poster, w.POST, text, key)),
  },
  {
    id: 'S6 DM',
    surface: 'dm',
    keyed: true,
    stored: (w) => w.messages.size,
    write: async (w, text, key) => answer(await w.dms.send(poster, WS, MEMBER, text, key)),
  },
  {
    id: 'S7 challenge comment',
    surface: 'challenge_comment',
    keyed: true,
    stored: (w) => w.messages.size,
    write: async (w, text, key) => answer(await w.challenges.addComment(poster, CHALLENGE, text, key)),
  },
  {
    id: 'S8 win',
    surface: 'win',
    keyed: false,
    stored: (w) => w.prisma.communityWin.create.mock.calls.length,
    write: async (w, text) => answer(await w.wins.postWin(POSTER, { title: text, description: ORDINARY })),
    fields: [
      { name: 'title', write: async (w, text) => answer(await w.wins.postWin(POSTER, { title: text, description: ORDINARY })) },
      { name: 'description', write: async (w, text) => answer(await w.wins.postWin(POSTER, { title: ORDINARY, description: text })) },
    ],
  },
];
export const KEYED = PATHS.filter((p) => p.keyed);
export const eachPath = PATHS.map((p) => [p.id, p] as const);
export const eachKeyed = KEYED.map((p) => [p.id, p] as const);
export const FIELDS = PATHS.flatMap((p) => (p.fields ?? []).map((f) => [`${p.id}: ${f.name}`, p, f] as const));

/** The real filter's answer, as the phone receives it. */
export function asSent(err: unknown): { status: number; body: Row } {
  const sent = { status: 0, body: {} as Row };
  const res = {
    status: (s: number) => {
      sent.status = s;
      return res;
    },
    json: (b: Row) => {
      sent.body = b;
      return res;
    },
  };
  const host = stub<ArgumentsHost>({
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', url: '/x', route: { path: '/x' } }) }),
  });
  new HttpExceptionFilter().catch(err, host);
  return sent;
}
