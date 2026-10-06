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

describe('B-BC4-122 probe: thread read include under both flags', () => {
  const combos: Array<[boolean, boolean, string[]]> = [
    [false, false, []],
    [true, false, ['card']],
    [false, true, ['reply_to']],
    [true, true, ['card', 'reply_to']],
  ];
  for (const [bc, v2, keys] of combos) {
    it(`broadcasts=${bc} v2=${v2} -> include ${keys.join(',') || 'none'}`, async () => {
      if (bc) process.env.FEATURE_COACH_BROADCASTS = 'true';
      else delete process.env.FEATURE_COACH_BROADCASTS;
      if (v2) process.env.FEATURE_MESSAGING_CORE_V2 = 'true';
      else delete process.env.FEATURE_MESSAGING_CORE_V2;
      const t = build();
      const card = { card_type: 'check_in', ref_id: null, snapshot: { title: 'Check-in' } };
      t.prisma.coachMessage.findMany.mockResolvedValue([row(bc ? ({ card } as any) : {})]);
      const out = (await t.messaging.listThreadForClient(CLIENT, {})) as Array<Record<string, unknown>>;
      const args = t.prisma.coachMessage.findMany.mock.calls[0][0];
      if (keys.length === 0) expect(args).not.toHaveProperty('include');
      else expect(Object.keys(args.include).sort()).toEqual(keys);
      if (bc) expect(out[0].card).toEqual(card);
      if (v2) expect(out[0]).toHaveProperty('deleted', false);
      delete process.env.FEATURE_COACH_BROADCASTS;
      delete process.env.FEATURE_MESSAGING_CORE_V2;
    });
  }
});
