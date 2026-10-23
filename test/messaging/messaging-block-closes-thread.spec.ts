/**
 * BLOCK-ALL-BE (agent 168), owner rule #168-4: a person-to-person block
 * closes every conversation between the two people both ways ("hide ALL
 * messaging entirely, dont even let the banned person type!"). Coaching 1:1:
 * thread, pins, inbox preview and unread, both directions; unblock restores.
 */
import 'reflect-metadata';
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

const COACH = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

function dep<T extends object>(cls: { prototype: T }, impl: object): T {
  return Object.assign(Object.create(cls.prototype) as T, impl);
}

const msg = (id: string, sender: string): CoachMessage => ({
  id, coach_id: COACH, client_id: CLIENT, sender_id: sender, body: `hello from ${sender.slice(0, 2)}`,
  created_at: new Date('2026-10-20T10:00:00Z'), voice_url: null, voice_duration_sec: null, voice_size_bytes: null,
  voice_content_type: null, read_at: null, ai_draft_id: null, welcome_job_id: null, automated_by: null,
  client_message_id: null, reply_to_id: null, edited_at: null, deleted_at: null, deleted_by_id: null,
  pinned_at: new Date('2026-10-20T11:00:00Z'), pinned_by_id: COACH,
});

function fixture(blocks: Array<[blocker: string, blocked: string]>) {
  const rows = [msg('m-coach', COACH), msg('m-client', CLIENT)];
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT, coach_id: COACH }),
      findUnique: jest.fn().mockResolvedValue({ coach_id: COACH, name: 'Corey Coach' }),
      findMany: jest.fn().mockResolvedValue([{ id: CLIENT, name: 'Casey Client' }]),
    },
    coachMessage: {
      findFirst: jest.fn().mockResolvedValue(rows[1]),
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(3),
      groupBy: jest.fn().mockResolvedValue([{ client_id: CLIENT, _count: { _all: 3 } }]),
    },
    coachThreadState: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    userBlock: {
      findMany: jest.fn(async ({ where }: { where: { blocked_id: string } }) =>
        blocks.filter(([, b]) => b === where.blocked_id).map(([a]) => ({ blocker_id: a }))),
    },
    $queryRaw: jest.fn().mockResolvedValue([rows[1]]),
  };
  const safety = {
    getBlockedIdsFor: jest.fn(async (who: string) => blocks.filter(([a]) => a === who).map(([, b]) => b)),
    isEitherSideBlocked: jest.fn(async (a: string, b: string) =>
      blocks.some(([x, y]) => (x === a && y === b) || (x === b && y === a))),
  };
  const scope = { getHeadCoachIdForSubCoach: jest.fn().mockResolvedValue(null), getAuthorizedClientIds: jest.fn().mockResolvedValue([CLIENT]) };
  const prismaDep = dep(PrismaService, prisma);
  const scopeDep = dep(SubCoachScopeService, scope);
  const messaging = new MessagingService(
    prismaDep,
    dep(SupabaseService, { getClient: () => ({ channel: () => ({ subscribe: jest.fn(), send: jest.fn() }), removeChannel: jest.fn() }) }),
    dep(AnalyticsService, { capture: jest.fn() }),
    dep(PtmService, { emit: jest.fn() }),
    dep(MessageReceivedEmitter, { emit: jest.fn() }),
    dep(AuditService, { write: jest.fn() }),
    dep(ClientAIContextService, { invalidateForUser: jest.fn() }),
    dep(MessagesSafetyService, safety),
    scopeDep,
  );
  return {
    prisma, messaging,
    actions: new MessageActionsService(prismaDep, messaging, dep(AuditService, { write: jest.fn() })),
    inbox: new MessagingInboxService(prismaDep, messaging, scopeDep),
  };
}

const ids = (page: unknown) => (page as Array<{ id: string }>).map((m) => m.id).sort();
const savedFlag = process.env.FEATURE_MESSAGING_CORE_V2;
beforeEach(() => { process.env.FEATURE_MESSAGING_CORE_V2 = 'true'; });
afterEach(() => {
  if (savedFlag === undefined) delete process.env.FEATURE_MESSAGING_CORE_V2;
  else process.env.FEATURE_MESSAGING_CORE_V2 = savedFlag;
});

describe('#168-4: a block closes the coaching 1:1 thread both ways', () => {
  it('control: no block, both people read the whole thread, pins, preview and unread', async () => {
    const f = fixture([]);
    expect(ids(await f.messaging.listThreadForClient(CLIENT, {}))).toEqual(['m-client', 'm-coach']);
    expect(ids(await f.messaging.listThreadForCoach(COACH, CLIENT, {}))).toEqual(['m-client', 'm-coach']);
    const pins = await f.actions.listPins(await f.messaging.resolveThreadForClient(CLIENT));
    expect(pins.items).toHaveLength(2);
    const inbox = await f.inbox.inboxForClient(CLIENT);
    expect(inbox.items[0]).toMatchObject({ blocked_by_me: false, closed: false, unread_count: 3 });
    expect(inbox.items[0].last_message).not.toBeNull();
    expect(await f.messaging.unreadCountForClient(CLIENT)).toEqual({ total: 3 });
  });

  it.each([
    ['the coach blocked the client', [[COACH, CLIENT]] as Array<[string, string]>],
    ['the client blocked the coach', [[CLIENT, COACH]] as Array<[string, string]>],
  ])('%s: neither person reads any message, pin, preview or unread count', async (_label, blocks) => {
    const f = fixture(blocks);
    expect(await f.messaging.listThreadForClient(CLIENT, {})).toEqual([]);
    expect(await f.messaging.listThreadForCoach(COACH, CLIENT, {})).toEqual([]);
    expect((await f.actions.listPins(await f.messaging.resolveThreadForClient(CLIENT))).items).toEqual([]);
    expect((await f.actions.listPins(await f.messaging.resolveThreadForCoach(COACH, CLIENT))).items).toEqual([]);
    const client = (await f.inbox.inboxForClient(CLIENT)).items[0];
    expect(client).toMatchObject({ closed: true, blocked_by_me: blocks[0][0] === CLIENT, last_message: null, unread_count: 0 });
    const coach = (await f.inbox.inboxForCoach(COACH, {})).items[0];
    expect(coach).toMatchObject({ closed: true, blocked_by_me: blocks[0][0] === COACH, last_message: null, unread_count: 0 });
    // #169-5 CLOSED-LINE: each row names the other person, so the blocked side can read "{N} has blocked you".
    expect(client.counterpart).toEqual({ user_id: COACH, display_name: 'Corey Coach' });
    expect(coach.counterpart).toEqual({ user_id: CLIENT, display_name: 'Casey Client' });
    expect(await f.messaging.unreadCountForClient(CLIENT)).toEqual({ total: 0 });
  });

  it.each([
    ['the client', (f: ReturnType<typeof fixture>) => f.messaging.sendAsClient(CLIENT, 'still there?')],
    ['the coach', (f: ReturnType<typeof fixture>) => f.messaging.sendAsCoach(COACH, CLIENT, 'still there?')],
  ])('%s cannot type to the other person, whichever side blocked', async (_who, send) => {
    for (const blocks of [[[COACH, CLIENT]], [[CLIENT, COACH]]] as Array<Array<[string, string]>>) {
      await expect(send(fixture(blocks))).rejects.toMatchObject({ status: 403, response: { error: 'BLOCKED' } });
    }
  });
});
