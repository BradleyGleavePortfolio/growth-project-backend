import { readFileSync } from 'fs';
import { join } from 'path';
import { CommunityNotificationsService } from '../src/community/notifications/community-notifications.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { notificationPrefsPrefix } from '../src/notifications/push/push-preferences';
import { stub } from './utils/trial-fakes';

// DUNNING-KIND-FIX: every kind goes through the REAL core gate (NotificationsService), for a user with no
// preferences row and for a saved row holding the schema defaults. A kind that lands under an off setting
// must be named "off" for that channel in src/notifications/README.md, every kind must name the setting
// that gates it, and no money or safety kind may be off by default. Only storage is stubbed.
const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
const model = /model NotificationPreferences \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
const savedDefaults: Record<string, boolean> = Object.fromEntries(
  [...model.matchAll(/^\s+(\w+)\s+Boolean\s+@default\((true|false)\)/gm)].map(([, col, on]) => [col, on === 'true']),
);

// The README's two defaults tables: | Kind | In-app | Push | Email | Setting | ...
const named = new Map<string, Record<string, string>>();
let header: string[] | null = null;
for (const line of readFileSync(join(root, 'src/notifications/README.md'), 'utf8').split('\n')) {
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (!line.startsWith('|')) header = null;
  else if (cells[0] === 'Kind' && cells.includes('In-app')) header = cells;
  else if (header && cells[0].startsWith('`')) {
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    for (const [, kind] of cells[0].matchAll(/`(\w+)`/g)) named.set(kind, row);
  }
}

function settingOf(kind: string): string {
  const prefix = notificationPrefsPrefix(kind);
  const hasColumn = Object.keys(savedDefaults).some((c) => /^(.+)_(inapp|push|email)$/.exec(c)?.[1] === prefix);
  return hasColumn ? `\`${prefix}_*\`` : 'none';
}

function notifications(prefs: Record<string, unknown> | null) {
  const created: object[] = [];
  const prisma = {
    notificationPreferences: { findUnique: jest.fn(async () => prefs) },
    notification: {
      findFirst: jest.fn(async () => (created.length ? { id: 'n1' } : null)),
      create: jest.fn(async (a: { data: object }) => {
        created.push(a.data);
        return { id: 'n1', ...a.data };
      }),
    },
    user: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[kind-fix]' })) },
  };
  const svc = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma));
  return { svc, prisma, created };
}

// b#1138 (PUSH-KIND-FIX) owns this kind's line in push-preferences.ts; drop it from here when that PR lands.
const OWNED_ELSEWHERE = new Set<string>([NotificationKind.COMMUNITY_MESSAGE_RECEIVED]);
const MONEY_OR_SAFETY = [
  NotificationKind.DUNNING_BLOCKER,
  NotificationKind.FIRST_PAYMENT,
  NotificationKind.TRIAL_ENDING,
  NotificationKind.COACH_NEW_PURCHASE,
  NotificationKind.PLAN_RENEWAL,
  NotificationKind.COACH_CLIENT_MOVED,
  NotificationKind.COACH_ALERT,
];
const defaultStates: Array<[string, Record<string, unknown> | null]> = [
  ['no preferences row', null],
  ['saved schema defaults', savedDefaults],
];

describe('DUNNING-KIND-FIX: every notification kind lands where the README defaults tables say', () => {
  it('reads the schema defaults and both README tables', () => {
    expect(savedDefaults).toMatchObject({ muted: false, digest_inapp: false, digest_push: false });
    expect(named.get(NotificationKind.DUNNING_BLOCKER)).toMatchObject({ 'In-app': 'on', Setting: 'none' });
    expect(named.get(NotificationKind.COMMUNITY_DM_RECEIVED)).toMatchObject({ 'In-app': 'on', Setting: 'none' });
  });

  describe.each(defaultStates)('%s', (_state, prefs) => {
    it.each(Object.values(NotificationKind).filter((k) => !OWNED_ELSEWHERE.has(k)))('%s', async (kind) => {
      const row = named.get(kind);
      expect([kind, row?.Setting]).toEqual([kind, settingOf(kind)]);
      const { svc } = notifications(prefs);
      for (const channel of ['inapp', 'push'] as const) {
        const gate = await svc.channelGate('kind-walk', kind, channel);
        const readme = channel === 'inapp' ? row?.['In-app'] : row?.Push;
        if (gate !== 'enabled') expect([kind, channel, readme]).toEqual([kind, channel, 'off']);
        if (readme === 'on') expect([kind, channel, gate]).toEqual([kind, channel, 'enabled']);
      }
    });

    it.each(MONEY_OR_SAFETY)('money or safety kind %s is never behind an off-by-default setting', async (kind) => {
      const { svc } = notifications(prefs);
      expect(await svc.channelGate('kind-money', kind, 'inapp')).toBe('enabled');
      expect(await svc.channelGate('kind-money', kind, 'push')).toBe('enabled');
    });
  });

  it.each(defaultStates)('writes the payment blocker row for a %s, and Mute all still stops it', async (state, prefs) => {
    const input = { user_id: `blocker-${state}`, kind: NotificationKind.DUNNING_BLOCKER, body: 'Payment' };
    const open = notifications(prefs);
    expect(await open.svc.createNotification(input)).not.toBeNull();
    expect(open.prisma.notification.create).toHaveBeenCalledTimes(1);
    const muted = notifications({ ...prefs, muted: true });
    expect(await muted.svc.createNotification(input)).toBeNull();
    expect(muted.prisma.notification.create).not.toHaveBeenCalled();
  });

  it.each(defaultStates)('writes the meal plan row (push channel) for a %s', async (state, prefs) => {
    const { svc, prisma } = notifications(prefs);
    const row = await svc.createNotification({
      user_id: `meal-${state}`,
      kind: NotificationKind.MEAL_PLAN_ASSIGNED,
      body: 'Your coach assigned a new meal plan.',
      channel: 'push',
    });
    expect(row).not.toBeNull();
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  describe('community inbox rows and the replay guard', () => {
    const saved = process.env.FEATURE_COMMUNITY_PUSH;
    beforeEach(() => {
      process.env.FEATURE_COMMUNITY_PUSH = 'true';
    });
    afterEach(() => {
      jest.restoreAllMocks();
      if (saved === undefined) delete process.env.FEATURE_COMMUNITY_PUSH;
      else process.env.FEATURE_COMMUNITY_PUSH = saved;
    });

    it.each([
      NotificationKind.COMMUNITY_DM_RECEIVED,
      NotificationKind.COMMUNITY_POST_REPLIED,
      NotificationKind.COMMUNITY_EVENT_STARTING_SOON,
      NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
      NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
    ] as const)('%s: one inbox row and one push, and a replay sends nothing', async (kind) => {
      const { svc, prisma, created } = notifications(null);
      const push = jest.spyOn(svc, 'pushToUser').mockResolvedValue({ delivered: true, code: 'delivered' });
      const community = new CommunityNotificationsService(
        svc,
        stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(prisma),
        stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>({ capture: jest.fn() }),
      );
      const send = { recipientId: `member-${kind}`, kind, targetType: 'target', targetId: 't-1' };
      await community.sendCommunityPush(send);
      await community.sendCommunityPush(send);
      expect(created).toHaveLength(1);
      expect(push).toHaveBeenCalledTimes(1);
    });
  });
});
