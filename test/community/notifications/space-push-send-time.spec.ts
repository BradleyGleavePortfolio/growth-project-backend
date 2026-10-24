// Sol B-2 (FR-1138): a space push that waited (quiet hours, the burst cap, a retry) is planned again for its reader
// at the moment of sending: a block either way, a ban, a deleted message or Mute all since enqueue drops it; an
// unblock lets the next one go. Real chain sendPush -> outbox -> drain -> Expo (mocked); the send-time reads are
// test/utils/space-push-send-time-fake.ts.
import { Logger } from '@nestjs/common';
import type { SpacePushKind } from '../../../src/community/space-push/space-push-policy';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';
import { spaceAtSendTime } from '../../utils/space-push-send-time-fake';

type S = ReturnType<typeof spaceAtSendTime>['s'];

const K = NotificationKind.COMMUNITY_MESSAGE_RECEIVED;
const NIGHT = new Date('2026-10-24T06:00:00Z'); // 23:00 in Los Angeles: quiet hours, held to 08:00
const MORNING = new Date('2026-10-24T15:30:00Z'); // 08:30 there
const token = (c: string) => `ExponentPushToken[${c.repeat(22)}]`;
let clock = NIGHT;
class Clocked extends PushDeliveryService {
  protected now(): Date {
    return new Date(clock);
  }
}
let log: jest.SpyInstance;
const was = process.env.FEATURE_COMMUNITY_SPACE_PUSH;
beforeAll(() => {
  ['warn', 'error'].forEach((l) => jest.spyOn(Logger.prototype, l as 'warn').mockImplementation(() => undefined));
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
beforeEach(() => {
  log.mockClear();
  process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
});
afterAll(() => {
  if (was === undefined) delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
  else process.env.FEATURE_COMMUNITY_SPACE_PUSH = was;
});

// m1 a message, m2 a reply to ana's p1, m3 a High alert, m4 a later message; all by sam.
const MSG = { id: 'm1', workspace_id: 'w', cohort_id: 'c1', sender_id: 'sam', parent_message_id: null as string | null, high_alert: false };
function world() {
  clock = NIGHT;
  const w = pushOutboxWorld({ now: () => clock, tokens: { ana: token('a'), bo: token('b') } });
  const at = spaceAtSendTime(w.db);
  at.s.messages.push(
    { ...MSG },
    { ...MSG, id: 'm2', parent_message_id: 'p1' },
    { ...MSG, id: 'p1', sender_id: 'ana' },
    { ...MSG, id: 'm3', high_alert: true },
    { ...MSG, id: 'm4' },
  );
  const send = jest.fn(async (m: Array<{ to: unknown }>) => m.map(() => ({ status: 'ok' as const, id: 't' })));
  const delivery = new Clocked(at.db as never, { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(w.db), undefined, undefined, delivery);
  const queue = (userId: string, kind: SpacePushKind, messageId: string, source = true) =>
    notifications.sendPush({
      user_id: userId,
      kind: K,
      body: '',
      deep_link: 'tgp://community/cohorts/c1',
      dedupe_key: `space-push:${messageId}:${userId}`,
      context: {
        timeZone: 'America/Los_Angeles',
        spacePush: { kind, unread: 1, space: 'Team', cohortId: 'c1', ...(source ? { messageId, senderId: 'sam' } : {}) },
      },
    });
  const row = (userId: string, messageId: string) => w.rows.find((r) => r.dedupe_key === `space-push:${messageId}:${userId}`);
  const sent = () => send.mock.calls.flatMap((c) => c[0]).map((x) => x.to);
  return { w, at, delivery, queue, row, sent };
}

it.each([
  ['unread', 'm1', ['bo', 'unread'], ['ana', 'unread']],
  ['reply', 'm2', ['ana', 'reply'], ['bo', 'unread']],
  ['high_alert', 'm3', ['bo', 'high_alert'], ['ana', 'high_alert']],
] as const)('%s held overnight: a block made since (either way) drops it at 08:00; the other reader still gets theirs', async (_k, id, [who, kind], [other, otherKind]) => {
  for (const reverse of [false, true]) {
    const { at, delivery, queue, row, sent } = world();
    await queue(who, kind, id);
    await queue(other, otherKind, id);
    await delivery.drain();
    expect(row(who, id)?.status).toBe('pending'); // held to 08:00
    expect(row(who, id)?.not_before.getTime() ?? 0).toBeGreaterThan(NIGHT.getTime());
    expect(sent()).toEqual([]);
    at.s.blocks.push(reverse ? { blocker_id: 'sam', blocked_id: who } : { blocker_id: who, blocked_id: 'sam' });
    clock = MORNING;
    await delivery.drain();
    expect(row(who, id)).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
    expect(row(other, id)?.status).toBe('sent');
    expect(sent()).toEqual([token(other === 'ana' ? 'a' : 'b')]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=space-blocked'));
  }
});

it.each([
  ['the reader banned from the community (the space shuts them out)', (s: S): void => void s.shut.add('bo'), 'no-access'],
  ['the sender banned from the community', (s: S): void => void s.bans.add('w:sam'), 'sender-banned'],
  ['the message deleted', (s: S): void => void (s.messages[0].deleted_at = NIGHT), 'message-gone'],
  ['Mute all switched on', (s: S): void => void (s.reads.bo = { notify_mode: 'mute_all', silenced_until: null }), 'not-planned'],
  ['the space read since (nothing unread)', (s: S): void => void (s.unread = 0), 'not-planned'],
] as const)('held overnight, then %s: dropped, never sent', async (_what, change, reason) => {
  const { at, delivery, queue, row, sent } = world();
  await queue('bo', 'unread', 'm1');
  await delivery.drain();
  change(at.s);
  clock = MORNING;
  await delivery.drain();
  expect(row('bo', 'm1')).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  expect(sent()).toEqual([]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`reason=space-${reason}`));
});

// Sol B1 (FR-1138R5): the sender moves to another coach before 08:00 (POST /sub-coaches/:id/reassign-client), so
// what they wrote in this space that is not public no longer reads here (app.community_author_stays, the rule
// GET .../messages/:id and the unread count ask): what waited is dropped, never sent.
it.each([
  ['reply', 'm2', 'ana'],
  ['unread', 'm1', 'bo'],
] as const)('%s held overnight, then its sender moves to another coach: dropped, never sent', async (kind, id, who) => {
  const { at, delivery, queue, row, sent } = world();
  await queue(who, kind, id);
  await delivery.drain();
  expect(row(who, id)?.status).toBe('pending');
  at.s.coachOf.sam = 'coach-b';
  clock = MORNING;
  await delivery.drain();
  expect(row(who, id)).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  expect(sent()).toEqual([]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=space-sender-left'));
});

it.each([
  ['stays with the coach', (_s: S): void => undefined],
  ['moves, but the space is public', (s: S): void => void s.publicSpaces.add('c1')],
  ['moves, but holds a helper row there', (s: S): void => void s.helpers.add('sam')],
] as const)('held reply, then its sender %s: it goes at 08:00, the place asked', async (what, exception) => {
  const { at, delivery, queue, row, sent } = world();
  await queue('ana', 'reply', 'm2');
  await delivery.drain();
  if (what.startsWith('moves')) at.s.coachOf.sam = 'coach-b';
  exception(at.s);
  clock = MORNING;
  await delivery.drain();
  expect(row('ana', 'm2')?.status).toBe('sent');
  expect(sent()).toEqual([token('a')]);
  expect(at.db.$queryRaw).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('community_author_stays')]), ['w'], ['c1'], ['sam']);
});

it('Sol C2 (FR-1138R5): the space switch turned off before 08:00 drops what waited', async () => {
  const { delivery, queue, row, sent } = world();
  await queue('ana', 'reply', 'm2');
  await delivery.drain();
  delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
  clock = MORNING;
  await delivery.drain();
  expect(row('ana', 'm2')).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  expect(sent()).toEqual([]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=space-switched-off'));
});

it('the send step reads the same rows as enqueue: a chat message of that space by that sender', async () => {
  const { at, delivery, queue, sent } = world();
  clock = MORNING;
  await queue('ana', 'reply', 'm2');
  await delivery.drain();
  expect(sent()).toEqual([token('a')]);
  expect(at.db.communityMessage.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'm2', sender_id: 'sam', cohort_id: 'c1', scope: 'cohort', plan_context_type: null, deleted_at: null } }),
  );
  expect(at.db.communityMessage.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'p1', cohort_id: 'c1', scope: 'cohort', deleted_at: null } }),
  );
});

it('unblock: the next push goes', async () => {
  const { at, delivery, queue, row, sent } = world();
  clock = MORNING;
  at.s.blocks.push({ blocker_id: 'bo', blocked_id: 'sam' });
  await queue('bo', 'unread', 'm1');
  await delivery.drain();
  expect(row('bo', 'm1')?.status).toBe('dropped');
  at.s.blocks.length = 0;
  await queue('bo', 'unread', 'm4');
  await delivery.drain();
  expect(row('bo', 'm4')?.status).toBe('sent');
  expect(row('bo', 'm1')?.status).toBe('dropped');
  expect(sent()).toEqual([token('b')]);
});

it('a space push row without its message and sender is not sent', async () => {
  const { delivery, queue, row, sent } = world();
  clock = MORNING;
  await queue('bo', 'unread', 'm1', false);
  await delivery.drain();
  expect(row('bo', 'm1')).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  expect(sent()).toEqual([]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('reason=space-no-source'));
});
