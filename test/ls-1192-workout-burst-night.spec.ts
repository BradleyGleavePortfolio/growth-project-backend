import { Expo } from 'expo-server-sdk';
import { decideReminder } from '../src/engagement/workout-reminder.policy';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const atLocal = (time: string) => new Date(`2026-10-07T${time}Z`);

function rig() {
  const clock = { at: atLocal('02:55:00') }; // 19:55 Los Angeles, previous calendar date
  const world = pushOutboxWorld({
    now: () => clock.at,
    tokens: { reader: 'review-device' },
    prefs: { reader: {
      muted: false, timezone: 'America/Los_Angeles', timezone_updated_at: clock.at,
    } },
  });
  const db = {
    ...world.db,
    userBlock: { findFirst: jest.fn(async () => null) },
    coachProfile: { findUnique: jest.fn(async () => null) },
  };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const direct = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map(() => ({ status: 'ok', id: 'review-ticket' })));
  class Clocked extends PushDeliveryService {
    protected now(): Date { return clock.at; }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined, undefined, delivery,
  );
  const advance = (time: string) => {
    clock.at = atLocal(time);
    jest.setSystemTime(clock.at);
  };
  const communityBurst = async (phase: string) => {
    for (let i = 0; i < 8; i++) {
      await notifications.pushToUser('reader', 'New message', 'Review Community message', {
        target_type: 'message', target_id: `review:${phase}:${i}`,
      }, undefined, {
        kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
        muteAllOnly: true, dedupeKey: `review:${phase}:${i}`,
      });
    }
    await delivery.drain();
  };
  const workout = async () => {
    expect(decideReminder({
      now: clock.at, timezone: 'America/Los_Angeles', preferredTime: 'evening',
      firstSessionDate: null, planDates: new Set(['2026-10-06']),
    })).toMatchObject({ send: true, slot: 'evening' });
    await notifications.pushToUser('reader', 'Review workout', 'Review evening reminder', {}, undefined, {
      kind: NotificationKind.WORKOUT_REMINDER, dedupeKey: 'review-workout-evening',
    });
  };
  return { world, send, direct, delivery, advance, communityBurst, workout };
}

describe('LS-1192 B3: workout own-time exception does not permit night delivery after ordinary burst deferrals', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('control: an eligible evening reminder without burst pressure sends at 20:00', async () => {
    const r = rig();
    r.advance('03:00:00');
    await r.workout();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });

  it('B3: an eligible 20:00 workout reminder delayed by normal Community bursts stays held at 21:00', async () => {
    const r = rig();
    r.advance('02:55:00');
    await r.communityBurst('first');
    expect(r.send).toHaveBeenCalledTimes(8);
    r.advance('03:00:00');
    await r.workout();
    await r.delivery.drain();
    const reminder = r.world.rows.find((row) => row.kind === NotificationKind.WORKOUT_REMINDER);
    expect(reminder).toMatchObject({ status: 'pending', not_before: atLocal('03:10:00') });
    const deferrals = [
      ['03:05:01', '03:10:00', '03:20:00'],
      ['03:15:02', '03:20:00', '03:30:00'],
      ['03:25:03', '03:30:00', '03:40:00'],
      ['03:35:04', '03:40:00', '03:50:00'],
      ['03:45:05', '03:50:00', '04:00:00'],
    ];
    for (const [index, [burstAt, drainAt, nextAt]] of deferrals.entries()) {
      r.advance(burstAt);
      await r.communityBurst(`phase-${index}`);
      expect(r.send).toHaveBeenCalledTimes((index + 2) * 8);
      r.advance(drainAt);
      await r.delivery.drain();
      expect(reminder).toMatchObject({ status: 'pending', not_before: atLocal(nextAt) });
    }
    r.send.mockClear();

    r.advance('04:00:00'); // 21:00 Los Angeles: only the reminder is due; burst window is now clear.
    await r.delivery.drain();
    expect(r.direct).not.toHaveBeenCalled();
    expect(r.send).not.toHaveBeenCalled();
    expect(reminder).toMatchObject({ status: 'pending' });
  });
});
