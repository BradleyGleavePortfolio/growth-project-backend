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
  MAX_PINS_PER_THREAD,
  MessageActionsService,
  MESSAGE_EDIT_WINDOW_MS,
  MUTE_FOREVER_UNTIL,
} from '../../src/messaging/message-actions.service';
import { MessagingInboxService } from '../../src/messaging/messaging-inbox.service';
import {
  isMessagingCoreV2Enabled,
  MessagingCoreV2Guard,
} from '../../src/messaging/messaging-core.feature';
import { resolveIdempotencyKey } from '../../src/messaging/messaging-idempotency';
import { broadcastThreadUpdated } from '../../src/messaging/messaging-realtime';

const COACH = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIENT = '33333333-3333-4333-8333-333333333333';
const SUB = '44444444-4444-4444-8444-444444444444';
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
  const actions = new MessageActionsService(prismaDep, messaging, auditDep);
  const inbox = new MessagingInboxService(prismaDep, messaging, scopeDep);
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
    actions,
    inbox,
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

  it('Idempotency-Key header folds into the body key; bad or mismatched keys are coded 400s', () => {
    expect(resolveIdempotencyKey(undefined, undefined)).toBeUndefined();
    expect(resolveIdempotencyKey(KEY.toUpperCase(), undefined)).toBe(KEY);
    expect(resolveIdempotencyKey(KEY, KEY)).toBe(KEY);
    let e1: unknown;
    try {
      resolveIdempotencyKey('not-a-uuid', undefined);
    } catch (e) {
      e1 = e;
    }
    expectCode(e1, 400, 'messaging.idempotency_key_invalid');
    let e2: unknown;
    try {
      resolveIdempotencyKey(KEY, MSG);
    } catch (e) {
      e2 = e;
    }
    expectCode(e2, 400, 'messaging.idempotency_key_mismatch');
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

describe('edit', () => {
  const thread = {
    coachId: COACH,
    clientId: CLIENT,
    actorId: COACH,
    actorSide: 'coach' as const,
    otherPartyId: CLIENT,
  };

  it('only the author, only live messages, only inside 48 hours', async () => {
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ sender_id: CLIENT }));
    expectCode(await caught(t.actions.edit(thread, MSG, 'new')), 403, 'messaging.not_author');
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ deleted_at: new Date() }));
    expectCode(await caught(t.actions.edit(thread, MSG, 'new')), 409, 'messaging.message_deleted');
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(
      row({ created_at: new Date(Date.now() - MESSAGE_EDIT_WINDOW_MS - 1000) }),
    );
    expectCode(
      await caught(t.actions.edit(thread, MSG, 'new')),
      409,
      'messaging.edit_window_closed',
    );
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(
      row({ body: null, voice_url: 'https://x/voice-notes/a/b.m4a' }),
    );
    expectCode(await caught(t.actions.edit(thread, MSG, '  ')), 400, 'messaging.not_editable');
    expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
  });

  it('a message id from another thread is 404 (lookup bound to the thread)', async () => {
    const t = build();
    expectCode(
      await caught(t.actions.edit(thread, MSG, 'new')),
      404,
      'messaging.message_not_found',
    );
    expect(t.prisma.coachMessage.findFirst.mock.calls[0][0].where).toEqual({
      id: MSG,
      coach_id: COACH,
      client_id: CLIENT,
    });
  });

  it('blocked either way → 403 messaging.blocked', async () => {
    const t = build({ eitherBlocked: true });
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row());
    expectCode(await caught(t.actions.edit(thread, MSG, 'new')), 403, 'messaging.blocked');
  });

  it('success: conditional write, edited_at, text-free audit, ping, AI cache bust', async () => {
    on();
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row());
    const out = await t.actions.edit(thread, MSG, '  Fixed words ');
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, deleted_at: null },
      data: { body: 'Fixed words', edited_at: expect.any(Date) },
    });
    expect(out.body).toBe('Fixed words');
    const auditCall = t.audit.write.mock.calls[0][0];
    expect(auditCall.action).toBe('messaging.edited');
    expect(JSON.stringify(auditCall)).not.toMatch(/Fixed words|Original words/);
    expect(t.aiContext.invalidateForUser).toHaveBeenCalledWith(CLIENT);
  });

  it('a concurrent delete wins over an edit (0 rows → 409 deleted)', async () => {
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row());
    t.prisma.coachMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    expectCode(await caught(t.actions.edit(thread, MSG, 'new')), 409, 'messaging.message_deleted');
    expect(t.audit.write).not.toHaveBeenCalled();
  });
});

describe('delete (tombstone)', () => {
  const thread = {
    coachId: COACH,
    clientId: CLIENT,
    actorId: CLIENT,
    actorSide: 'client' as const,
    otherPartyId: COACH,
  };

  it('erases content + pin in one transaction and records durable voice erasure for the object', async () => {
    const t = build();
    const url = `https://proj.supabase.co/storage/v1/object/public/voice-notes/${CLIENT}/note-1.m4a`;
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(
      row({ sender_id: CLIENT, voice_url: url, voice_duration_sec: 12, pinned_at: new Date() }),
    );
    const out = await t.actions.delete(thread, MSG);
    expect(t.tx.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: MSG, deleted_at: null },
      data: expect.objectContaining({
        body: null,
        voice_url: null,
        voice_duration_sec: null,
        deleted_at: expect.any(Date),
        deleted_by_id: CLIENT,
        pinned_at: null,
      }),
    });
    expect(t.tx.communityVoiceErasure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind_target: { kind: 'object', target: `${CLIENT}/note-1.m4a` } },
        create: expect.objectContaining({ reason: 'author_delete' }),
      }),
    );
    expect(out.deleted).toBe(true);
    expect(out.body).toBeNull();
    expect(JSON.stringify(t.audit.write.mock.calls[0][0])).not.toMatch(/Original words/);
  });

  it('never sends a non-signable or foreign-folder key to storage', async () => {
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(
      row({ sender_id: CLIENT, voice_url: `https://x/voice-notes/${COACH}/note.m4a` }),
    );
    await t.actions.delete(thread, MSG);
    expect(t.tx.communityVoiceErasure.upsert).not.toHaveBeenCalled();
  });

  it('is idempotent and author-only, and closes after 48 hours', async () => {
    const t = build();
    const tomb = row({ sender_id: CLIENT, body: null, deleted_at: new Date() });
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(tomb);
    expect((await t.actions.delete(thread, MSG)).deleted).toBe(true);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ sender_id: COACH }));
    expectCode(await caught(t.actions.delete(thread, MSG)), 403, 'messaging.not_author');
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(
      row({ sender_id: CLIENT, created_at: new Date(Date.now() - 49 * 3600 * 1000) }),
    );
    expectCode(await caught(t.actions.delete(thread, MSG)), 409, 'messaging.delete_window_closed');
  });

  it('delete is allowed even when the thread is blocked (removing your own words)', async () => {
    const t = build({ eitherBlocked: true });
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ sender_id: CLIENT }));
    await expect(t.actions.delete(thread, MSG)).resolves.toMatchObject({ deleted: true });
  });
});

describe('message pins', () => {
  const thread = {
    coachId: COACH,
    clientId: CLIENT,
    actorId: CLIENT,
    actorSide: 'client' as const,
    otherPartyId: COACH,
  };

  it('either participant may pin; the per-thread cap is enforced under a thread lock', async () => {
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row());
    t.tx.coachMessage.count.mockResolvedValueOnce(MAX_PINS_PER_THREAD);
    expectCode(await caught(t.actions.pin(thread, MSG)), 409, 'messaging.pin_limit_reached');
    expect(t.tx.$executeRaw).toHaveBeenCalled();

    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row());
    const out = await t.actions.pin(thread, MSG);
    expect(out.pinned_at).toBeInstanceOf(Date);
    expect(out.pinned_by_id).toBe(CLIENT);
    expect(t.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'messaging.pinned' }),
    );
  });

  it('deleted messages cannot be pinned; blocked threads cannot pin; unpin is idempotent', async () => {
    const t = build();
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ deleted_at: new Date() }));
    expectCode(await caught(t.actions.pin(thread, MSG)), 409, 'messaging.message_deleted');
    const b = build({ eitherBlocked: true });
    b.prisma.coachMessage.findFirst.mockResolvedValueOnce(row());
    expectCode(await caught(b.actions.pin(thread, MSG)), 403, 'messaging.blocked');
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ pinned_at: null }));
    await t.actions.unpin(thread, MSG);
    expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
  });

  it('the pins bar hides pins authored by someone the caller blocked', async () => {
    const t = build({ blocked: [COACH] });
    t.prisma.coachMessage.findMany.mockResolvedValueOnce([
      row({ id: 'a', sender_id: COACH, pinned_at: new Date() }),
      row({ id: 'b', sender_id: CLIENT, pinned_at: new Date() }),
    ]);
    const out = await t.actions.listPins(thread);
    expect(out.items.map((i) => i.id)).toEqual(['b']);
  });

  it('a message authored by a blocked party is not addressable (404)', async () => {
    const t = build({ blocked: [COACH] });
    t.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ sender_id: COACH }));
    expectCode(await caught(t.actions.pin(thread, MSG)), 404, 'messaging.message_not_found');
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

  it('mute durations map to muted_until; forever is the sentinel; off clears', async () => {
    const t = build();
    const r1 = await t.actions.setMute(thread, '8h');
    expect(r1.muted).toBe(true);
    const until = new Date(r1.muted_until as string).getTime();
    expect(Math.abs(until - (Date.now() + 8 * 3600 * 1000))).toBeLessThan(5000);
    const r2 = await t.actions.setMute(thread, 'forever');
    expect(r2.muted_until).toBe(MUTE_FOREVER_UNTIL.toISOString());
    const r3 = await t.actions.setMute(thread, 'off');
    expect(r3).toEqual({ muted: false, muted_until: null, pinned: false });
    expect(t.prisma.coachThreadState.upsert.mock.calls[0][0].where).toEqual({
      CoachThreadState_user_thread_key: { user_id: CLIENT, coach_id: COACH, client_id: CLIENT },
    });
  });

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

  it('an expired mute, a lookup failure, or flag OFF all deliver the push', async () => {
    on();
    const t = build();
    t.prisma.coachThreadState.findUnique.mockResolvedValueOnce({
      muted_until: new Date(Date.now() - 1),
    });
    await t.messaging.sendAsClient(CLIENT, 'hi');
    await flush();
    await flush();
    expect(t.messageReceived.emit).toHaveBeenCalledTimes(1);
    t.prisma.coachThreadState.findUnique.mockRejectedValueOnce(new Error('db down'));
    await t.messaging.sendAsClient(CLIENT, 'hi');
    await flush();
    await flush();
    expect(t.messageReceived.emit).toHaveBeenCalledTimes(2);
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    const off = build();
    off.prisma.coachThreadState.findUnique.mockResolvedValue({ muted_until: MUTE_FOREVER_UNTIL });
    await off.messaging.sendAsClient(CLIENT, 'hi');
    await flush();
    expect(off.prisma.coachThreadState.findUnique).not.toHaveBeenCalled();
    expect(off.messageReceived.emit).toHaveBeenCalledTimes(1);
  });

  it('inbox pins cap at 5 per user', async () => {
    const t = build();
    t.tx.coachThreadState.count.mockResolvedValueOnce(5);
    expectCode(
      await caught(t.actions.setInboxPin(thread, true)),
      409,
      'messaging.inbox_pin_limit_reached',
    );
    const ok = await t.actions.setInboxPin(thread, true);
    expect(ok.pinned).toBe(true);
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

describe('unified inbox', () => {
  const at = (iso: string) => new Date(iso);

  function lastRows() {
    return [
      {
        id: 'm1',
        client_id: CLIENT,
        sender_id: CLIENT,
        body: 'Hello coach',
        voice_url: null,
        deleted_at: null,
        edited_at: null,
        created_at: at('2026-10-01T09:00:00Z'),
      },
      {
        id: 'm2',
        client_id: OTHER_CLIENT,
        sender_id: COACH,
        body: null,
        voice_url: null,
        deleted_at: at('2026-10-02T09:00:00Z'),
        edited_at: null,
        created_at: at('2026-10-02T08:00:00Z'),
      },
    ];
  }

  it('coach: newest activity first, unread from the badge computation, tombstone preview', async () => {
    const t = build();
    t.prisma.$queryRaw.mockResolvedValueOnce(lastRows());
    t.prisma.coachMessage.groupBy.mockResolvedValueOnce([
      { client_id: CLIENT, _count: { _all: 2 } },
    ]);
    t.prisma.user.findMany.mockResolvedValueOnce([
      { id: CLIENT, name: 'Sam' },
      { id: OTHER_CLIENT, name: 'Alex' },
    ]);
    const out = await t.inbox.inboxForCoach(COACH, {});
    expect(out.items.map((i) => i.client_id)).toEqual([OTHER_CLIENT, CLIENT]);
    expect(out.items[0].last_message).toMatchObject({
      kind: 'deleted',
      preview: '',
      is_mine: true,
    });
    expect(out.items[1]).toMatchObject({ unread_count: 2, counterpart: { display_name: 'Sam' } });
    expect(out.total_unread).toBe(2);
  });

  it('coach: pinned threads first; blocked threads hide the preview and unread', async () => {
    const t = build({ blocked: [OTHER_CLIENT] });
    t.prisma.$queryRaw.mockResolvedValueOnce(lastRows());
    t.prisma.coachThreadState.findMany.mockResolvedValueOnce([
      { client_id: CLIENT, muted_until: MUTE_FOREVER_UNTIL, pinned_at: at('2026-09-01T00:00:00Z') },
    ]);
    const out = await t.inbox.inboxForCoach(COACH, {});
    expect(out.items[0]).toMatchObject({ client_id: CLIENT, pinned: true, muted: true });
    expect(out.items[1]).toMatchObject({
      client_id: OTHER_CLIENT,
      blocked_by_me: true,
      last_message: null,
      unread_count: 0,
    });
  });

  it('tenancy: the query is bound to the scope (head coach namespace, authorized clients only)', async () => {
    const t = build();
    t.subCoachScope.getHeadCoachIdForSubCoach.mockResolvedValueOnce(COACH);
    t.subCoachScope.getAuthorizedClientIds.mockResolvedValue([CLIENT]);
    t.prisma.$queryRaw.mockResolvedValueOnce([]);
    await t.inbox.inboxForCoach(SUB, {});
    const sql = t.prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toEqual([COACH, [CLIENT]]);
    t.subCoachScope.getAuthorizedClientIds.mockResolvedValue([]);
    const none = await t.inbox.inboxForCoach(SUB, {});
    expect(none).toEqual({ items: [], next_cursor: null, total_unread: 0 });
    expect(t.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('keyset cursor pages without gaps or repeats; unread filter', async () => {
    const t = build();
    t.prisma.$queryRaw.mockResolvedValue(lastRows());
    t.prisma.coachMessage.groupBy.mockResolvedValue([{ client_id: CLIENT, _count: { _all: 1 } }]);
    const p1 = await t.inbox.inboxForCoach(COACH, { limit: 1 });
    expect(p1.items.map((i) => i.client_id)).toEqual([OTHER_CLIENT]);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await t.inbox.inboxForCoach(COACH, { limit: 1, cursor: p1.next_cursor as string });
    expect(p2.items.map((i) => i.client_id)).toEqual([CLIENT]);
    expect(p2.next_cursor).toBeNull();
    const unread = await t.inbox.inboxForCoach(COACH, { filter: 'unread' });
    expect(unread.items.map((i) => i.client_id)).toEqual([CLIENT]);
  });

  it('client: coachless is a valid empty inbox; coached shows the one coach thread', async () => {
    const t = build();
    t.prisma.user.findUnique.mockResolvedValueOnce({ coach_id: null });
    expect(await t.inbox.inboxForClient(CLIENT)).toEqual({
      items: [],
      next_cursor: null,
      total_unread: 0,
    });
    t.prisma.user.findUnique.mockResolvedValue({ coach_id: COACH, name: 'Coach Name' });
    t.prisma.coachMessage.count = jest.fn().mockResolvedValue(4);
    const out = await t.inbox.inboxForClient(CLIENT);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      coach_id: COACH,
      unread_count: 4,
      last_message: null,
      counterpart: { user_id: COACH },
    });
  });
});

describe('thread-updated ping on the public channel (B-709-1)', () => {
  it('carries an empty payload: no client id, message id or change kind', async () => {
    const send = jest.fn().mockResolvedValue('ok');
    const channel = jest.fn(() => ({
      subscribe: (cb: (s: string) => void) => cb('SUBSCRIBED'),
      send,
    }));
    const supabase = dep(SupabaseService, {
      getClient: () => ({ channel, removeChannel: jest.fn().mockResolvedValue('ok') }),
    });
    await broadcastThreadUpdated(supabase, COACH);
    expect(channel).toHaveBeenCalledWith(`messages:${COACH}`);
    expect(send).toHaveBeenCalledWith({ type: 'broadcast', event: 'thread-updated', payload: {} });
  });
});
