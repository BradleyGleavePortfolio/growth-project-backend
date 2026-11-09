/**
 * CRISIS-TEXT-BE (agent 203, owner #200-S1 op 1): one table over the 8 community writes that store text a member
 * typed (every call site of the word list). A text Roman's crisis check marks emergency or self_harm, in any field,
 * gives the poster's own answer `crisis_flag: true` and pages staff once for that write; anything else gives neither.
 *
 * Sample messages are stored ROT13-encoded (as community-content-filter.ts stores its terms) and are described,
 * never quoted. Rows run the real services, the real word list, the real classifier and the real notifications stack.
 */
import { randomUUID } from 'crypto';
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { ArgumentsHost } from '@nestjs/common';
import type { User } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityPostsService } from '../../../src/community/posts/community-posts.service';
import { CommunityDmsService } from '../../../src/community/dms/community-dms.service';
import { CommunityChallengesService } from '../../../src/community/challenges/community-challenges.service';
import { CommunityService } from '../../../src/community/community.service';
import { HttpExceptionFilter } from '../../../src/filters/http-exception.filter';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import * as photoCheck from '../../../src/community/images/community-photo-check';
import { classifySafety } from '../../../src/roman/guardrails/safety-router';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';

const rot13 = (s: string): string =>
  s.replace(/[a-z]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));
const stub = <T>(v: unknown): T => v as T;

// A first-person statement of wanting to stop living (class self_harm).
const SELF_HARM = rot13('ubarfgyl gurer vf ab ernfba gb xrrc tbvat nalzber');
// A person described as unresponsive right now (class emergency).
const EMERGENCY = rot13('zl oebgure vf pbzcyrgryl haerfcbafvir ba gur tlz sybbe');
// Ordinary gym chat, no class at all.
const ORDINARY = 'Leg day done, new squat best today';
// A figure of speech about too much of a supplement, which the lists narrow out (NOT_A_SUBSTANCE, ai-crisis-router.ts:52).
const GYM_SUPPLEMENT = rot13('v guvax v bireqbfrq ba perngvar guvf zbeavat');
// Breathing during a named training activity, which the lists narrow out (ACTIVITY, ai-crisis-router.ts:67).
const GYM_ACTIVITY = rot13('vg tbg uneq gb oerngur juvyr ehaavat gur uvyy gbqnl');
// A weight-loss medicine with a red-flag symptom (class urgent_symptoms).
const URGENT = rot13('fgnegrq zbhawneb ynfg jrrx naq abguvat fgnlf qbja');
// A stated multi-day fast (class eating_disorder_risk).
const EATING = rot13('tbvat gb snfg sbe guerr qnlf nsgre gur ubyvqnl');
// One term the word list refuses (also ROT13 in community-content-filter.ts).
const REFUSED_TERM = rot13('ovgpu');
const REFUSED_MATCH = `${SELF_HARM} ${REFUSED_TERM}`;
const REFUSED_ORDINARY = `${ORDINARY} ${REFUSED_TERM}`;

const TOKEN = 'ExponentPushToken[crisistextbe00000001]';
const ZONE = 'America/New_York';
const DAY = new Date('2026-06-02T18:00:00Z'); // 14:00 in New York
const NIGHT = new Date('2026-06-03T03:30:00Z'); // 23:30 in New York: quiet hours

const STAFF_A = '0a4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b60';
const STAFF_B = '0b4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b61';
const POSTER = '1d4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6a';
const MEMBER = '2e4a2c1e-8b1f-4c55-9a0e-1f2e3d4c5b6b';
const WS = '11111111-1111-4111-8111-111111111111';
const SPACE = '22222222-2222-4222-8222-222222222222';
const CHALLENGE = '55555555-5555-4555-8555-555555555555';
const POSTER_NAME = 'Olive Quill';

type Row = Record<string, unknown>;
type Answer = Record<string, unknown>;
interface WorldOptions {
  owners?: string[];
  at?: Date;
  prefs?: Record<string, unknown>;
  failNotification?: boolean;
  failPush?: boolean;
}

function world(opts: WorldOptions = {}) {
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
    if (race.landed) return { row: stamp({ ...race.landed, id }), replayed: true };
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
    stamp({ ...(id ? { id } : {}), body: d.body, plan_context_type: 'comment', plan_context_id: d.postId });
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
    plan_context_type: 'challenge_comment',
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
    chat, messageRepo, stamp, wins,
    posts: posts as unknown as CommunityPostsService,
    dms: dms as unknown as CommunityDmsService,
    challenges: challenges as unknown as CommunityChallengesService,
  };
}
type World = ReturnType<typeof world>;

const poster = stub<User>({ id: POSTER, role: 'student', coach_id: 'coach-1' });
const answer = (a: unknown) => a as Answer;
/** The voided alert tail has finished. */
const settled = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
};
const pushesOf = (w: World) => w.out.rows;

// ─── The table ───────────────────────────────────────────────────────────────────────────

interface PathRow {
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

const PATHS: PathRow[] = [
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
    stored: (w) => [...w.postRows.values()].filter((p) => p.body !== ORDINARY && p.title !== ORDINARY && p.body !== 'Who is in tomorrow').length,
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
const KEYED = PATHS.filter((p) => p.keyed);
const eachPath = PATHS.map((p) => [p.id, p] as const);
const eachKeyed = KEYED.map((p) => [p.id, p] as const);
const FIELDS = PATHS.flatMap((p) => (p.fields ?? []).map((f) => [`${p.id}: ${f.name}`, p, f] as const));

const SWITCH = 'COMMUNITY_CRISIS_CHECK_ENABLED';
beforeEach(() => {
  delete process.env[SWITCH];
  delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env[SWITCH];
});

const expectOneAlertEach = (w: World, surface: string) => {
  expect(w.inbox.map((r) => r.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
  expect(w.inbox.every((r) => r.kind === NotificationKind.COACH_ALERT && r.channel === 'inapp')).toBe(true);
  expect(w.inbox.every((r) => (r.payload as Row).surface === surface)).toBe(true);
  expect(pushesOf(w).map((p) => p.user_id).sort()).toEqual([STAFF_A, STAFF_B].sort());
  expect(pushesOf(w).every((p) => p.urgent === true && p.kind === NotificationKind.COACH_ALERT)).toBe(true);
};
const expectNoAlert = (w: World) => {
  expect(w.inbox).toEqual([]);
  expect(pushesOf(w)).toEqual([]);
};

// ─── The samples are what they say ───────────────────────────────────────────────────────

describe('the samples', () => {
  it.each([
    ['the self-harm sample', SELF_HARM, 'self_harm'],
    ['the emergency sample', EMERGENCY, 'emergency'],
    ['the urgent-symptoms sample', URGENT, 'urgent_symptoms'],
    ['the eating-disorder sample', EATING, 'eating_disorder_risk'],
  ])('%s has its class', (_n, text, cls) => expect(classifySafety(text).class).toBe(cls));

  it.each([
    ['supplement talk', GYM_SUPPLEMENT],
    ['activity talk', GYM_ACTIVITY],
    ['ordinary chat', ORDINARY],
  ])('%s is not a crisis class', (_n, text) => {
    expect(['emergency', 'self_harm']).not.toContain(classifySafety(text).class);
  });

  it('the refused samples are refused by the word list and the crisis sample still matches', async () => {
    const w = world();
    expect(() => w.safety.screenText('dm', POSTER, [REFUSED_ORDINARY])).toThrow(UnprocessableEntityException);
    expect(['emergency', 'self_harm']).toContain(classifySafety(REFUSED_MATCH).class);
  });
});

// ─── A. Every path ───────────────────────────────────────────────────────────────────────

describe('A. a matching text is stored and pages staff once; an ordinary text is untouched', () => {
  it.each(eachPath)('%s: a match is stored, the answer has the flag, one row and one urgent push per recipient', async (_n, p) => {
    const w = world();
    const before = p.stored(w);
    const a = await p.write(w, SELF_HARM);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expect(p.stored(w)).toBeGreaterThan(before);
    expectOneAlertEach(w, p.surface);
  });

  it.each(eachPath)('%s: the emergency class pages too', async (_n, p) => {
    const w = world();
    const a = await p.write(w, EMERGENCY);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectOneAlertEach(w, p.surface);
  });

  it.each(FIELDS)('%s alone is enough', async (_n, p, f) => {
    const w = world();
    const a = await f.write(w, SELF_HARM);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectOneAlertEach(w, p.surface);
  });

  it.each(eachPath)('%s: an ordinary text gets no field, no row, no push', async (_n, p) => {
    const w = world();
    const a = await p.write(w, ORDINARY);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  it.each(eachPath)('%s: the answer is the ordinary answer plus the one key', async (_n, p) => {
    const ordinary = await p.write(world(), ORDINARY);
    const matching = await p.write(world(), SELF_HARM);
    expect(Object.keys(matching).sort()).toEqual([...Object.keys(ordinary), 'crisis_flag'].sort());
  });
});

// ─── B. Negatives by kind ────────────────────────────────────────────────────────────────

describe('B. negatives by kind: no flag and no alert', () => {
  const KINDS = [
    ['supplement talk', GYM_SUPPLEMENT],
    ['activity talk', GYM_ACTIVITY],
    ['urgent symptoms', URGENT],
    ['eating disorder risk', EATING],
  ] as const;
  const table = PATHS.flatMap((p) => KINDS.map(([kind, text]) => [p.id, kind, p, text] as const));
  it.each(table)('%s, %s', async (_n, _k, p, text) => {
    const w = world();
    const a = await p.write(w, text);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });
});

// ─── C. Who sees it ──────────────────────────────────────────────────────────────────────

describe('C. the field exists only on the write\'s own answer', () => {
  it.each(eachPath)('%s: the stored row, the realtime event and the push to other members carry no field and no flag', async (_n, p) => {
    const w = world();
    await p.write(w, SELF_HARM);
    await settled();
    const elsewhere = JSON.stringify({
      rows: [...w.messages.values(), ...w.postRows.values()],
      realtime: w.realtime.broadcastCommunityEvent.mock.calls,
      member: w.memberPush.sendCommunityPush.mock.calls,
    });
    expect(elsewhere).not.toContain('crisis_flag');
  });

  it('S1: GET and list for that row equal an ordinary row, the poster reading too', async () => {
    const w = world();
    const sent = answer(await w.chat.send(poster, SPACE, SELF_HARM));
    const id = (sent.message as Row).id as string;
    const one = answer(await w.chat.getOne(poster, id));
    expect(one).not.toHaveProperty('crisis_flag');
    expect(one.message).not.toHaveProperty('crisis_flag');
    const list = answer(await w.chat.list(poster, SPACE, {}));
    expect(JSON.stringify(list)).not.toContain('crisis_flag');
    expect(Object.keys(one)).toEqual(['message']);
  });

  it('crisis_flag is written only by the safety service and let through only by the error allowlist', () => {
    const SRC = join(__dirname, '../../../src');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });
    const holders = walk(SRC)
      .filter((f) => !/\.spec\.ts$/.test(f) && readFileSync(f, 'utf8').includes('crisis_flag'))
      .map((f) => relative(SRC, f))
      .sort();
    // Each write's return type names the key; no row view, DTO, schema, realtime or push file does.
    expect(holders).toEqual(
      [
        'community/challenges/community-challenges.service.ts',
        'community/community.service.ts',
        'community/dms/community-dms.service.ts',
        'community/messages/community-messages.service.ts',
        'community/posts/community-posts.service.ts',
        'community/safety/community-safety.service.ts',
        'filters/error-details.ts',
      ].sort(),
    );
  });
});

// ─── D. Send once ────────────────────────────────────────────────────────────────────────

describe('D. send once', () => {
  it.each(eachKeyed)('%s: the same key twice answers the field again and pages once', async (_n, p) => {
    const w = world();
    const key = randomUUID();
    const first = await p.write(w, SELF_HARM, key);
    const again = await p.write(w, SELF_HARM, key);
    await settled();
    expect(first.crisis_flag).toBe(true);
    expect(again.crisis_flag).toBe(true);
    expectOneAlertEach(w, p.surface);
  });

  it.each(eachKeyed)('%s: a race that lands on replayed is the same', async (_n, p) => {
    const w = world();
    w.race.landed = { title: SELF_HARM, body: p.surface === 'post' ? ORDINARY : SELF_HARM };
    const a = await p.write(w, SELF_HARM, randomUUID());
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectNoAlert(w);
  });

  it.each(eachKeyed)('%s: no key, a second send is a new row and a new alert', async (_n, p) => {
    const w = world();
    await p.write(w, SELF_HARM, null);
    await p.write(w, SELF_HARM, null);
    await settled();
    expect(w.inbox).toHaveLength(4);
    expect(pushesOf(w)).toHaveLength(4);
  });
});

// ─── E. Edits ────────────────────────────────────────────────────────────────────────────

describe('E. edits', () => {
  const editChat = async (w: World, from: string, to: string) => {
    const m = w.stamp({ body: from });
    return answer(await w.chat.edit(poster, String(m.id), to));
  };
  const editPost = async (w: World, from: [string, string], to: { title?: string; body?: string }) =>
    answer(await w.posts.edit(poster, w.seedPost(from[0], from[1]), to));

  it.each([
    ['S2', (w: World, a: string, b: string) => editChat(w, a, b)],
    ['S4', (w: World, a: string, b: string) => editPost(w, [ORDINARY, a], { body: b })],
  ] as const)('%s: ordinary to matching: field and one alert', async (_n, edit) => {
    const w = world();
    const a = await edit(w, ORDINARY, SELF_HARM);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expect(w.inbox).toHaveLength(2);
  });

  it.each([
    ['S2', (w: World, a: string, b: string) => editChat(w, a, b)],
    ['S4', (w: World, a: string, b: string) => editPost(w, [ORDINARY, a], { body: b })],
  ] as const)('%s: matching to matching: field, no new alert', async (_n, edit) => {
    const w = world();
    const a = await edit(w, SELF_HARM, EMERGENCY);
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectNoAlert(w);
  });

  it.each([
    ['S2', (w: World, a: string, b: string) => editChat(w, a, b)],
    ['S4', (w: World, a: string, b: string) => editPost(w, [ORDINARY, a], { body: b })],
  ] as const)('%s: matching to ordinary: neither', async (_n, edit) => {
    const w = world();
    const a = await edit(w, SELF_HARM, ORDINARY);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  it('S4: a title-only edit on a matching body carries the field and pages nobody new', async () => {
    const w = world();
    const a = await editPost(w, [ORDINARY, SELF_HARM], { title: 'Monday crew' });
    await settled();
    expect(a.crisis_flag).toBe(true);
    expectNoAlert(w);
  });

  it('S4: the word list still reads only what was sent: an untouched refused body does not refuse a title edit', async () => {
    const w = world();
    const a = await editPost(w, ['Monday', `${ORDINARY} ${REFUSED_TERM}`], { title: 'Tuesday' });
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
  });

  it('S2: the edit window refuses after the word list, and a window refusal carries neither', async () => {
    const w = world();
    const m = w.stamp({ body: ORDINARY, created_at: new Date(Date.now() - 6 * 60_000) });
    await expect(w.chat.edit(poster, String(m.id), SELF_HARM)).rejects.toMatchObject({
      response: { code: 'community.message.edit_window_closed' },
    });
    await settled();
    expect(JSON.stringify([...w.messages.values()])).not.toContain('crisis_flag');
    expectNoAlert(w);
  });

  it('S2: not the author: refused, neither', async () => {
    const w = world();
    const m = w.stamp({ body: ORDINARY, sender_id: MEMBER });
    await expect(w.chat.edit(poster, String(m.id), SELF_HARM)).rejects.toMatchObject({
      response: { code: 'community.message.not_author' },
    });
    await settled();
    expectNoAlert(w);
  });

  it('S4: not the author: refused, neither', async () => {
    const w = world();
    const id = w.seedPost(ORDINARY, ORDINARY);
    w.postRows.get(id)!.author_id = MEMBER;
    await expect(w.posts.edit(poster, id, { body: SELF_HARM })).rejects.toMatchObject({
      response: { code: 'community.post.not_author' },
    });
    await settled();
    expectNoAlert(w);
  });

  it('S2: word list refusal outside the window is main\'s order: 422 with the flag and one alert', async () => {
    const w = world();
    const m = w.stamp({ body: ORDINARY, created_at: new Date(Date.now() - 6 * 60_000) });
    await expect(w.chat.edit(poster, String(m.id), REFUSED_MATCH)).rejects.toMatchObject({
      response: { code: 'community.content.rejected', crisis_flag: true },
    });
    await settled();
    expect(w.inbox).toHaveLength(2);
  });
});

// ─── F. Refused text ─────────────────────────────────────────────────────────────────────

/** The real filter's answer, as the phone receives it. */
function asSent(err: unknown): { status: number; body: Row } {
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

describe('F. refused text stays refused', () => {
  it.each(eachPath)('%s: a matching text the word list refuses: 422, nothing stored, the flag beside the keys, one alert, no row id', async (_n, p) => {
    const w = world();
    const before = p.stored(w);
    let caught: unknown;
    await p.write(w, REFUSED_MATCH).catch((e: unknown) => {
      caught = e;
    });
    await settled();
    const { status, body } = asSent(caught);
    expect(status).toBe(422);
    expect(body).toMatchObject({ code: 'community.content.rejected', error: 'content_rejected', crisis_flag: true });
    expect(typeof body.message).toBe('string');
    expect(p.stored(w)).toBe(before);
    expectOneAlertEach(w, p.surface);
    expect(w.inbox.every((r) => !('row_id' in (r.payload as Row)) && (r.payload as Row).poster_id === POSTER)).toBe(true);
  });

  it.each(eachPath)('%s: an ordinary refused text is today\'s 422, no flag, no alert', async (_n, p) => {
    const w = world();
    let caught: unknown;
    await p.write(w, REFUSED_ORDINARY).catch((e: unknown) => {
      caught = e;
    });
    await settled();
    const { status, body } = asSent(caught);
    expect(status).toBe(422);
    expect(body.code).toBe('community.content.rejected');
    expect(body).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  describe('a photo refused on a matching caption', () => {
    const ON = { FEATURE_COMMUNITY_IMAGES: 'true', VOICE_KEY_SIGNING_SECRET: 'crisis-test-secret' };
    beforeEach(() => Object.assign(process.env, ON));
    afterEach(() => {
      for (const k of Object.keys(ON)) delete process.env[k];
    });
    const key = (w: World) => {
      // The real key check is covered by community-photo-check.e2e.spec.ts; this table reaches the refusal.
      return jest.requireActual<typeof import('../../../src/community/images/community-image-store')>('../../../src/community/images/community-image-store').mintImageKey(POSTER, SPACE);
    };
    it.each([
      ['PHOTO_NOT_ALLOWED', 'invalid_image'],
      ['CAPTION_NOT_ALLOWED', 'invalid_caption'],
    ])('S1 %s: stays a 422 with its own code, the flag beside it, one alert; nothing stored', async (code, error) => {
      const w = world();
      const coachAlert = jest.fn(async () => undefined);
      jest.spyOn(photoCheck, 'assertPhotoAllowed').mockImplementation(async (..._a) => {
        const onSelfHarm = _a[6];
        await onSelfHarm?.();
        throw new UnprocessableEntityException({ error, code });
      });
      jest.spyOn(w.chat as never, 'alertCoachOfPhotoSafety' as never).mockImplementation(coachAlert as never);
      let caught: unknown;
      await w.chat
        .send(poster, SPACE, SELF_HARM, undefined, undefined, { key: key(w), width: 10, height: 10 })
        .catch((e: unknown) => {
          caught = e;
        });
      await settled();
      const { status, body } = asSent(caught);
      expect(status).toBe(422);
      expect(body).toMatchObject({ code, crisis_flag: true });
      expect(w.messages.size).toBe(0);
      expect(w.inbox).toHaveLength(2);
      expect(coachAlert).toHaveBeenCalledTimes(1);
    });

    it('S2: a refused caption edit with a matching text does the same', async () => {
      const w = world();
      jest.spyOn(photoCheck, 'assertCaptionAllowed').mockImplementation(async () => {
        throw new UnprocessableEntityException({ error: 'invalid_caption', code: 'CAPTION_NOT_ALLOWED' });
      });
      const m = w.stamp({ body: ORDINARY, kind: 'image' });
      let caught: unknown;
      await w.chat.edit(poster, String(m.id), SELF_HARM).catch((e: unknown) => {
        caught = e;
      });
      await settled();
      expect(asSent(caught).body).toMatchObject({ code: 'CAPTION_NOT_ALLOWED', crisis_flag: true });
      expect(w.messages.get(String(m.id))!.body).toBe(ORDINARY);
      expect(w.inbox).toHaveLength(2);
    });

    it('S1: the photo check being unavailable is not a refusal: 503, no field, no alert', async () => {
      const w = world();
      jest.spyOn(photoCheck, 'assertPhotoAllowed').mockImplementation(async () => {
        throw new ServiceUnavailableException({ error: 'unavailable', code: 'PHOTO_CHECK_UNAVAILABLE' });
      });
      let caught: unknown;
      await w.chat
        .send(poster, SPACE, SELF_HARM, undefined, undefined, { key: key(w), width: 10, height: 10 })
        .catch((e: unknown) => {
          caught = e;
        });
      await settled();
      expect(asSent(caught).status).toBe(503);
      expect(asSent(caught).body).not.toHaveProperty('crisis_flag');
      expectNoAlert(w);
    });

    it('S1: a clean photo with a matching caption is stored with the field and pages once', async () => {
      const w = world();
      jest.spyOn(photoCheck, 'assertPhotoAllowed').mockResolvedValue(undefined);
      const a = answer(await w.chat.send(poster, SPACE, SELF_HARM, undefined, undefined, { key: key(w), width: 10, height: 10 }));
      await settled();
      expect(a.crisis_flag).toBe(true);
      expect(w.inbox).toHaveLength(2);
    });
  });
});

// ─── G. Alert content ────────────────────────────────────────────────────────────────────

describe('G. the alert', () => {
  const words = (text: string) => text.toLowerCase().split(/\W+/).filter((t) => t.length >= 4);
  it.each(eachPath)('%s: no row, push or payload holds a word of the text, the pattern, the class or a name', async (_n, p) => {
    const w = world();
    await p.write(w, EMERGENCY);
    await settled();
    const rendered = JSON.stringify({ inbox: w.inbox, pushes: pushesOf(w).map((r) => ({ title: r.title, body: r.body, data: r.data, context: r.context })) }).toLowerCase();
    for (const t of words(EMERGENCY)) expect(rendered).not.toContain(t);
    expect(rendered).not.toContain(classifySafety(EMERGENCY).matched!.toLowerCase());
    expect(rendered).not.toContain('self_harm');
    expect(rendered).not.toContain('emergency');
    expect(rendered).not.toContain(POSTER_NAME.split(' ')[0].toLowerCase());
    expect(rendered).not.toContain(POSTER_NAME.split(' ')[1].toLowerCase());
  });

  it('the row and push carry the fixed words and ids only', async () => {
    const w = world();
    const sent = await w.posts.addComment(poster, w.POST, SELF_HARM);
    await settled();
    expect(w.inbox[0].body).toBe('Urgent safety alert in the community.');
    expect(w.inbox[0].payload).toEqual({
      title: 'Safety alert',
      severity: 'critical',
      surface: 'post_comment',
      poster_id: POSTER,
      row_id: sent.comment.id,
    });
    expect(w.inbox[0].deep_link).toBeUndefined();
    expect(pushesOf(w)[0].body).toBe('Urgent safety alert in the community. Open TGP to see it.');
    expect(pushesOf(w)[0].data).not.toHaveProperty('actionScreen');
    expect(pushesOf(w)[0].context).toEqual({ safetyAlert: 'community_crisis_text' });
  });

  it('Mute all on and inside 21:00-08:00: the push is queued to go now', async () => {
    const w = world({ at: NIGHT, prefs: { muted: true } });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(pushesOf(w)).toHaveLength(2);
    expect(pushesOf(w).every((r) => r.not_before.getTime() === NIGHT.getTime() && r.deferred_reason === null)).toBe(true);
  });

  it('two matches in one minute are two pushes (none folds into another)', async () => {
    const w = world({ owners: [STAFF_A] });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(pushesOf(w)).toHaveLength(2);
    expect(new Set(pushesOf(w).map((r) => r.dedupe_key)).size).toBe(2);
  });

  it('the poster\'s coach gets no CoachAlert: this path has no coach alert service', async () => {
    const w = world();
    const moduleGets: unknown[] = [];
    Object.defineProperty(w.safety, 'moduleRef', {
      value: { get: (t: unknown) => (moduleGets.push(t), w.notifications) },
    });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(moduleGets).toEqual([NotificationsService]);
    expect(w.inbox.map((r) => r.user_id)).not.toContain('coach-1');
  });

  it('a poster who is staff gets no copy', async () => {
    const w = world({ owners: [POSTER, STAFF_A] });
    await w.dms.send(poster, WS, MEMBER, SELF_HARM);
    await settled();
    expect(w.inbox.map((r) => r.user_id)).toEqual([STAFF_A]);
    expect(pushesOf(w).map((r) => r.user_id)).toEqual([STAFF_A]);
  });
});

// ─── H. Failure ──────────────────────────────────────────────────────────────────────────

describe('H. the alert never fails the write', () => {
  const logs = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const ALERT_LINE = /^community\.crisis_alert outcome=/;
  it.each([
    ['createNotification throws', { failNotification: true }],
    ['sendPush throws', { failPush: true }],
    ['no staff account', { owners: [] }],
  ])('%s: the write answers with the field; one closed-code log line, no text', async (_n, o) => {
    const log = logs();
    const w = world(o as WorldOptions);
    const a = answer(await w.dms.send(poster, WS, MEMBER, SELF_HARM));
    await settled();
    expect(a.crisis_flag).toBe(true);
    const lines = log.mock.calls.map(([m]) => String(m)).filter((m) => ALERT_LINE.test(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SELF_HARM.split(' ')[1]);
  });
});

// ─── I. Both fields, the switch ──────────────────────────────────────────────────────────

describe('I. together with High alert, and the switch', () => {
  it('a coach\'s High alert send that matches has both fields', async () => {
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
    const w = world();
    const spacePush = {
      highAlertAllowance: jest.fn(async () => ({ used_today: 0, limit: 3, reach: 7 })),
      markHighAlert: jest.fn(async () => undefined),
    };
    Object.assign(w.chat as unknown as Row, { spacePush });
    const coach = stub<User>({ id: POSTER, role: 'coach' });
    const a = answer(await w.chat.send(coach, SPACE, SELF_HARM, undefined, undefined, undefined, true));
    await settled();
    expect(a.high_alert_reach).toBe(7);
    expect(a.crisis_flag).toBe(true);
    expect(w.inbox).toHaveLength(2);
  });

  it.each(eachPath)('%s: switch "false": a match reads as main', async (_n, p) => {
    process.env[SWITCH] = 'false';
    const w = world();
    const a = await p.write(w, SELF_HARM);
    await settled();
    expect(a).not.toHaveProperty('crisis_flag');
    expectNoAlert(w);
  });

  it.each(eachPath)('%s: switch "false": a refused text is today\'s 422 with no flag', async (_n, p) => {
    process.env[SWITCH] = 'false';
    const w = world();
    let caught: unknown;
    await p.write(w, REFUSED_MATCH).catch((e: unknown) => {
      caught = e;
    });
    await settled();
    expect(asSent(caught).body).not.toHaveProperty('crisis_flag');
    expect(asSent(caught).status).toBe(422);
    expectNoAlert(w);
  });

  it('any other value leaves it on', () => {
    process.env[SWITCH] = 'true';
    const w = world();
    expect(w.safety.screenText('dm', POSTER, [SELF_HARM]).flag).toBe(true);
    process.env[SWITCH] = '0';
    expect(w.safety.screenText('dm', POSTER, [SELF_HARM]).flag).toBe(true);
  });
});

// ─── J. Speed ────────────────────────────────────────────────────────────────────────────

describe('J. speed', () => {
  it('classifySafety on a 20,000-character ordinary body stays under the 100 ms planning number', () => {
    const body = (`${ORDINARY}. `).repeat(Math.ceil(20_000 / (ORDINARY.length + 2))).slice(0, 20_000);
    const runs = 5;
    let worst = 0;
    for (let i = 0; i < runs; i += 1) {
      const t0 = process.hrtime.bigint();
      expect(classifySafety(body).class).toBe('normal');
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      worst = Math.max(worst, ms);
    }
    process.stdout.write(`CRISIS-TEXT-BE J: classifySafety 20000 chars worst of ${runs}: ${worst.toFixed(2)} ms\n`);
    expect(worst).toBeLessThan(100);
  });
});
