import { Expo } from 'expo-server-sdk';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { dunningCycleKey } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { makeTable, stub } from './utils/trial-fakes';

afterEach(() => jest.restoreAllMocks());

async function overnightReminder() {
  const clock = { at: new Date('2026-10-06T06:00:00Z') }; // 23:00 LA
  const entered = new Date('2026-10-05T06:00:00Z');
  const morning = new Date('2026-10-06T15:00:00Z');
  const world = pushOutboxWorld({
    now: () => clock.at,
    prefs: {
      'review-client': {
        muted: true, // a money reminder must continue to pass Mute all
        timezone: 'America/Los_Angeles',
        timezone_updated_at: entered,
      },
    },
  });
  world.tokens['review-client'] = 'review-device-label';
  const states = makeTable([['purchase_id']], () => ({
    purchase_id: 'review-purchase',
    status: 'active',
    step_index: 1,
    entered_at: entered,
    last_failure_reason: 'card_declined',
    locked_out_at: null,
    client_canceled_at: null,
  }));
  await states.createMany({ data: [{}] });
  const db = {
    ...world.db,
    dunningState: states,
    dunningAttempt: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const sent = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, index) => ({ status: 'ok', id: `review-receipt-${index}` })),
  );
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send: sent, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
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
    }),
    notifications,
  );
  const outcome = await dispatcher.dispatchStepDetailed({
    dunningStateId: states.rows[0].id,
    cycleKey: dunningCycleKey(entered),
    stepIndex: 1,
    isLateReversalCycle: false,
    clientUserId: 'review-client',
    coachUserId: 'review-coach',
    clientEmail: null,
    coachEmail: null,
    tokens: {
      firstName: 'Avery',
      amount: 'USD 100.00',
      coachName: 'Morgan',
      lockoutDate: 'October 15',
    },
    dunningDetailDeeplink: 'tgp://coach/clients/review-client',
  }, undefined, { channels: ['client_push'] });
  expect(outcome.results.client_push?.status).toBe('sent'); // queued receipt
  expect(world.rows).toHaveLength(1);
  expect(world.rows[0]).toMatchObject({ status: 'pending', not_before: morning });
  expect(sent).not.toHaveBeenCalled();
  const dunning = new DunningService(
    stub<ConstructorParameters<typeof DunningService>[0]>(db),
    stub<ConstructorParameters<typeof DunningService>[1]>({}),
  );
  return { clock, morning, world, states, sent, delivery, dunning };
}

it('LS-1192R2 B1: an overnight payment reminder is not sent after the invoice is paid', async () => {
  const r = await overnightReminder();
  // The actual resolution method used by invoice.paid/card recovery commits
  // before the morning worker. No simultaneous timing or second device.
  r.clock.at = new Date('2026-10-06T07:00:00Z');
  expect(await r.dunning.recordResolution('review-purchase')).toMatchObject({ status: 'resolved' });
  expect(r.states.rows[0].status).toBe('resolved');
  r.clock.at = r.morning;
  await r.delivery.drain();
  expect(r.sent).not.toHaveBeenCalled();
});

it('LS-1192R2 B1 control: an unpaid overnight reminder still sends once despite Mute all', async () => {
  const r = await overnightReminder();
  r.clock.at = r.morning;
  await r.delivery.drain();
  await r.delivery.drain();
  expect(r.sent).toHaveBeenCalledTimes(1);
  expect(r.world.rows[0]).toMatchObject({ status: 'sent' });
});
