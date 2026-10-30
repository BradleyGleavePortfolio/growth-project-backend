import { Expo } from 'expo-server-sdk';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

afterEach(() => jest.restoreAllMocks());

it('LS-PAYFAIL B4: an overnight client payment reminder waits until morning and still passes Mute all', async () => {
  // 23:00 in the client's supplied zone, well inside the fixed v1 window.
  const clock = { at: new Date('2026-10-06T06:00:00Z') };
  const morning = new Date('2026-10-06T15:00:00Z');
  const world = pushOutboxWorld({
    now: () => clock.at,
    prefs: {
      'audit-client': {
        muted: true,
        timezone: 'America/Los_Angeles',
        timezone_updated_at: clock.at,
      },
    },
  });
  // A harmless device label; no live transport or device credential is used.
  world.tokens['audit-client'] = 'audit-device';
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const directSend = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync')
    .mockResolvedValue([{ status: 'ok', id: 'audit-receipt' }]);
  jest.spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync').mockResolvedValue({});
  const queuedSend = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, index) => ({ status: 'ok', id: `audit-delivery-${index}` })),
  );
  const transport = stub<ExpoPushClient>({
    send: queuedSend,
    getReceipts: jest.fn(async () => ({})),
  });
  class ClockedDelivery extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const delivery = new ClockedDelivery(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(world.db),
    transport,
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(world.db),
    undefined,
    undefined,
    delivery,
  );
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    stub<ConstructorParameters<typeof DunningV2Dispatcher>[2]>({
      attemptFailed: jest.fn(),
      notifySent: jest.fn(),
      coachNotified: jest.fn(),
    }),
    notifications,
  );
  expect(quietHoursFor({
    kind: NotificationKind.DUNNING_BLOCKER,
    timeZone: 'America/Los_Angeles',
    now: clock.at,
  })).toEqual({ deliverAt: morning, deferred: true, reason: 'quiet_hours' });

  await dispatcher.dispatchStepDetailed({
    dunningStateId: 'audit-cycle',
    cycleKey: 'audit-cycle-start',
    stepIndex: 0,
    isLateReversalCycle: false,
    clientUserId: 'audit-client',
    coachUserId: 'audit-coach',
    clientEmail: null,
    coachEmail: null,
    tokens: {
      firstName: 'Avery',
      clientName: 'Avery',
      coachName: 'Morgan',
      amount: 'USD 100.00',
      lockoutDate: 'October 15',
    },
    dunningDetailDeeplink: 'tgp://coach/clients/audit-client',
  }, undefined, { channels: ['client_push'] });

  expect(directSend).not.toHaveBeenCalled();
  expect(world.rows).toHaveLength(1);
  expect(world.rows[0]).toMatchObject({
    status: 'pending',
    urgent: false,
    deferred_reason: 'quiet_hours',
    not_before: morning,
  });
  await delivery.drain();
  expect(queuedSend).not.toHaveBeenCalled();
  clock.at = morning;
  await delivery.drain();
  expect(queuedSend).toHaveBeenCalledTimes(1);
  expect(world.rows[0].status).toBe('sent');
});
