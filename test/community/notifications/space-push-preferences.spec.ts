// PUSH-KIND-FIX (b#1138): space chat pushes were filed under 'digest' (push default off) and never sent. Real chain
// messageStored -> sendPush -> outbox -> drain -> Expo (mocked); only mute and the space's own setting stop it.
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunitySpacePushService } from '../../../src/community/space-push/community-space-push.service';
import { spacePushCopy } from '../../../src/community/space-push/space-push-policy';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import { notificationPrefsPrefix, pushAllowedByPreferences } from '../../../src/notifications/push/push-preferences';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';
import { spaceAtSendTime } from '../../utils/space-push-send-time-fake';

const NOW = new Date('2026-10-23T18:00:00Z'); // 11:00 in Los Angeles: no quiet hours
const K = NotificationKind.COMMUNITY_MESSAGE_RECEIVED;
const token = (c: string) => `ExponentPushToken[${c.repeat(22)}]`;
const PEOPLE = ['fresh', 'saved', 'muted', 'space-muted', 'silenced'];
class Clocked extends PushDeliveryService {
  protected now(): Date {
    return new Date(NOW);
  }
}
beforeAll(() => ['warn', 'error', 'log'].forEach((l) => jest.spyOn(Logger.prototype, l as 'log').mockImplementation(() => undefined)));
beforeEach(() => void (process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true'));
afterAll(() => void delete process.env.FEATURE_COMMUNITY_SPACE_PUSH);
async function chain() {
  const w = pushOutboxWorld({ now: () => NOW, tokens: Object.fromEntries(PEOPLE.map((p, i) => [p, token('abcde'[i])])) });
  const send = jest.fn(async (m: Array<{ to: unknown }>) => m.map(() => ({ status: 'ok' as const, id: 't' })));
  const at = spaceAtSendTime(w.db); // Sol B-2: the send step plans each space push again
  const delivery = new Clocked(at.db as never, { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(w.db), undefined, undefined, delivery);
  const defaults = await notifications.getPreferences('saved'); // 'fresh' has no row; the rest save every default
  for (const p of PEOPLE.slice(1)) w.prefs[p] = { ...defaults, user_id: p, muted: p === 'muted' };
  const queued: Promise<unknown>[] = [];
  const real = notifications.sendPush.bind(notifications);
  jest.spyOn(notifications, 'sendPush').mockImplementation((...a) => { const p = real(...a); queued.push(p); return p; });
  const [findFirst, queryRaw] = [jest.fn(), jest.fn()];
  const prisma = {
    communityMessage: { findFirst },
    communityCohort: { findUnique: async () => ({ name: 'Team' }), findUniqueOrThrow: async () => ({ kind: 'announcement' }), findMany: async () => [] },
    communityWorkspaceBan: { findFirst: async () => null }, user: { findUnique: async () => ({ name: 'Sam Rivers' }) }, userBlock: { findMany: async () => [] },
    communitySpaceRead: { findMany: async () => [{ user_id: 'space-muted', notify_mode: 'mute_all', silenced_until: null },
      { user_id: 'silenced', notify_mode: 'all', silenced_until: new Date(Date.now() + 3_600_000) }] },
    $queryRaw: queryRaw, // readersNow, then one unread count per reader on All
  };
  const svc = new CommunitySpacePushService(prisma as never, notifications, { onSpaceMessageStored: jest.fn() } as never);
  const message = async (m: { id: string; parent_message_id?: string; high_alert?: boolean }) => {
    const row = { workspace_id: 'w', cohort_id: 'c1', sender_id: 'sender', parent_message_id: null, high_alert: false, ...m };
    findFirst.mockReset().mockResolvedValueOnce(row).mockResolvedValueOnce({ sender_id: 'fresh' });
    at.s.messages.push(row, { ...row, id: 'p1', sender_id: 'fresh', parent_message_id: null, high_alert: false });
    queryRaw.mockReset().mockResolvedValueOnce(['sender', ...PEOPLE].map((id) => ({ id }))).mockResolvedValue([{ c: 'c1', n: 1 }]);
    await svc.messageStored(m.id);
    await Promise.all(queued.splice(0));
  };
  return { w, sent: () => send.mock.calls.flatMap((c) => c[0]).map((x) => x.to), delivery, message };
}
it('files the space chat kind under a prefix with no column, not digest', () => {
  expect(notificationPrefsPrefix(K)).toBe('community_message');
  const columns = Object.values(Prisma.NotificationPreferencesScalarFieldEnum) as string[];
  expect(columns.filter((c) => c.startsWith('community_message_'))).toEqual([]);
  const saved = { muted: false, digest_push: false };
  expect([saved, null, { ...saved, muted: true }].map((p) => pushAllowedByPreferences(p, K))).toEqual([true, true, false]);
  expect(pushAllowedByPreferences(saved, NotificationKind.CLIENT_DIGEST)).toBe(false); // digests unchanged
});
it.each([
  ['unread', { id: 'm1' }, 'saved', { title: 'Team', body: '1 unread message in Team' }],
  ['reply', { id: 'm2', parent_message_id: 'p1' }, 'fresh', { title: 'New reply', body: 'Sam replied to your message in Team' }],
  ['high_alert', { id: 'm3', high_alert: true }, 'saved', spacePushCopy({ kind: 'high_alert', unread: 0, space: 'Team', cohortId: 'c1' })],
] as const)('%s: queued and sent with default preferences; muted, Mute all and silence get none', async (_k, m, who, copy) => {
  const { w, sent, delivery, message } = await chain();
  await message(m);
  expect(w.rows.map((r) => [r.user_id, r.kind]).sort()).toEqual([['fresh', K], ['saved', K]]);
  expect(w.rows.find((r) => r.user_id === who)).toMatchObject(copy);
  await delivery.drain();
  expect(sent().sort()).toEqual([token('a'), token('b')]);
  expect(w.rows.map((r) => r.status)).toEqual(['sent', 'sent']);
});
it('send time: a saved default row lets a queued push out; mute all switched on while it waits stops it', async () => {
  const { w, sent, delivery, message } = await chain();
  await message({ id: 'm4', high_alert: true });
  w.prefs.saved.muted = true;
  await delivery.drain();
  expect(sent()).toEqual([token('a')]);
  expect(w.rows.find((r) => r.user_id === 'saved')).toMatchObject({ status: 'dropped', result_code: 'preference-off' });
});
