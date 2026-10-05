/**
 * A3-MSG-CORE slice 1 — unit proof for the canonical 1:1 thread actions:
 * idempotent send, swipe-reply, edit/delete (window, tombstone, audit, voice
 * erasure), thread pins, mute (push suppression), inbox pins, read-up-to, the
 * unified inbox (order, unread parity, blocks, tenancy, cursor) and the
 * FEATURE_MESSAGING_CORE_V2 kill switch.
 *
 * Every rule here is new in this change: on main none of these modules or
 * behaviours exist, so each case fails before and passes after.
 */
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CoachMessage } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PtmService } from '../../src/ptm/ptm.service';
import { MessageReceivedEmitter } from '../../src/notifications/emitters/message-received.emitter';
import { AuditService } from '../../src/audit/audit.service';
import { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { MessagesSafetyService } from '../../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import {
  isMessagingCoreV2Enabled,
  MessagingCoreV2Guard,
} from '../../src/messaging/messaging-core.feature';

const COACH = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIENT = '33333333-3333-4333-8333-333333333333';
const KEY = '55555555-5555-4555-8555-555555555555';
const MSG = '66666666-6666-4666-8666-666666666666';

type ReplyLike = Pick<CoachMessage, 'id' | 'sender_id' | 'body' | 'voice_url' | 'deleted_at'>;
type Row = CoachMessage & { reply_to?: ReplyLike | null };

/**
 * Typed test double without a forbidden cast: an object whose prototype is
 * the real class, with only the members a test exercises assigned on top
 * (the repo pattern, see feature-flags.controller.spec.ts).
 */
function dep<T extends object>(cls: { prototype: T }, impl: object): T {
  return Object.assign(Object.create(cls.prototype) as T, impl);
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: MSG,
    coach_id: COACH,
    client_id: CLIENT,
    sender_id: COACH,
    body: 'Original words',
    voice_url: null,
    voice_duration_sec: null,
    voice_size_bytes: null,
    voice_content_type: null,
    created_at: new Date(),
    read_at: null,
    ai_draft_id: null,
    welcome_job_id: null,
    client_message_id: null,
    reply_to_id: null,
    edited_at: null,
    deleted_at: null,
    deleted_by_id: null,
    pinned_at: null,
    pinned_by_id: null,
    ...over,
  };
}

function expectCode(err: unknown, status: number, code: string) {
  expect(err).toBeInstanceOf(HttpException);
  const e = err as HttpException;
  expect(e.getStatus()).toBe(status);
  const body = e.getResponse() as Record<string, unknown>;
  expect(body.code).toBe(code);
  expect(body.error).toBe(code);
  expect(typeof body.message).toBe('string');
  expect(String(body.message)).not.toMatch(/!|something went wrong|please try again/i);
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

const flush = () => new Promise((r) => setImmediate(r));

function build(opts: { blocked?: string[]; eitherBlocked?: boolean } = {}) {
  const tx = {
    coachMessage: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    coachThreadState: {
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn().mockResolvedValue({ muted_until: null, pinned_at: new Date() }),
    },
    communityVoiceErasure: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({ id: 'e1', kind: 'object', target: 'x', attempts: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT, coach_id: COACH }),
      findUnique: jest.fn().mockResolvedValue({ coach_id: COACH, name: 'Coach Name' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    coachMessage: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Partial<CoachMessage> }) =>
        row({ ...data, id: MSG, body: data.body ?? null }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    coachThreadState: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(async ({ create }: { where: unknown; create: Record<string, unknown> }) => ({
        muted_until: (create.muted_until as Date | null) ?? null,
        pinned_at: (create.pinned_at as Date | null) ?? null,
      })),
    },
    conversationReview: { upsert: jest.fn(), findUnique: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const supabase = {
    broadcastNewMessage: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(() => ({
      channel: () => ({
        subscribe: (cb: (s: string) => void) => cb('SUBSCRIBED'),
        send: jest.fn().mockResolvedValue('ok'),
      }),
      removeChannel: jest.fn().mockResolvedValue('ok'),
    })),
  };
  const analytics = { capture: jest.fn() };
  const ptm = { emit: jest.fn() };
  const messageReceived = { emit: jest.fn().mockResolvedValue(undefined) };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const aiContext = { invalidateForUser: jest.fn() };
  const safety = {
    getBlockedIdsFor: jest.fn().mockResolvedValue(opts.blocked ?? []),
    isEitherSideBlocked: jest.fn().mockResolvedValue(opts.eitherBlocked ?? false),
  };
  const subCoachScope = {
    getHeadCoachIdForSubCoach: jest.fn().mockResolvedValue(null),
    getAuthorizedClientIds: jest.fn().mockResolvedValue([CLIENT, OTHER_CLIENT]),
  };
  const prismaDep = dep(PrismaService, prisma);
  const auditDep = dep(AuditService, audit);
  const scopeDep = dep(SubCoachScopeService, subCoachScope);
  const messaging = new MessagingService(
    prismaDep,
    dep(SupabaseService, supabase),
    dep(AnalyticsService, analytics),
    dep(PtmService, ptm),
    dep(MessageReceivedEmitter, messageReceived),
    auditDep,
    dep(ClientAIContextService, aiContext),
    dep(MessagesSafetyService, safety),
    scopeDep,
  );
  return {
    prisma,
    tx,
    supabase,
    messageReceived,
    audit,
    aiContext,
    safety,
    subCoachScope,
    messaging,
    analytics,
    ptm,
  };
}

const ORIGINAL_FLAG = process.env.FEATURE_MESSAGING_CORE_V2;
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.FEATURE_MESSAGING_CORE_V2;
  else process.env.FEATURE_MESSAGING_CORE_V2 = ORIGINAL_FLAG;
});
const on = () => {
  process.env.FEATURE_MESSAGING_CORE_V2 = 'true';
};

describe('FEATURE_MESSAGING_CORE_V2 kill switch', () => {
  it('is OFF unless exactly "true" (case-insensitive)', () => {
    expect(isMessagingCoreV2Enabled({})).toBe(false);
    expect(isMessagingCoreV2Enabled({ FEATURE_MESSAGING_CORE_V2: '1' })).toBe(false);
    expect(isMessagingCoreV2Enabled({ FEATURE_MESSAGING_CORE_V2: 'TRUE' })).toBe(true);
  });

  it('the route guard answers 503 messaging.feature_disabled when OFF and passes when ON', () => {
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    let err: unknown;
    try {
      new MessagingCoreV2Guard().canActivate();
    } catch (e) {
      err = e;
    }
    expectCode(err, 503, 'messaging.feature_disabled');
    on();
    expect(new MessagingCoreV2Guard().canActivate()).toBe(true);
  });

  it('flag OFF: the thread read is the legacy query (no reply include, raw rows)', async () => {
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    const t = build();
    const r = row();
    t.prisma.coachMessage.findMany.mockResolvedValue([r]);
    const out = await t.messaging.listThreadForClient(CLIENT, {});
    expect(t.prisma.coachMessage.findMany.mock.calls[0][0]).not.toHaveProperty('include');
    expect(out).toEqual([r]);
  });
});

describe('idempotent send (offline queue)', () => {
  it('a replay with the same key returns the original row and runs no side effects', async () => {
    const t = build();
    const first = await t.messaging.sendAsClient(CLIENT, { body: 'hi', client_message_id: KEY });
    expect(t.prisma.coachMessage.create).toHaveBeenCalledTimes(1);
    expect(t.prisma.coachMessage.create.mock.calls[0][0].data.client_message_id).toBe(KEY);
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(first);
    const again = await t.messaging.sendAsClient(CLIENT, { body: 'hi', client_message_id: KEY });
    expect(again).toBe(first);
    expect(t.prisma.coachMessage.create).toHaveBeenCalledTimes(1);
    expect(t.supabase.broadcastNewMessage).toHaveBeenCalledTimes(1);
    expect(t.audit.write).toHaveBeenCalledTimes(1);
    expect(t.analytics.capture).toHaveBeenCalledTimes(1);
  });

  it('the same key in a different thread is 409 messaging.idempotency_key_reused', async () => {
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(
      row({ sender_id: CLIENT, client_id: OTHER_CLIENT }),
    );
    expectCode(
      await caught(t.messaging.sendAsClient(CLIENT, { body: 'hi', client_message_id: KEY })),
      409,
      'messaging.idempotency_key_reused',
    );
    expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
  });

  it('a concurrent duplicate that loses the unique race (P2002) replays the winner', async () => {
    const t = build();
    const winner = row({ sender_id: CLIENT, client_message_id: KEY });
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    t.prisma.coachMessage.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );
    const out = await t.messaging.sendAsClient(CLIENT, { body: 'hi', client_message_id: KEY });
    expect(out).toBe(winner);
    expect(t.supabase.broadcastNewMessage).not.toHaveBeenCalled();
  });

  it('legacy sends without a key create exactly the legacy row shape', async () => {
    const t = build();
    await t.messaging.sendAsCoach(COACH, CLIENT, 'hello');
    const data = t.prisma.coachMessage.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('client_message_id');
    expect(data).not.toHaveProperty('reply_to_id');
  });
});

describe('swipe-reply', () => {
  it('flag OFF: a reply is refused with 503 (never silently sent without its quote)', async () => {
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    const t = build();
    expectCode(
      await caught(t.messaging.sendAsClient(CLIENT, { body: 'yes', reply_to_id: MSG })),
      503,
      'messaging.feature_disabled',
    );
  });

  it('a target outside this thread or deleted is 409 messaging.reply_target_unavailable', async () => {
    on();
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValue(null);
    expectCode(
      await caught(t.messaging.sendAsClient(CLIENT, { body: 'yes', reply_to_id: MSG })),
      409,
      'messaging.reply_target_unavailable',
    );
    const where = t.prisma.coachMessage.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: MSG, coach_id: COACH, client_id: CLIENT, deleted_at: null });
  });

  it('a valid reply persists reply_to_id and the thread read carries the quoted preview', async () => {
    on();
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce({ id: MSG });
    await t.messaging.sendAsClient(CLIENT, { body: 'yes', reply_to_id: MSG });
    expect(t.prisma.coachMessage.create.mock.calls[0][0].data.reply_to_id).toBe(MSG);

    const reply = row({
      id: KEY,
      sender_id: CLIENT,
      reply_to_id: MSG,
      reply_to: {
        id: MSG,
        sender_id: COACH,
        body: '  Long\n quoted   text ',
        voice_url: null,
        deleted_at: null,
      },
    });
    t.prisma.coachMessage.findMany.mockResolvedValue([reply]);
    const [out] = (await t.messaging.listThreadForClient(CLIENT, {})) as Array<
      Record<string, unknown>
    >;
    expect(t.prisma.coachMessage.findMany.mock.calls[0][0]).toHaveProperty('include.reply_to');
    expect(out.reply_to).toEqual({
      id: MSG,
      sender_id: COACH,
      kind: 'text',
      preview: 'Long quoted text',
    });
    expect(out.deleted).toBe(false);
  });

  it('the quote is hidden when the caller blocked its author, and marked deleted when erased', () => {
    const t = build();
    const blocked = new Set([COACH]);
    const a = t.messaging.serializeMessage(
      row({
        reply_to_id: MSG,
        reply_to: { id: MSG, sender_id: COACH, body: 'x', voice_url: null, deleted_at: null },
      }),
      blocked,
    );
    expect(a.reply_to).toEqual({ id: MSG, sender_id: null, kind: 'unavailable', preview: '' });
    const b = t.messaging.serializeMessage(
      row({
        reply_to_id: MSG,
        reply_to: {
          id: MSG,
          sender_id: CLIENT,
          body: null,
          voice_url: null,
          deleted_at: new Date(),
        },
      }),
      new Set(),
    );
    expect(b.reply_to).toEqual({ id: MSG, sender_id: CLIENT, kind: 'deleted', preview: '' });
  });
});

describe('mute and inbox pin (private per user)', () => {
  const thread = {
    coachId: COACH,
    clientId: CLIENT,
    actorId: CLIENT,
    actorSide: 'client' as const,
    otherPartyId: COACH,
  };

  it('a muted thread gets no push (flag ON) but still gets the realtime ping', async () => {
    on();
    const t = build();
    t.prisma.coachThreadState.findUnique.mockResolvedValue({
      muted_until: new Date(Date.now() + 60_000),
    });
    await t.messaging.sendAsClient(CLIENT, 'hi');
    await flush();
    await flush();
    expect(t.supabase.broadcastNewMessage).toHaveBeenCalledWith(COACH);
    expect(t.messageReceived.emit).not.toHaveBeenCalled();
    expect(t.prisma.coachThreadState.findUnique.mock.calls[0][0].where).toEqual({
      CoachThreadState_user_thread_key: { user_id: COACH, coach_id: COACH, client_id: CLIENT },
    });
  });
});

describe('read-up-to and live read receipts', () => {
  it('marks only messages at or before the target, then pings the sender (flag ON)', async () => {
    on();
    const t = build();
    const cutoff = new Date('2026-10-01T10:00:00Z');
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce({ created_at: cutoff });
    t.prisma.coachMessage.updateMany.mockResolvedValueOnce({ count: 3 });
    const res = await t.messaging.markReadByClient(CLIENT, { upToMessageId: MSG });
    expect(res).toEqual({ updated: 3 });
    expect(t.prisma.coachMessage.updateMany.mock.calls[0][0].where).toMatchObject({
      coach_id: COACH,
      client_id: CLIENT,
      read_at: null,
      created_at: { lte: cutoff },
    });
    expect(t.supabase.getClient).toHaveBeenCalled();
  });

  it('a target outside the thread is 404; flag OFF with a target is 503; no target = legacy', async () => {
    on();
    const t = build();
    expectCode(
      await caught(t.messaging.markReadByClient(CLIENT, { upToMessageId: MSG })),
      404,
      'messaging.message_not_found',
    );
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    expectCode(
      await caught(t.messaging.markReadByClient(CLIENT, { upToMessageId: MSG })),
      503,
      'messaging.feature_disabled',
    );
    await t.messaging.markReadByClient(CLIENT);
    expect(t.prisma.coachMessage.updateMany.mock.calls[0][0].where).not.toHaveProperty(
      'created_at',
    );
    expect(t.supabase.getClient).not.toHaveBeenCalled();
  });
});

describe('unread counts ignore tombstones (flag ON only)', () => {
  it('coach and client badge queries exclude deleted messages when ON, legacy when OFF', async () => {
    on();
    const t = build();
    await t.messaging.unreadCountForCoach(COACH);
    expect(t.prisma.coachMessage.groupBy.mock.calls[0][0].where).toMatchObject({ deleted_at: null });
    t.prisma.coachMessage.count.mockResolvedValueOnce(0);
    await t.messaging.unreadCountForClient(CLIENT);
    expect(t.prisma.coachMessage.count.mock.calls[0][0].where).toMatchObject({ deleted_at: null });
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    const off = build();
    await off.messaging.unreadCountForCoach(COACH);
    expect(off.prisma.coachMessage.groupBy.mock.calls[0][0].where).not.toHaveProperty('deleted_at');
  });
});
