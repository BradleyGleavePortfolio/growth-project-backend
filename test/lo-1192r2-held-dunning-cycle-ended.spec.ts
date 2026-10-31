// LO-1192R2 B1 (B-TEST): a payment reminder held for quiet hours is checked
// again when it goes. DunningV2Service only queues a step while the cycle is
// live (cycleStillLive: active, not locked, not canceled, same cycle); the
// outbox holds the push to 08:00, so a cycle that ended overnight (the client
// paid, canceled, or was locked) must stop the waiting push, as a plan renewal
// push already is (planRenewalPushStillDue). Operator ruling R1: everything
// checked when a push is queued is checked again when it is sent.
import { Expo } from 'expo-server-sdk';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { dunningCycleKey } from '../src/checkout/dunning-v2/dunning-v2.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

afterEach(() => jest.restoreAllMocks());

const ENTERED = new Date('2026-10-05T06:00:00Z');

function rig() {
  const clock = { at: new Date('2026-10-06T06:00:00Z') }; // 23:00 LA, day 0 step
  const world = pushOutboxWorld({
    now: () => clock.at,
    prefs: { 'held-client': { muted: false, timezone: 'America/Los_Angeles', timezone_updated_at: clock.at } },
  });
  world.tokens['held-client'] = 'held-device';
  const state: Record<string, unknown> = {
    id: 'held-cycle',
    status: 'active',
    locked_out_at: null,
    client_canceled_at: null,
    last_failure_reason: 'card_declined',
    entered_at: ENTERED,
  };
  const db = {
    ...world.db,
    dunningState: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string } }) => (where?.id === state.id ? { ...state } : null)),
      findFirst: jest.fn(async ({ where }: { where?: { id?: string } } = {}) =>
        !where?.id || where.id === state.id ? { ...state } : null,
      ),
    },
  };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const send = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok' as const, id: `held-${i}` })));
  const transport = stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) });
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), transport);
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
      attemptFailed: jest.fn(), notifySent: jest.fn(), coachNotified: jest.fn(),
    }),
    notifications,
  );
  return { clock, world, state, delivery, dispatcher, send };
}

async function queueReminder(r: ReturnType<typeof rig>) {
  await r.dispatcher.dispatchStepDetailed({
    dunningStateId: 'held-cycle',
    cycleKey: dunningCycleKey(ENTERED),
    stepIndex: 0,
    isLateReversalCycle: false,
    clientUserId: 'held-client',
    coachUserId: 'held-coach',
    clientEmail: null,
    coachEmail: null,
    tokens: { firstName: 'Avery', clientName: 'Avery', coachName: 'Morgan', amount: 'USD 100.00', lockoutDate: 'October 15' },
    dunningDetailDeeplink: 'tgp://coach/clients/held-client',
  }, undefined, { channels: ['client_push'] });
}

describe('LO-1192R2 B1: a payment reminder held overnight is not sent once its cycle ended', () => {
  it.each([
    ['the client paid (resolved)', (s: Record<string, unknown>) => { s.status = 'resolved'; }],
    ['the client canceled', (s: Record<string, unknown>) => { s.client_canceled_at = new Date('2026-10-06T10:00:00Z'); }],
    ['the cycle was abandoned', (s: Record<string, unknown>) => { s.status = 'abandoned'; }],
  ])('a 23:00 payment reminder is not sent at 08:00 after %s at 03:00', async (_label, endCycle) => {
    const r = rig();
    await queueReminder(r);
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours' });
    r.clock.at = new Date('2026-10-06T10:00:00Z'); // 03:00 LA
    endCycle(r.state);
    r.clock.at = new Date('2026-10-06T15:00:00Z'); // 08:00 LA
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).not.toBe('sent');
  });

  it('control: the same reminder is still sent at 08:00 while the cycle is live (held, never dropped)', async () => {
    const r = rig();
    await queueReminder(r);
    r.clock.at = new Date('2026-10-06T15:00:00Z');
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });
});
