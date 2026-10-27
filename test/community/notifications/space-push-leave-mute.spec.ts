// LEAVE-MUTE-PUSH (owner D2, #170-1): the space chat push obeys leave and mute, when it is queued and again at the
// moment of sending. Real chain messageStored -> sendPush -> outbox -> drain -> Expo (mocked). The reads are b#1168's
// rows through PrismaService (community_space_reads.left_at, community_thread_prefs): one world for both steps.
import { Logger } from '@nestjs/common';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import { CommunitySpacePushService } from '../../../src/community/space-push/community-space-push.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../../../src/prisma.service';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';
import { spaceAtSendTime } from '../../utils/space-push-send-time-fake';

const NOW = new Date('2026-10-23T18:00:00Z'); // 11:00 in Los Angeles: no quiet hours
const HOUR = 3_600_000;
const PEOPLE = ['ana', 'bo', 'cy'] as const;
const TOKEN: Record<string, string> = Object.fromEntries(PEOPLE.map((p) => [p, `ExponentPushToken[${p[0].repeat(22)}]`]));
const stub = <T>(v: unknown): T => v as T;
type Where = { id?: string; user_id?: { in: string[] }; thread_message_id?: string; cohort_id?: string; state?: { in: readonly string[] } };

let log: jest.SpyInstance;
beforeAll(() => {
  ['warn', 'error'].forEach((l) => jest.spyOn(Logger.prototype, l as 'warn').mockImplementation(() => undefined));
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
  jest.setSystemTime(NOW);
  log.mockClear();
  process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
});
afterEach(() => jest.useRealTimers());
afterAll(() => void delete process.env.FEATURE_COMMUNITY_SPACE_PUSH);

// sam writes in the chat space c1; p1 is ana's thread. Everyone is on All unless a test says otherwise.
function world() {
  const w = pushOutboxWorld({ now: () => new Date(), tokens: TOKEN });
  const send = jest.fn(async (m: Array<{ to: unknown }>) => m.map(() => ({ status: 'ok' as const, id: 't' })));
  const at = spaceAtSendTime(w.db, 'chat');
  const s = at.s;
  for (const p of PEOPLE) s.reads[p] = { notify_mode: 'all', silenced_until: null, left_at: null };
  s.messages.push({ id: 'p1', workspace_id: 'w', cohort_id: 'c1', sender_id: 'ana', parent_message_id: null, high_alert: false });
  const delivery = new PushDeliveryService(stub<PrismaService>(at.db), { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(w.db), undefined, undefined, delivery);
  const queued: Promise<unknown>[] = [];
  const real = notifications.sendPush.bind(notifications);
  jest.spyOn(notifications, 'sendPush').mockImplementation((...a) => {
    const p = real(...a);
    queued.push(p);
    return p;
  });
  const threadPrefs = jest.fn(async ({ where }: { where: Where }) =>
    (where.user_id?.in ?? [])
      .filter((u) => {
        const state = s.threads[`${u}:${where.thread_message_id}`];
        return state && (!where.state || where.state.in.includes(state));
      })
      .map((user_id) => ({ user_id })),
  );
  const prisma = {
    communityMessage: { findFirst: async ({ where }: { where: Where }) => s.messages.find((m) => m.id === where.id && !m.deleted_at) ?? null },
    communityCohort: { findUnique: async () => ({ name: 'Team' }), findUniqueOrThrow: async () => ({ kind: 'chat' }), findMany: async () => [] },
    communityWorkspaceBan: { findFirst: async () => null },
    user: { findUnique: async () => ({ name: 'Sam Rivers' }) },
    userBlock: { findMany: async () => [] },
    communitySpaceRead: {
      findMany: async ({ where }: { where: Where }) =>
        (where.user_id?.in ?? []).filter((u) => s.reads[u]).map((u) => ({ user_id: u, left_at: null, ...s.reads[u] })),
    },
    communityThreadPref: { findMany: threadPrefs },
    // readersNow (everyone who may read c1 now, the sender too), then one unread count per reader on All
    $queryRaw: async (sql: TemplateStringsArray) =>
      sql.join('?').includes('community_space_reads') ? [{ c: 'c1', n: s.unread }] : ['sam', ...PEOPLE].map((id) => ({ id })),
  };
  const realtime = stub<CommunityRealtimeService>({ onSpaceMessageStored: jest.fn() });
  const svc = new CommunitySpacePushService(stub<PrismaService>(prisma), notifications, realtime);
  let n = 0;
  /** sam writes a message (a reply to p1 with `reply`); returns its id once its pushes are queued. */
  const write = async (o: { reply?: boolean; highAlert?: boolean } = {}) => {
    const id = `m${++n}`;
    s.messages.push({ id, workspace_id: 'w', cohort_id: 'c1', sender_id: 'sam', parent_message_id: o.reply ? 'p1' : null, high_alert: !!o.highAlert });
    await svc.messageStored(id);
    await Promise.all(queued.splice(0));
    return id;
  };
  /** Who got a queued push for message `id`, with its kind. */
  const queuedFor = (id: string) =>
    w.rows
      .filter((r) => r.dedupe_key?.startsWith(`space-push:${id}:`))
      .map((r) => [r.user_id, (r.context as { spacePush: { kind: string } }).spacePush.kind])
      .sort();
  const row = (who: string, id: string) => w.rows.find((r) => r.dedupe_key === `space-push:${id}:${who}`);
  const sent = () => send.mock.calls.flatMap((c) => c[0]).map((x) => x.to);
  return { s, svc, delivery, write, queuedFor, row, sent, threadPrefs };
}

describe('left a space: no push of any kind from it', () => {
  it('unread, reply and High alert all skip the person who left; the others still get theirs', async () => {
    const { s, delivery, write, queuedFor, sent } = world();
    s.reads.ana.left_at = new Date(NOW.getTime() - HOUR);
    const plain = await write();
    const reply = await write({ reply: true }); // a reply to ana's own thread
    const alert = await write({ highAlert: true });
    expect(queuedFor(plain)).toEqual([['bo', 'unread'], ['cy', 'unread']]);
    expect(queuedFor(reply)).toEqual([['bo', 'unread'], ['cy', 'unread']]);
    expect(queuedFor(alert)).toEqual([['bo', 'high_alert'], ['cy', 'high_alert']]);
    await delivery.drain();
    expect(sent()).not.toContain(TOKEN.ana);
  });

  it('High alert reach leaves out who left the space (and Mute all)', async () => {
    const { s, svc } = world();
    s.reads.ana.left_at = NOW;
    s.reads.bo.notify_mode = 'mute_all';
    await expect(svc.highAlertReach('sam', 'w', 'c1')).resolves.toBe(1);
  });

  it('left after the push was queued: dropped at the moment of sending, never sent', async () => {
    const { s, delivery, write, row, sent } = world();
    const id = await write({ reply: true });
    expect(row('ana', id)?.status).toBe('pending');
    s.reads.ana.left_at = new Date();
    await delivery.drain();
    expect(row('ana', id)).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
    expect(row('bo', id)?.status).toBe('sent');
    expect(sent()).not.toContain(TOKEN.ana);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=space-left-space'));
  });

  it('joined again (left_at cleared): pushes come back', async () => {
    const { s, delivery, write, queuedFor, row } = world();
    s.reads.ana.left_at = NOW;
    expect(queuedFor(await write())).toEqual([['bo', 'unread'], ['cy', 'unread']]);
    s.reads.ana.left_at = null;
    const id = await write();
    expect(queuedFor(id)).toContainEqual(['ana', 'unread']);
    await delivery.drain();
    expect(row('ana', id)?.status).toBe('sent');
  });
});

describe.each(['muted', 'left'])('a thread %s: no push from its replies', (state) => {
  it('a reply there reaches neither the person who quieted it nor, if theirs, its author; a message outside it still does', async () => {
    const { s, delivery, write, queuedFor, sent, threadPrefs } = world();
    s.threads['bo:p1'] = state;
    const reply = await write({ reply: true });
    expect(queuedFor(reply)).toEqual([['ana', 'reply'], ['cy', 'unread']]);
    expect(threadPrefs).toHaveBeenCalledWith({
      where: { cohort_id: 'c1', thread_message_id: 'p1', user_id: { in: [...PEOPLE] }, state: { in: ['muted', 'left'] } },
      select: { user_id: true },
    });
    s.threads['ana:p1'] = state; // the author quiets her own thread: no "New reply" either
    expect(queuedFor(await write({ reply: true }))).toEqual([['cy', 'unread']]);
    threadPrefs.mockClear();
    expect(queuedFor(await write())).toEqual([['ana', 'unread'], ['bo', 'unread'], ['cy', 'unread']]);
    expect(threadPrefs).not.toHaveBeenCalled(); // a message outside a thread reads no thread rows
    await delivery.drain();
    expect(sent().filter((t) => t === TOKEN.bo)).toHaveLength(1);
  });

  it('a High alert sent as a reply there skips them too (the thread is quiet for them)', async () => {
    const { s, write, queuedFor } = world();
    s.threads['bo:p1'] = state;
    expect(queuedFor(await write({ reply: true, highAlert: true }))).toEqual([['ana', 'high_alert'], ['cy', 'high_alert']]);
  });

  it('quieted after the reply push was queued: dropped at sending; undone, the next reply goes', async () => {
    const { s, delivery, write, row } = world();
    const first = await write({ reply: true });
    s.threads['ana:p1'] = state;
    await delivery.drain();
    expect(row('ana', first)).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=space-thread-off'));
    delete s.threads['ana:p1'];
    const next = await write({ reply: true });
    await delivery.drain();
    expect(row('ana', next)).toMatchObject({ status: 'sent' });
  });

  it(`FR-1168: undone (the row stays as 'followed'), its replies push again, when queued and at sending`, async () => {
    const { s, delivery, write, queuedFor, row } = world();
    s.threads['bo:p1'] = state;
    expect(queuedFor(await write({ reply: true }))).toEqual([['ana', 'reply'], ['cy', 'unread']]); // control
    const queuedWhileQuiet = await write({ reply: true });
    s.threads['bo:p1'] = 'followed'; // unmuted or followed again before it was sent: still dropped (planned without bo)
    const next = await write({ reply: true });
    expect(queuedFor(next)).toEqual([['ana', 'reply'], ['bo', 'unread'], ['cy', 'unread']]);
    s.threads['ana:p1'] = 'followed'; // a row left over from an undo does not stop the push at sending
    await delivery.drain();
    expect(row('bo', next)).toMatchObject({ status: 'sent' });
    expect(row('ana', next)).toMatchObject({ status: 'sent' });
    expect(row('bo', queuedWhileQuiet)).toBeUndefined();
  });
});

describe('the space bell', () => {
  it('Mute all: nothing from the space, High alerts and replies to them too', async () => {
    const { s, write, queuedFor } = world();
    s.reads.ana.notify_mode = 'mute_all';
    for (const o of [{}, { reply: true }, { highAlert: true }, { reply: true, highAlert: true }]) {
      expect(queuedFor(await write(o)).map(([who]) => who)).not.toContain('ana');
    }
  });

  it('Mute low priority: no unread notification; a reply to them and a High alert still ring', async () => {
    const { s, write, queuedFor } = world();
    s.reads.ana.notify_mode = 'mute_low';
    expect(queuedFor(await write()).map(([who]) => who)).not.toContain('ana');
    expect(queuedFor(await write({ reply: true }))).toContainEqual(['ana', 'reply']);
    expect(queuedFor(await write({ highAlert: true }))).toContainEqual(['ana', 'high_alert']);
  });

  it.each([1, 8, 24])('Mute %ih: nothing while it runs, High alerts too; pushes come back the moment it ends', async (hours) => {
    const { s, delivery, write, queuedFor, row } = world();
    const until = new Date(NOW.getTime() + hours * HOUR);
    s.reads.ana.silenced_until = until;
    expect(queuedFor(await write()).map(([who]) => who)).not.toContain('ana');
    expect(queuedFor(await write({ highAlert: true })).map(([who]) => who)).not.toContain('ana');
    jest.setSystemTime(until.getTime() - 1);
    expect(queuedFor(await write({ reply: true })).map(([who]) => who)).not.toContain('ana');
    jest.setSystemTime(until);
    const id = await write();
    expect(queuedFor(id)).toContainEqual(['ana', 'unread']);
    await delivery.drain();
    expect(row('ana', id)?.status).toBe('sent');
  });

  it('a timed mute started after the push was queued drops it at sending', async () => {
    const { s, delivery, write, row } = world();
    const id = await write();
    s.reads.ana.silenced_until = new Date(NOW.getTime() + HOUR);
    await delivery.drain();
    expect(row('ana', id)).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=space-not-planned'));
  });
});
