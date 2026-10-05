/**
 * Independent Sol regression replay for FIX ROUND 3 at #711 3d0a615e.
 * The public-ping call is adapted only to the intentionally reduced signature.
 * These are not production edits.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
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
import { MessageActionsService } from '../../src/messaging/message-actions.service';
import { MessagingInboxService } from '../../src/messaging/messaging-inbox.service';
import { broadcastThreadUpdated } from '../../src/messaging/messaging-realtime';

const HEAD = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const SUB = '33333333-3333-4333-8333-333333333333';
const MSG = '44444444-4444-4444-8444-444444444444';

function dep<T extends object>(cls: { prototype: T }, impl: object): T {
  return Object.assign(Object.create(cls.prototype) as T, impl);
}

function row(over: Partial<CoachMessage> = {}): CoachMessage {
  return {
    id: MSG, coach_id: HEAD, client_id: CLIENT, sender_id: SUB,
    body: 'A blocked sub-coach message', created_at: new Date(),
    voice_url: null, voice_duration_sec: null, voice_size_bytes: null,
    voice_content_type: null, read_at: null, ai_draft_id: null,
    welcome_job_id: null, client_message_id: null, reply_to_id: null,
    edited_at: null, deleted_at: null, deleted_by_id: null,
    pinned_at: null, pinned_by_id: null, ...over,
  };
}

function fixture() {
  const tx = {
    coachMessage: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    user: {
      // Direct head-coach lookup fails for SUB; subsequent client lookup
      // succeeds after the real resolver verifies an open assignment.
      findFirst: jest.fn(async ({ where }: { where: { coach_id?: string } }) =>
        where.coach_id === SUB ? null : { id: CLIENT, coach_id: HEAD },
      ),
      findUnique: jest.fn().mockResolvedValue({ coach_id: HEAD, name: 'Head coach' }),
      findMany: jest.fn().mockResolvedValue([{ id: CLIENT, name: 'Client' }]),
    },
    subCoachAssignment: { findFirst: jest.fn().mockResolvedValue({ id: 'assignment' }) },
    coachMessage: {
      findFirst: jest.fn().mockResolvedValue(row()),
      findMany: jest.fn().mockResolvedValue([row()]),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    coachThreadState: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([row()]),
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const safety = {
    getBlockedIdsFor: jest.fn(async (who: string) => who === CLIENT ? [SUB] : []),
    isEitherSideBlocked: jest.fn(async (a: string, b: string) =>
      (a === SUB && b === CLIENT) || (a === CLIENT && b === SUB),
    ),
  };
  const scope = {
    getHeadCoachIdForSubCoach: jest.fn(async (who: string) => who === SUB ? HEAD : null),
    getAuthorizedClientIds: jest.fn().mockResolvedValue([CLIENT]),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const prismaDep = dep(PrismaService, prisma);
  const auditDep = dep(AuditService, audit);
  const scopeDep = dep(SubCoachScopeService, scope);
  const messaging = new MessagingService(
    prismaDep,
    dep(SupabaseService, {
      getClient: () => ({
        channel: () => ({
          subscribe: (cb: (s: string) => void) => cb('SUBSCRIBED'),
          send: jest.fn().mockResolvedValue('ok'),
        }),
        removeChannel: jest.fn().mockResolvedValue('ok'),
      }),
    }),
    dep(AnalyticsService, { capture: jest.fn() }),
    dep(PtmService, { emit: jest.fn() }),
    dep(MessageReceivedEmitter, { emit: jest.fn().mockResolvedValue(undefined) }),
    auditDep,
    dep(ClientAIContextService, { invalidateForUser: jest.fn() }),
    dep(MessagesSafetyService, safety),
    scopeDep,
  );
  return {
    prisma, tx, safety, messaging,
    actions: new MessageActionsService(prismaDep, messaging, auditDep),
    inbox: new MessagingInboxService(prismaDep, messaging, scopeDep),
  };
}

const savedFlag = process.env.FEATURE_MESSAGING_CORE_V2;
beforeEach(() => { process.env.FEATURE_MESSAGING_CORE_V2 = 'true'; });
afterEach(() => {
  if (savedFlag === undefined) delete process.env.FEATURE_MESSAGING_CORE_V2;
  else process.env.FEATURE_MESSAGING_CORE_V2 = savedFlag;
});

describe('Sol messaging safety/privacy probes', () => {
  it('B-709-1: a public broadcast must not carry private client/message identifiers', async () => {
    const send = jest.fn().mockResolvedValue('ok');
    const channel = jest.fn(() => ({
      subscribe: (cb: (s: string) => void) => cb('SUBSCRIBED'),
      send,
    }));
    const supabase = dep(SupabaseService, {
      getClient: () => ({ channel, removeChannel: jest.fn().mockResolvedValue('ok') }),
    });
    await broadcastThreadUpdated(supabase, HEAD);
    const options = (channel.mock.calls[0] as unknown[])[1] as
      { config?: { private?: boolean } } | undefined;
    if (options?.config?.private !== true) {
      // The existing public channel can safely carry a refresh ping, but not
      // the client's identity, the message identity or the action performed.
      expect(send.mock.calls[0][0].payload).toEqual({});
    }
  });

  it('B-710-1/edit: a client-blocked sub-coach cannot edit through the head-coach namespace', async () => {
    const f = fixture();
    const thread = await f.messaging.resolveThreadForCoach(SUB, CLIENT);
    expect(thread).toMatchObject({ actorId: SUB, coachId: HEAD, otherPartyId: CLIENT });
    await expect(f.actions.edit(thread, MSG, 'Rewritten after being blocked')).rejects
      .toBeInstanceOf(HttpException);
    expect(f.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
  });

  it('B-710-1/pin: a client-blocked sub-coach cannot pin a head-coach message to the client', async () => {
    const f = fixture();
    f.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ sender_id: HEAD }));
    const thread = await f.messaging.resolveThreadForCoach(SUB, CLIENT);
    await expect(f.actions.pin(thread, MSG)).rejects.toBeInstanceOf(HttpException);
    expect(f.tx.coachMessage.updateMany).not.toHaveBeenCalled();
  });

  it('B-710-2: client inbox must not show content from a blocked sub-coach sender', async () => {
    const f = fixture();
    const result = await f.inbox.inboxForClient(CLIENT);
    expect(result.items).toHaveLength(1);
    // Keep the head-coach conversation available; suppress or seek past the
    // blocked sender rather than exposing their text as an inbox preview.
    expect(result.items[0].last_message?.sender_id).not.toBe(SUB);
    expect(JSON.stringify(result)).not.toContain('A blocked sub-coach message');
  });

  it('control: edit remains author-only for an ordinary client', async () => {
    const f = fixture();
    f.prisma.coachMessage.findFirst.mockResolvedValueOnce(row({ sender_id: HEAD }));
    const thread = await f.messaging.resolveThreadForClient(CLIENT);
    await expect(f.actions.edit(thread, MSG, 'spoof')).rejects.toBeInstanceOf(HttpException);
    expect(f.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
  });

  it('control: pins already suppress every blocked author, including sub-coaches', async () => {
    const f = fixture();
    const thread = await f.messaging.resolveThreadForClient(CLIENT);
    const result = await f.actions.listPins(thread);
    expect(result.items).toEqual([]);
  });
});
