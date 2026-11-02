import { Expo } from 'expo-server-sdk';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const NIGHT = new Date('2026-10-07T06:00:00Z'); // client's actual device: 23:00 Los Angeles
const MORNING = new Date('2026-10-07T15:00:00Z'); // client's actual device: 08:00 Los Angeles
const CLIENT = 'review-traveller';
const COACH = 'review-coach';

function rig(locked: boolean, priorZone: string) {
  const clock = { at: NIGHT };
  const world = pushOutboxWorld({
    now: () => clock.at,
    tokens: { [CLIENT]: 'review-device' },
    prefs: { [CLIENT]: { timezone: priorZone, timezone_updated_at: new Date('2026-10-01T12:00:00Z') } },
  });
  const db = {
    ...world.db,
    notificationPreferences: {
      ...world.db.notificationPreferences,
      upsert: jest.fn(async ({ update }: { update: object }) => {
        Object.assign(world.prefs[CLIENT], update);
        return world.prefs[CLIENT];
      }),
    },
    dunningState: { findFirst: jest.fn(async () => locked ? { id: 'review-cycle', purchase_id: 'review-plan' } : null) },
    clientPurchase: { findMany: jest.fn(async () => []) },
    userBlock: { findFirst: jest.fn(async () => null) },
  };
  const guard = new DunningLockoutGuard(stub<ConstructorParameters<typeof DunningLockoutGuard>[0]>(db));
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const direct = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);
  const send = jest.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok', id: 'review-ticket' })));
  class Clocked extends PushDeliveryService {
    protected now(): Date { return clock.at; }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery,
  );
  jest.spyOn(notifications, 'createNotification').mockResolvedValue(null);
  const emitter = new MessageReceivedEmitter(notifications);
  const context = stub<Parameters<DunningLockoutGuard['canActivate']>[0]>({
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'PUT', path: '/api/v1/notifications/timezone', user: { id: CLIENT },
        body: { timezone: 'America/Los_Angeles', source: 'device' },
      }),
    }),
  });
  async function phoneForegroundSync() {
    // The phone sends PUT /notifications/timezone on foreground. A 403 does
    // not invoke the controller and is not the phone's 404/405 fallback case.
    try {
      if (await guard.canActivate(context)) {
        await notifications.setTimeZone(CLIENT, 'America/Los_Angeles', 'device');
      }
      return null;
    } catch (err) {
      return err;
    }
  }
  return { clock, world, db, guard, direct, send, delivery, emitter, phoneForegroundSync };
}

describe('LS-1192 B2: a locked traveller receives pushes in the device zone, not the refused old zone', () => {
  const oldFlag = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    jest.setSystemTime(NIGHT);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (oldFlag === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = oldFlag;
  });

  it('control: an unlocked foreground sync updates the zone, so a real message waits for 08:00 on the device', async () => {
    const r = rig(false, 'America/New_York');
    expect(await r.phoneForegroundSync()).toBeNull();
    expect(r.world.prefs[CLIENT].timezone).toBe('America/Los_Angeles');
    await r.emitter.emit(CLIENT, { senderName: 'Review coach', threadId: CLIENT, senderId: COACH });
    expect(r.world.rows[0].not_before).toEqual(MORNING);
    r.clock.at = new Date('2026-10-07T12:00:00Z'); // 05:00 on actual device
    jest.setSystemTime(r.clock.at);
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = MORNING;
    jest.setSystemTime(r.clock.at);
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['America/New_York', '2026-10-07T12:00:00Z'], // 08:00 old zone is 05:00 on device
    ['Europe/London', '2026-10-07T07:00:00Z'], // 08:00 old zone is midnight on device
  ])('B2: a locked client returning from %s is not woken before the device reaches 08:00', async (priorZone, oldRelease) => {
    const r = rig(true, priorZone);
    const syncFailure = await r.phoneForegroundSync();
    await r.emitter.emit(CLIENT, { senderName: 'Review coach', threadId: CLIENT, senderId: COACH });
    expect(r.direct).not.toHaveBeenCalled();
    r.clock.at = new Date(oldRelease);
    jest.setSystemTime(r.clock.at);
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({ status: 'pending', not_before: MORNING });
    expect(syncFailure).toBeNull();
    expect(r.world.prefs[CLIENT].timezone).toBe('America/Los_Angeles');
  });
});
