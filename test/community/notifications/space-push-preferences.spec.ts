/**
 * PUSH-KIND-FIX (b#1138): the space chat push reaches a person with default preferences.
 *
 * Every space chat push (unread, reply, High alert) is NotificationKind.COMMUNITY_MESSAGE_RECEIVED. The core
 * preference gate filed it under 'digest', whose push default is off, so NotificationsService.sendPush dropped
 * it before the outbox and the worker's send-time re-check dropped it again for anyone with a saved
 * preferences row. Fails on 0a3d82ec (no outbox row, nothing sent); passes once the kind has its own prefix
 * with no column. Real chain: CommunitySpacePushService.messageStored -> NotificationsService.sendPush ->
 * PushDeliveryService.enqueue -> outbox -> drain -> Expo (mocked). Only the master mute and the person's own
 * setting for the space (Mute all, a running silence) stop it.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunitySpacePushService } from '../../../src/community/space-push/community-space-push.service';
import { spacePushCopy } from '../../../src/community/space-push/space-push-policy';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import { notificationPrefsPrefix, pushAllowedByPreferences } from '../../../src/notifications/push/push-preferences';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';

const NOW = new Date('2026-10-23T18:00:00Z'); // 11:00 in Los Angeles, 14:00 in New York: no quiet hours
const S = 'sender';
const token = (c: string) => `ExponentPushToken[${c.repeat(22)}]`;
const PEOPLE = ['fresh', 'saved', 'muted', 'space-muted', 'silenced'] as const;

class Clocked extends PushDeliveryService {
  protected now(): Date {
    return new Date(NOW);
  }
}

beforeAll(() => {
  for (const level of ['warn', 'error', 'log'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});

async function chain() {
  const w = pushOutboxWorld({ now: () => NOW, tokens: Object.fromEntries(PEOPLE.map((p, i) => [p, token('abcde'[i])])) });
  const send = jest.fn(async (m: Array<{ to: unknown; title?: string; body?: string }>) => m.map(() => ({ status: 'ok' as const, id: 't' })));
  const delivery = new Clocked(Object.create(w.db), { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(w.db), undefined, undefined, delivery);
  // 'fresh' has never saved a preference (no row). Everyone else has a saved row holding every default
  // (digest_push false among them), as after any visit to the notification settings.
  const defaults = await notifications.getPreferences('saved');
  for (const p of PEOPLE.slice(1)) w.prefs[p] = { ...defaults, user_id: p };
  w.prefs.muted.muted = true;
  const queued: Promise<unknown>[] = [];
  const real = notifications.sendPush.bind(notifications);
  jest.spyOn(notifications, 'sendPush').mockImplementation((...a) => {
    const p = real(...a);
    queued.push(p);
    return p;
  });

  const prisma = {
    communityMessage: { findFirst: jest.fn(), count: jest.fn() },
    communityCohort: {
      findUnique: jest.fn(async () => ({ name: 'Team' })),
      findUniqueOrThrow: jest.fn(async () => ({ kind: 'announcement' })), // Announcements: default All
      findMany: jest.fn(async () => []),
    },
    communityWorkspaceBan: { findFirst: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ name: 'Sam Rivers' })) },
    communityWorkspace: { findUnique: jest.fn() },
    userBlock: { findMany: jest.fn(async () => []) },
    communitySpaceRead: {
      findMany: jest.fn(async () => [
        { user_id: 'space-muted', notify_mode: 'mute_all', silenced_until: null },
        { user_id: 'silenced', notify_mode: 'all', silenced_until: new Date(Date.now() + 3_600_000) },
      ]),
    },
    // readersNow first (everyone who may read the space), then one unread count per reader on All.
    $queryRaw: jest.fn(),
  };
  const svc = new CommunitySpacePushService(prisma as never, notifications, { onSpaceMessageStored: jest.fn() } as never);

  const message = async (m: { id: string; parent_message_id?: string; high_alert?: boolean }) => {
    prisma.communityMessage.findFirst
      .mockReset()
      .mockResolvedValueOnce({ workspace_id: 'w', cohort_id: 'c1', sender_id: S, parent_message_id: null, high_alert: false, ...m })
      .mockResolvedValueOnce({ sender_id: 'fresh' }); // the parent, when there is one
    prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: S }, ...PEOPLE.map((id) => ({ id }))]).mockResolvedValue([{ c: 'c1', n: 1 }]);
    await svc.messageStored(m.id);
    await Promise.all(queued.splice(0));
  };
  return { w, send, delivery, message };
}

describe('PUSH-KIND-FIX: space chat pushes and the preference gate', () => {
  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
  });
  afterAll(() => delete process.env.FEATURE_COMMUNITY_SPACE_PUSH);

  it('files the space chat kind under a prefix with no column (not digest, push default off)', () => {
    const prefix = notificationPrefsPrefix(NotificationKind.COMMUNITY_MESSAGE_RECEIVED);
    expect(prefix).toBe('community_message');
    const columns = Object.values(Prisma.NotificationPreferencesScalarFieldEnum) as string[];
    expect(columns.filter((c) => c.startsWith(`${prefix}_`))).toEqual([]);
    expect(columns).toContain('digest_push'); // the column it used to read
    const saved = { muted: false, digest_push: false, digest_inapp: false };
    expect(pushAllowedByPreferences(saved, NotificationKind.COMMUNITY_MESSAGE_RECEIVED)).toBe(true);
    expect(pushAllowedByPreferences(null, NotificationKind.COMMUNITY_MESSAGE_RECEIVED)).toBe(true);
    expect(pushAllowedByPreferences({ ...saved, muted: true }, NotificationKind.COMMUNITY_MESSAGE_RECEIVED)).toBe(false);
    // Unchanged: the digests stay on their own switch.
    expect(notificationPrefsPrefix(NotificationKind.CLIENT_DIGEST)).toBe('digest');
    expect(pushAllowedByPreferences(saved, NotificationKind.CLIENT_DIGEST)).toBe(false);
  });

  it.each([
    ['unread', { id: 'm1' }, { title: 'Team', body: '1 unread message in Team' }],
    ['reply', { id: 'm2', parent_message_id: 'p1' }, { title: 'New reply', body: 'Sam replied to your message in Team' }],
    ['high_alert', { id: 'm3', high_alert: true }, spacePushCopy({ kind: 'high_alert', unread: 0, space: 'Team', cohortId: 'c1' })],
  ] as const)('%s: queued and sent to a person with default preferences; muted, Mute all and silence get none', async (kind, m, copy) => {
    const { w, send, delivery, message } = await chain();
    await message(m);
    // A reply goes to the author replied to ('fresh'); everyone else on All gets the unread notification.
    expect(w.rows.map((r) => r.user_id).sort()).toEqual(['fresh', 'saved']);
    expect(w.rows.every((r) => r.kind === NotificationKind.COMMUNITY_MESSAGE_RECEIVED)).toBe(true);
    const mine = w.rows.find((r) => r.user_id === (kind === 'reply' ? 'fresh' : 'saved'));
    expect({ title: mine?.title, body: mine?.body }).toEqual(copy);

    await delivery.drain();
    const to = send.mock.calls.flatMap((c) => c[0]).map((x) => x.to);
    expect(to.sort()).toEqual([token('a'), token('b')]);
    expect(w.rows.map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('send time: the saved default row lets a queued push out; mute all switched on while it waits stops it', async () => {
    const { w, send, delivery, message } = await chain();
    await message({ id: 'm4', high_alert: true });
    expect(w.rows).toHaveLength(2);
    w.prefs.saved.muted = true;
    await delivery.drain();
    expect(send.mock.calls.flatMap((c) => c[0]).map((x) => x.to)).toEqual([token('a')]);
    expect(w.rows.find((r) => r.user_id === 'saved')).toMatchObject({ status: 'dropped', result_code: 'preference-off' });
  });
});
