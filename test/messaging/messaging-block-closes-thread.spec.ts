/**
 * BLOCK-ALL-BE (agent 168), owner rule #168-4: a person-to-person block
 * closes every conversation between the two people both ways ("hide ALL
 * messaging entirely, dont even let the banned person type!"). Coaching 1:1:
 * thread, pins, inbox preview and unread, both directions; unblock restores.
 * FX-1141 (10-23 "Dissapear"): the closed chat leaves both inboxes; a direct
 * open answers 200 [] plus the closed header; no voice upload URL either way.
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
      findUnique: jest.fn().mockResolvedValue({ coach_id: COACH, name: 'Coach' }),
      findMany: jest.fn().mockResolvedValue([{ id: CLIENT, name: 'Client' }]),
    },
    coachMessage: {
      findFirst: jest.fn().mockResolvedValue(rows[1]),
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(3),
      groupBy: jest.fn().mockResolvedValue([{ client_id: CLIENT, _count: { _all: 3 } }]),
    },
    coachThreadState: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    userBlock: { findMany: jest.fn(async ({ where }: { where: BlockWhere }) => blockRows(blocks, where)) },
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

type BlockWhere = {
  blocked_id?: string;
  OR?: Array<{ blocker_id: string | { in: string[] }; blocked_id: string | { in: string[] } }>;
};
const hit = (v: string | { in: string[] }, id: string) => (typeof v === 'string' ? v === id : v.in.includes(id));
/** The two UserBlock reads: blockSets (blocked_id = me) and inBlockWith (OR). */
function blockRows(blocks: Array<[string, string]>, where: BlockWhere) {
  return blocks
    .filter(([a, b]) => (where.OR ? where.OR.some((o) => hit(o.blocker_id, a) && hit(o.blocked_id, b)) : b === where.blocked_id))
    .map(([a, b]) => ({ blocker_id: a, blocked_id: b }));
}
const VOICE = { duration_sec: 5, size_bytes: 1000, content_type: 'audio/mp4' };

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
    expect((await f.inbox.inboxForCoach(COACH, {})).items.map((i) => i.client_id)).toEqual([CLIENT]);
    expect(await f.messaging.unreadCountForClient(CLIENT)).toEqual({ total: 3 });
    const told = jest.fn();
    await f.messaging.listThreadForClient(CLIENT, {}, told);
    await f.messaging.listThreadForCoach(COACH, CLIENT, {}, told);
    expect(told).not.toHaveBeenCalled();
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
    // 10-23 "Dissapear": the chat leaves both lists (no row, no name, unread 0).
    expect(await f.inbox.inboxForClient(CLIENT)).toEqual({ items: [], next_cursor: null, total_unread: 0 });
    const coach = await f.inbox.inboxForCoach(COACH, {});
    expect(coach.items).toEqual([]);
    expect(coach.total_unread).toBe(0);
    expect(await f.messaging.unreadCountForClient(CLIENT)).toEqual({ total: 0 });
    // A direct open still answers closed, from each person's side.
    const clientSaw = jest.fn();
    const coachSaw = jest.fn();
    await f.messaging.listThreadForClient(CLIENT, {}, clientSaw);
    await f.messaging.listThreadForCoach(COACH, CLIENT, {}, coachSaw);
    const byClient = blocks[0][0] === CLIENT;
    expect(clientSaw).toHaveBeenCalledWith(byClient ? 'blocked_by_you' : 'blocked_by_them');
    expect(coachSaw).toHaveBeenCalledWith(byClient ? 'blocked_by_them' : 'blocked_by_you');
  });

  it('B5: no voice upload URL across a block, either side, either direction', async () => {
    const control = fixture([]);
    const okUpload = jest.fn().mockResolvedValue({ upload_url: 'u', public_url: 'p' });
    Reflect.set(control.messaging, 'voiceUpload', { createSignedUpload: okUpload });
    await control.messaging.createThreadVoiceUpload(CLIENT, null, VOICE);
    await control.messaging.createThreadVoiceUpload(COACH, CLIENT, VOICE);
    expect(okUpload).toHaveBeenCalledTimes(2);
    for (const blocks of [[[COACH, CLIENT]], [[CLIENT, COACH]]] as Array<Array<[string, string]>>) {
      const f = fixture(blocks);
      const upload = jest.fn();
      Reflect.set(f.messaging, 'voiceUpload', { createSignedUpload: upload });
      for (const call of [() => f.messaging.createThreadVoiceUpload(CLIENT, null, VOICE), () => f.messaging.createThreadVoiceUpload(COACH, CLIENT, VOICE)]) {
        await expect(call()).rejects.toMatchObject({ status: 403, response: { code: 'messaging.blocked' } });
      }
      expect(upload).not.toHaveBeenCalled();
    }
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
