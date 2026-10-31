/**
 * PF-3-BE: one push send path.
 *
 * Every device push goes through the push outbox (PushDeliveryService):
 *  - each direct sender (NotificationsService.pushToUser) is queued, never sent
 *    to Expo from the call, and a push sent in quiet hours waits for 08:00 in
 *    the recipient's zone (KG-QH-*), keeping its sender's own words and data;
 *  - the morning workout reminder keeps its 07:00 (owner ruling 10-30);
 *  - a crisis alert goes at once;
 *  - Mute all keeps passing safety and money as built;
 *  - a held push re-checks blocks when it goes (KG-HELD-BLOCK-MESSAGE);
 *  - a replayed send does not post twice;
 *  - a locked client's phone registers and clears its push token (C-PF-2).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { Expo } from 'expo-server-sdk';
import { DunningLockoutGuard, isOwnDeviceOperationWhileLocked } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService, PushRoute } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

afterEach(() => jest.restoreAllMocks());

const LA = 'America/Los_Angeles';
const CLIENT = 'pf3-client';
const COACH = 'pf3-coach';

function rig(at: string, prefs: Record<string, Record<string, unknown>> = {}) {
  const clock = { at: new Date(at) };
  const world = pushOutboxWorld({ now: () => clock.at, prefs });
  world.tokens[CLIENT] = 'pf3-device-client';
  world.tokens[COACH] = 'pf3-device-coach';
  const blocks: Array<[blocker: string, blocked: string]> = [];
  const userBlock = {
    findFirst: jest.fn(async ({ where }: { where: { OR: Array<{ blocker_id: string; blocked_id: string }> } }) =>
      where.OR.some((c) => blocks.some(([a, b]) => a === c.blocker_id && b === c.blocked_id)) ? { id: 'blk' } : null,
    ),
  };
  const db = { ...world.db, userBlock };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const direct = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);
  const sent = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `pf3-${i}` })));
  const transport = stub<ExpoPushClient>({ send: sent, getReceipts: jest.fn(async () => ({})) });
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), transport);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  const sentMessages = () => sent.mock.calls.flatMap((c) => c[0] as Array<Record<string, unknown>>);
  return { clock, world, blocks, direct, sent, sentMessages, delivery, notifications };
}

const inZone = (zone: string) => ({ timezone: zone, timezone_updated_at: new Date('2026-01-01T00:00:00Z') });

// Every direct sender, with the route its call site passes (class list).
// `file` is where the call lives; the source check below keeps this list whole.
interface Sender {
  id: string;
  file: string;
  to: string;
  route: PushRoute;
  data: Record<string, unknown>;
  /** Mute all on: it still goes (money / stored pass) or it does not. */
  passesMuteAll: boolean;
}
const SENDERS: Sender[] = [
  {
    id: 'KG-QH-DUNNING-CLIENT',
    file: 'src/checkout/dunning-v2/dunning-v2.dispatcher.ts',
    to: CLIENT,
    route: { kind: NotificationKind.DUNNING_BLOCKER, dedupeKey: 'dunning_v2:ds1:push:0' },
    data: { kind: 'dunning_payment', actionScreen: 'UpdateCard' },
    passesMuteAll: true,
  },
  {
    id: 'KG-QH-TRIAL',
    file: 'src/packages/trials/trial-notice.service.ts',
    to: CLIENT,
    route: { kind: NotificationKind.TRIAL_ENDING, passesMuteAll: true, dedupeKey: 'trial_notice:tn1:push' },
    data: { kind: NotificationKind.TRIAL_ENDING, actionScreen: 'TrialDetails' },
    passesMuteAll: true,
  },
  {
    id: 'KG-QH-PAYOUT',
    file: 'src/checkout/payout-notice.service.ts',
    to: COACH,
    route: { kind: NotificationKind.COACH_ALERT, passesMuteAll: true, dedupeKey: 'payout_notice:pn1:push' },
    data: { type: 'payout_adjustment', notice_id: 'pn1', deep_link: 'tgp://coach/earnings' },
    passesMuteAll: true,
  },
  {
    id: 'KG-QH-CHURN',
    file: 'src/coach/command-center/churn-intervention.service.ts',
    to: CLIENT,
    route: { kind: 'coach_nudge', muteAllOnly: true, dedupeKey: 'coach_nudge:nd1', otherUserId: COACH },
    data: { type: 'coach_nudge', kind: 'coach_nudge', actionScreen: 'Messages', nudge_id: 'nd1' },
    passesMuteAll: false,
  },
  {
    id: 'KG-QH-SCOUT',
    file: 'src/scout/scout.service.ts',
    to: COACH,
    route: { kind: 'import.complete', muteAllOnly: true, dedupeKey: 'import_complete:in1:completed' },
    data: { kind: 'import.complete', intent_id: 'in1', terminal_status: 'completed' },
    passesMuteAll: false,
  },
  {
    id: 'KG-QH-COMMUNITY',
    file: 'src/community/notifications/community-notifications.service.ts',
    to: CLIENT,
    route: { kind: 'community_dm_received', muteAllOnly: true, dedupeKey: 'dm:m1', otherUserId: 'pf3-member' },
    data: { kind: 'community_dm_received', category: 'social', target_type: 'dm', target_id: 'm1' },
    passesMuteAll: false,
  },
  {
    id: 'nudge engine (own quiet hours, now the outbox too)',
    file: 'src/notifications/nudges/nudge-engine.service.ts',
    to: CLIENT,
    route: { kind: 'nudge_missed_checkin', dedupeKey: 'nudge:missed_checkin:k1:pf3-client:push' },
    data: { trigger_type: 'missed_checkin', signal_key: 'k1', deep_link: 'tgp://checkin' },
    passesMuteAll: false,
  },
  {
    id: 'coach brief (own quiet hours, now the outbox too)',
    file: 'src/coach/brief/coach-brief.scheduler.ts',
    to: COACH,
    route: { kind: 'coach_brief', muteAllOnly: true, dedupeKey: 'coach_brief:pf3-coach:2026-10-06' },
    data: { actionScreen: 'CoachBrief' },
    passesMuteAll: false,
  },
  {
    id: 'pushToCoach (no caller on main)',
    file: 'src/notifications/notifications.service.ts',
    to: COACH,
    route: { kind: NotificationKind.COACH_ALERT, dedupeKey: 'coach_alert_push:a1' },
    data: { alertId: 'a1', alertType: 'x', category: 'system' },
    passesMuteAll: false,
  },
];

// 23:00 PDT on 10-05 and the next 08:00 PDT.
const NIGHT = '2026-10-06T06:00:00Z';
const MORNING = new Date('2026-10-06T15:00:00Z');

describe('PF-3-BE: every direct sender waits for 08:00 in the recipient zone (KG-QH)', () => {
  it.each(SENDERS.map((s) => [s.id, s] as const))('%s', async (_id, s) => {
    const r = rig(NIGHT, { [s.to]: inZone(LA) });
    const res = await r.notifications.pushToUser(s.to, 'Own title', 'Own body words', s.data, undefined, s.route);
    expect(res).toMatchObject({ delivered: true, detail: 'deferred' });
    expect(r.direct).not.toHaveBeenCalled();
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0]).toMatchObject({
      kind: s.route.kind,
      status: 'pending',
      urgent: false,
      deferred_reason: 'quiet_hours',
      not_before: MORNING,
    });
    await r.delivery.drain();
    expect(r.sent).not.toHaveBeenCalled();
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.sent).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
    // Each push keeps its words and its tap data.
    const [m] = r.sentMessages();
    expect(m).toMatchObject({ title: 'Own title', body: 'Own body words' });
    expect(m.data).toEqual(s.data);
  });

  it('the class list is whole: every pushToUser call site is listed, and only the outbox talks to Expo', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(p);
        } else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
      }
    };
    walk(join(root, 'src'));
    const callers = new Set<string>();
    const expo = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(root, f).split('\\').join('/');
      if (/\.pushToUser\(/.test(src)) callers.add(rel);
      if (/sendPushNotificationsAsync|exp\.host\/--\/api\/v2\/push\/send'/.test(src)) expo.add(rel);
    }
    // The workout reminder keeps its own 07:00 (tested on its own below).
    const ownTime = ['src/engagement/workout-reminder.service.ts'];
    expect([...callers].sort()).toEqual([...new Set([...SENDERS.map((s) => s.file), ...ownTime])].sort());
    expect([...expo]).toEqual(['src/notifications/push/expo-push-client.ts']);
    // Every call site names its route (kind) and a replay key.
    for (const f of callers) {
      const src = readFileSync(join(root, f), 'utf8');
      const calls = src.split(/\.pushToUser\(/).slice(1);
      for (const call of calls) {
        const head = call.slice(0, 1400);
        expect(`${f}: ${/dedupeKey/.test(head) && /kind:/.test(head)}`).toBe(`${f}: true`);
      }
    }
  });

  it('no device token: nothing is queued and the sender hears no-token', async () => {
    const r = rig(NIGHT, { [CLIENT]: inZone(LA) });
    r.world.tokens[CLIENT] = null;
    const res = await r.notifications.pushToUser(CLIENT, 't', 'b', {}, undefined, SENDERS[0].route);
    expect(res).toEqual({ delivered: false, code: 'no-token' });
    expect(r.world.rows).toHaveLength(0);
  });
});

describe('PF-3-BE: time-zone edges', () => {
  const sendAt = async (at: string, zone: string) => {
    const r = rig(at, { [CLIENT]: inZone(zone) });
    await r.notifications.pushToUser(CLIENT, 't', 'b', { kind: 'dunning_payment' }, undefined, {
      kind: NotificationKind.DUNNING_BLOCKER,
      dedupeKey: `z:${at}`,
    });
    return r.world.rows[0];
  };

  it('another zone: 23:00 in London waits for 08:00 London', async () => {
    const row = await sendAt('2026-10-06T22:00:00Z', 'Europe/London'); // 23:00 BST
    expect(row).toMatchObject({ deferred_reason: 'quiet_hours', not_before: new Date('2026-10-07T07:00:00Z') });
  });

  it('DST end (US, 11-01): 23:00 PDT waits for 08:00 PST', async () => {
    const row = await sendAt('2026-11-01T06:00:00Z', LA);
    expect(row).toMatchObject({ deferred_reason: 'quiet_hours', not_before: new Date('2026-11-01T16:00:00Z') });
  });

  it('DST start (US, 03-08): 23:00 PST waits for 08:00 PDT', async () => {
    const row = await sendAt('2026-03-08T07:00:00Z', LA);
    expect(row).toMatchObject({ deferred_reason: 'quiet_hours', not_before: new Date('2026-03-08T15:00:00Z') });
  });

  it('queued at 07:59 waits one minute, for 08:00', async () => {
    const row = await sendAt('2026-10-06T14:59:00Z', LA);
    expect(row).toMatchObject({ deferred_reason: 'quiet_hours', not_before: MORNING });
  });

  it('queued at 08:00 goes at once', async () => {
    const row = await sendAt('2026-10-06T15:00:00Z', LA);
    expect(row).toMatchObject({ deferred_reason: null, not_before: MORNING });
  });
});

describe('PF-3-BE: the morning workout reminder keeps 07:00', () => {
  it('a 07:00 reminder in the client zone goes at once (own time)', async () => {
    const r = rig('2026-10-06T14:00:00Z', { [CLIENT]: inZone(LA) }); // 07:00 PDT
    await r.notifications.pushToUser(
      CLIENT,
      'Time to train',
      'Your workout is ready',
      { kind: NotificationKind.WORKOUT_REMINDER },
      undefined,
      { kind: NotificationKind.WORKOUT_REMINDER, dedupeKey: 'workout_reminder:wd1' },
    );
    expect(r.world.rows[0]).toMatchObject({ deferred_reason: null, not_before: new Date('2026-10-06T14:00:00Z') });
    await r.delivery.drain();
    expect(r.sent).toHaveBeenCalledTimes(1);
  });

  it('quietHoursFor: own time for the workout reminder, 08:00 for the rest', () => {
    const now = new Date('2026-10-06T14:00:00Z');
    expect(quietHoursFor({ kind: NotificationKind.WORKOUT_REMINDER, timeZone: LA, now })).toMatchObject({
      deferred: false,
      reason: 'own-time',
    });
    expect(quietHoursFor({ kind: NotificationKind.DUNNING_BLOCKER, timeZone: LA, now })).toMatchObject({
      deferred: true,
      deliverAt: MORNING,
    });
  });
});

describe('PF-3-BE: a crisis alert goes at once', () => {
  it('an urgent Roman crisis alert at 23:00 is sent on the first drain', async () => {
    const r = rig(NIGHT, { [COACH]: inZone(LA) });
    await r.notifications.sendPush({
      user_id: COACH,
      kind: NotificationKind.COACH_ALERT,
      body: 'x',
      urgent: true,
      context: { safetyAlert: 'roman_crisis_reply' },
    });
    expect(r.world.rows[0]).toMatchObject({ urgent: true, deferred_reason: null });
    await r.delivery.drain();
    expect(r.sent).toHaveBeenCalledTimes(1);
    expect(r.sentMessages()[0].body).toBe('Urgent safety alert for one of your clients. Open TGP to see details.');
  });
});

describe('PF-3-BE: Mute all keeps passing safety and money as built', () => {
  it.each(SENDERS.map((s) => [s.id, s] as const))('%s', async (_id, s) => {
    const r = rig(NIGHT, { [s.to]: { ...inZone(LA), muted: true } });
    await r.notifications.pushToUser(s.to, 't', 'b', s.data, undefined, s.route);
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.sent).toHaveBeenCalledTimes(s.passesMuteAll ? 1 : 0);
    expect(r.world.rows[0].status).toBe(s.passesMuteAll ? 'sent' : 'dropped');
  });

  it('a safety alert passes Mute all at once', async () => {
    const r = rig(NIGHT, { [COACH]: { ...inZone(LA), muted: true } });
    await r.notifications.sendPush({
      user_id: COACH,
      kind: NotificationKind.COACH_ALERT,
      body: 'x',
      urgent: true,
      context: { safetyAlert: 'roman_urgent_reply' },
    });
    await r.delivery.drain();
    expect(r.sent).toHaveBeenCalledTimes(1);
  });
});

describe('PF-3-BE: a held push re-checks blocks when it goes (KG-HELD-BLOCK-MESSAGE)', () => {
  it('a new-message push held overnight is not sent once the client blocks the sender', async () => {
    const r = rig(NIGHT, { [CLIENT]: inZone(LA) });
    jest.spyOn(r.notifications, 'createNotification').mockResolvedValue(undefined as never); // inbox row: not under test
    const emitter = new MessageReceivedEmitter(r.notifications);
    await emitter.emit(CLIENT, { senderName: 'Morgan', threadId: CLIENT, senderId: COACH });
    expect(r.world.rows[0]).toMatchObject({
      kind: NotificationKind.MESSAGE_RECEIVED,
      deferred_reason: 'quiet_hours',
      context: expect.objectContaining({ otherUserId: COACH }),
    });
    r.blocks.push([CLIENT, COACH]);
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.sent).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('dropped');
  });

  it('the same push goes when no block was made', async () => {
    const r = rig(NIGHT, { [CLIENT]: inZone(LA) });
    jest.spyOn(r.notifications, 'createNotification').mockResolvedValue(undefined as never);
    await new MessageReceivedEmitter(r.notifications).emit(CLIENT, {
      senderName: 'Morgan',
      threadId: CLIENT,
      senderId: COACH,
    });
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.sent).toHaveBeenCalledTimes(1);
  });

  it.each(SENDERS.filter((s) => s.route.otherUserId).map((s) => [s.id, s] as const))(
    '%s: a block by the other person while it waited stops it',
    async (_id, s) => {
      const r = rig(NIGHT, { [s.to]: inZone(LA) });
      await r.notifications.pushToUser(s.to, 't', 'b', s.data, undefined, s.route);
      r.blocks.push([s.route.otherUserId as string, s.to]);
      r.clock.at = MORNING;
      await r.delivery.drain();
      expect(r.sent).not.toHaveBeenCalled();
      expect(r.world.rows[0].status).toBe('dropped');
    },
  );
});

describe('PF-3-BE: a replayed send does not post twice', () => {
  it.each(SENDERS.map((s) => [s.id, s] as const))('%s', async (_id, s) => {
    const r = rig(MORNING.toISOString(), { [s.to]: inZone(LA) });
    const first = await r.notifications.pushToUser(s.to, 't', 'b', s.data, undefined, s.route);
    const again = await r.notifications.pushToUser(s.to, 't2', 'b2', s.data, undefined, s.route);
    expect(first).toMatchObject({ delivered: true, detail: 'queued' });
    expect(again).toMatchObject({ delivered: true, detail: 'duplicate' });
    await r.delivery.drain();
    expect(r.world.rows).toHaveLength(1);
    expect(r.sent).toHaveBeenCalledTimes(1);
  });
});

describe('PF-3-BE C-PF-2: a locked client registers and clears their push token', () => {
  const prev = process.env['FEATURE_DUNNING_V2'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prev;
  });
  const locked = () =>
    new DunningLockoutGuard(
      stub<ConstructorParameters<typeof DunningLockoutGuard>[0]>({
        dunningState: { findFirst: jest.fn(async () => ({ id: 'ds1' })) },
        clientPurchase: { findMany: jest.fn(async () => []) },
      }),
    );
  const ctx = (method: string, path: string, body: unknown) => {
    const req = { method, path, body, user: { id: CLIENT } };
    // No handler metadata: the route is not marked open to a coachless client.
    return stub<Parameters<DunningLockoutGuard['canActivate']>[0]>({
      switchToHttp: () => ({ getRequest: () => req }),
    } as never);
  };

  it.each([
    ['registers this phone', { token: 'ExponentPushToken[pf3]' }],
    ['clears it at sign-out', { token: null }],
  ])('PATCH /api/v1/users/me/push-token %s while locked', async (_label, body) => {
    await expect(locked().canActivate(ctx('PATCH', '/api/v1/users/me/push-token', body))).resolves.toBe(true);
  });

  it('only that exact operation: other methods and other users/* routes stay locked', async () => {
    expect(isOwnDeviceOperationWhileLocked('PATCH', 'users/me/push-token')).toBe(true);
    expect(isOwnDeviceOperationWhileLocked('GET', 'users/me/push-token')).toBe(false);
    expect(isOwnDeviceOperationWhileLocked('PATCH', 'users/me')).toBe(false);
    await expect(locked().canActivate(ctx('PATCH', '/api/v1/users/me', { name: 'x' }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LOCKED_DUNNING' }),
    });
  });
});
