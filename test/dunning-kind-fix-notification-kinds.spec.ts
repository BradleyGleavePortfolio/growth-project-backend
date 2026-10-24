import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DispatchContext, DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { CommunityNotificationsService } from '../src/community/notifications/community-notifications.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import {
  MONEY_NOTIFICATION_KINDS,
  NotificationKind,
  NotificationKindValue,
} from '../src/notifications/notification-kind';
import { ExpoPushClient, PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import {
  muteAllStops,
  notificationPrefsPrefix,
  pushAllowedByPreferences,
} from '../src/notifications/push/push-preferences';
import { pushOutboxWorld } from './utils/push-outbox-fake';
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

  it.each(defaultStates)('writes the payment blocker row for a %s, and Mute all never stops it', async (state, prefs) => {
    const input = { user_id: `blocker-${state}`, kind: NotificationKind.DUNNING_BLOCKER, body: 'Payment' };
    const open = notifications(prefs);
    expect(await open.svc.createNotification(input)).not.toBeNull();
    expect(open.prisma.notification.create).toHaveBeenCalledTimes(1);
    // MUTE-PAY (owner #171-3): Mute all never stops an in-app row or a money notice.
    const muted = notifications({ ...prefs, muted: true });
    expect(await muted.svc.createNotification(input)).not.toBeNull();
    expect(muted.prisma.notification.create).toHaveBeenCalledTimes(1);
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

// MUTE-PAY (owner #171-3, SoT A6.0-171): "Mute all notifications" never stops an in-app row of any kind and
// never stops a money notice on any channel; it mutes only the other pushes. Every kind is classed here:
// a new kind fails the first test until it is put in MONEY_NOTIFICATION_KINDS
// (src/notifications/notification-kind.ts) or in this list.
const NOT_MONEY: NotificationKindValue[] = [
  NotificationKind.MILESTONE_REACHED,
  NotificationKind.MESSAGE_RECEIVED,
  NotificationKind.MISSED_CHECKIN,
  NotificationKind.WEIGHT_TREND_ALERT,
  NotificationKind.CHECKIN_SUBMITTED,
  NotificationKind.BUILD_WEEK_DAY_UNLOCKED,
  NotificationKind.COACH_ALERT,
  NotificationKind.CLIENT_DIGEST,
  NotificationKind.COACH_DIGEST,
  NotificationKind.BOOKING_REQUESTED,
  NotificationKind.BOOKING_CONFIRMED,
  NotificationKind.BOOKING_DECLINED,
  NotificationKind.BOOKING_CANCELLED,
  NotificationKind.BOOKING_RESCHEDULED,
  NotificationKind.BOOKING_REMINDER_24H,
  NotificationKind.BOOKING_REMINDER_1H,
  NotificationKind.BOOKING_LINK_NEEDED,
  NotificationKind.BOOKING_LINK_READY,
  NotificationKind.BOOKING_REQUEST_EXPIRED,
  NotificationKind.NUDGE_MISSED_CHECKIN,
  NotificationKind.NUDGE_STREAK_BROKEN,
  NotificationKind.NUDGE_ONBOARDING_ABANDONED,
  NotificationKind.NUDGE_INACTIVE,
  NotificationKind.WORKOUT_ASSIGNED,
  NotificationKind.WORKOUT_REMINDER,
  NotificationKind.MEAL_PLAN_ASSIGNED,
  NotificationKind.DRIP_RELEASED,
  NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
  NotificationKind.COMMUNITY_DM_RECEIVED,
  NotificationKind.COMMUNITY_POST_REPLIED,
  NotificationKind.COMMUNITY_EVENT_STARTING_SOON,
  NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
  NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
  NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED,
  NotificationKind.CONTRACT_SIGNED,
  NotificationKind.CONTRACT_DECLINED,
  NotificationKind.CONTRACT_EXPIRED,
  NotificationKind.COACH_CLIENT_MOVED,
];
const ALL_KINDS: NotificationKindValue[] = Object.values(NotificationKind);
const isMoney = (kind: string) => MONEY_NOTIFICATION_KINDS.has(kind);
// Every saved switch on, Mute all on: whatever is stopped here, Mute all stopped.
const mutedAllOn: Record<string, unknown> = {
  ...Object.fromEntries(Object.keys(savedDefaults).map((c) => [c, true])),
  muted: true,
};
const TOKEN = 'ExponentPushToken[mutepaymutepaymutepay]';
const NY_AFTERNOON = new Date('2026-06-02T18:00:00Z');

/** The real enqueue gate (NotificationsService.sendPush) and the real send-time re-check (the worker). */
function pushWorld() {
  const clock = { at: NY_AFTERNOON };
  const w = pushOutboxWorld({ now: () => clock.at });
  const db = {
    ...w.db,
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: object }) => ({ id: 'n-push', ...a.data })),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const client = stub<ExpoPushClient>({
    send: jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` }))),
    getReceipts: jest.fn(async () => ({})),
  });
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), client);
  delivery.autoDrain = false;
  const svc = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  return { ...w, delivery, svc };
}

describe('MUTE-PAY: Mute all never stops an in-app row or a money notice; it mutes only the other pushes', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('classes every kind money or not, exactly once', () => {
    expect([...MONEY_NOTIFICATION_KINDS, ...NOT_MONEY].sort()).toEqual([...ALL_KINDS].sort());
    expect(NOT_MONEY.filter(isMoney)).toEqual([]);
    expect([...MONEY_NOTIFICATION_KINDS].sort()).toEqual([
      NotificationKind.COACH_NEW_PURCHASE,
      NotificationKind.DUNNING_BLOCKER,
      NotificationKind.FIRST_PAYMENT,
      NotificationKind.PLAN_RENEWAL,
      NotificationKind.TRIAL_ENDING,
    ]);
  });

  it.each(ALL_KINDS)('%s: the README Mute all column names it money or not', (kind) => {
    const cell = named.get(kind)?.['Mute all'] ?? '';
    expect([kind, cell !== '', cell.startsWith('passes (money)')]).toEqual([kind, true, isMoney(kind)]);
  });

  it.each(ALL_KINDS)('%s: a muted user still gets the row on every channel', async (kind) => {
    const { svc, created } = notifications(mutedAllOn);
    for (const channel of ['inapp', 'push', 'email'] as const) {
      const row = await svc.createNotification({ user_id: `mute-row-${kind}`, kind, body: 'Mute all', channel });
      expect([kind, channel, row === null]).toEqual([kind, channel, false]);
    }
    expect(created).toHaveLength(3);
    expect(await svc.channelGate(`mute-row-${kind}`, kind, 'inapp')).toBe('enabled');
    const delivery = isMoney(kind) ? 'enabled' : 'muted';
    expect([kind, await svc.channelGate(`mute-row-${kind}`, kind, 'push')]).toEqual([kind, delivery]);
    expect([kind, await svc.channelGate(`mute-row-${kind}`, kind, 'email')]).toEqual([kind, delivery]);
    expect([kind, pushAllowedByPreferences(mutedAllOn, kind)]).toEqual([kind, isMoney(kind)]);
    expect(muteAllStops(mutedAllOn, kind, 'inapp')).toBe(false);
  });

  describe.each(defaultStates)('%s', (state, prefs) => {
    it.each(ALL_KINDS)('%s: Mute all changes no row, only a non-money push', async (kind) => {
      for (const channel of ['inapp', 'push'] as const) {
        const input = { user_id: `mute-same-${state}-${kind}-${channel}`, kind, body: 'Mute all', channel };
        const open = await notifications(prefs).svc.createNotification(input);
        const muted = await notifications({ ...(prefs ?? {}), muted: true }).svc.createNotification({
          ...input,
          user_id: `${input.user_id}-muted`,
        });
        expect([kind, channel, muted === null]).toEqual([kind, channel, open === null]);
      }
      const mutedPrefs = { ...(prefs ?? {}), muted: true };
      const pushOpen = pushAllowedByPreferences(prefs, kind);
      expect([kind, pushAllowedByPreferences(mutedPrefs, kind)]).toEqual([kind, pushOpen && isMoney(kind)]);
    });
  });

  it('enqueue: a muted user gets every money push and no other push', async () => {
    const w = pushWorld();
    for (const kind of ALL_KINDS) {
      const user = `mute-enqueue-${kind}`;
      w.prefs[user] = { muted: true };
      w.tokens[user] = TOKEN;
      const queued = await w.svc.sendPush({
        user_id: user,
        kind,
        body: 'Mute all',
        context: { timeZone: 'America/New_York' },
      });
      expect([kind, queued !== null]).toEqual([kind, isMoney(kind)]);
    }
    expect(w.rows.map((r) => r.kind).sort()).toEqual([...MONEY_NOTIFICATION_KINDS].sort());
  });

  it('send time: a push that waited is still sent after Mute all if it is money; every other one is dropped', async () => {
    const saved = process.env.FEATURE_PLAN_RENEWAL;
    delete process.env.FEATURE_PLAN_RENEWAL;
    try {
      const w = pushWorld();
      for (const kind of ALL_KINDS) {
        const user = `mute-send-${kind}`;
        w.tokens[user] = TOKEN;
        await w.delivery.enqueue({
          userId: user,
          kind,
          title: 'Mute all',
          body: 'Mute all',
          data: {},
          collapseKey: `${kind}:mute-pay`,
          timeZone: 'America/New_York',
        });
        w.prefs[user] = { muted: true };
      }
      await w.delivery.drain();
      for (const row of w.rows) {
        // plan_renewal passes Mute all, then its own still-due check drops it (no renewal running here).
        const want = !isMoney(row.kind)
          ? ['dropped', 'preference-off']
          : row.kind === NotificationKind.PLAN_RENEWAL
            ? ['dropped', 'obsolete']
            : ['sent', 'sent'];
        expect([row.kind, row.status, row.result_code]).toEqual([row.kind, ...want]);
      }
      expect(w.rows).toHaveLength(ALL_KINDS.length);
    } finally {
      if (saved !== undefined) process.env.FEATURE_PLAN_RENEWAL = saved;
    }
  });

  describe('the payment blocker reports sent, and shown, only for the row really written', () => {
    const classifier = new DunningEscalationClassifier();
    const stepIndex = [0, 1, 2, 3].find(
      (i) => classifier.resolve({ stepIndex: i, isLateReversalCycle: false }).inAppBlocker,
    );
    const ctx: DispatchContext = {
      dunningStateId: 'ds-mute',
      cycleKey: '1',
      stepIndex: stepIndex ?? -1,
      isLateReversalCycle: false,
      clientUserId: 'client-mute',
      coachUserId: 'coach-mute',
      clientEmail: 'client@tgp.invalid',
      coachEmail: 'coach@tgp.invalid',
      tokens: {
        firstName: 'Avery',
        clientName: 'Avery Client',
        coachName: 'Morgan Coach',
        amount: '$150.00',
        lockoutDate: 'October 14',
      },
      dunningDetailDeeplink: 'tgp://coach/clients/client-mute',
    };
    function dispatcher(svc: unknown) {
      const telemetry = {
        attemptFailed: jest.fn(),
        notifySent: jest.fn(),
        blockerShown: jest.fn(),
        coachNotified: jest.fn(),
      };
      const d = new DunningV2Dispatcher(
        classifier,
        new DunningV2Renderer(),
        stub<ConstructorParameters<typeof DunningV2Dispatcher>[2]>(telemetry),
        stub<NotificationsService>(svc),
        undefined,
        new CoachAlertEmitter(stub<NotificationsService>(svc)),
      );
      return { d, telemetry };
    }

    it('a muted client still gets the blocker row: sent, shown once', async () => {
      expect(stepIndex).toBeDefined();
      const { svc, created } = notifications({ ...savedDefaults, muted: true });
      const { d, telemetry } = dispatcher(svc);
      const out = await d.dispatchStepDetailed(ctx, undefined, { channels: ['client_blocker'] });
      expect(out.results.client_blocker).toEqual({ status: 'sent' });
      expect(created).toEqual([expect.objectContaining({ kind: NotificationKind.DUNNING_BLOCKER })]);
      expect(telemetry.blockerShown).toHaveBeenCalledTimes(1);
    });

    it('no row written: skipped with a closed code, and no shown event', async () => {
      const { d, telemetry } = dispatcher({ createNotification: jest.fn(async () => null) });
      const out = await d.dispatchStepDetailed(ctx, undefined, { channels: ['client_blocker'] });
      expect(out.results.client_blocker).toEqual({ status: 'skipped', error: 'inapp_not_written' });
      expect(telemetry.blockerShown).not.toHaveBeenCalled();
    });
  });
});
