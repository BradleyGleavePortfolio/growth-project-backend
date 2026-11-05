import { Expo } from 'expo-server-sdk';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { dunningCycleKey } from '../src/checkout/dunning-v2/dunning-v2.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

const NIGHT = new Date('2026-10-06T06:00:00Z');
const MORNING = new Date('2026-10-06T15:00:00Z');
const ENTERED = new Date('2026-10-05T06:00:00Z');
const END = new Date('2026-10-08T06:00:00Z');
type Source = 'client reminder' | 'coach Day 7' | 'trial notice read' | 'trial purchase read';
const SOURCES: Source[] = ['client reminder', 'coach Day 7', 'trial notice read', 'trial purchase read'];

afterEach(() => jest.restoreAllMocks());

async function rig(source: Source) {
  const clock = { at: NIGHT };
  const world = pushOutboxWorld({
    now: () => clock.at,
    prefs: {
      client: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT },
      coach: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT },
    },
    tokens: { client: 'client-device', coach: 'coach-device' },
  });
  const state = {
    id: 'cycle',
    status: 'active',
    locked_out_at: null,
    last_failure_reason: 'card_declined',
    client_canceled_at: null,
    entered_at: ENTERED,
  };
  const dunningRead = jest.fn(async () => ({ ...state }));
  const purchases = makeTable([['id']], () => ({}));
  purchases.rows.push({
    id: 'purchase', client_user_id: 'client', coach_user_id: 'coach',
    package_id: 'package', amount_cents: 4900, currency: 'usd',
    status: 'trialing', entitlement_active: true, trial_ends_at: END,
    card_on_file: true, cancel_at_period_end: false,
  });
  const purchase = purchases.rows[0] as Record<string, unknown>;
  const purchaseRead = jest.fn(async () => ({
    ...purchase,
    package: { name: 'Monthly', interval: 'month', interval_count: 1 },
    coach: { name: 'Coach' },
    client: { name: 'Client', email: null },
  }));
  const notices = makeTrialNoticeTable();
  const noticeRead = jest.fn(notices.findUnique);
  const db: Record<string, unknown> = {
    ...world.db,
    dunningState: { findUnique: dunningRead },
    packageTrialNotice: { ...notices, findUnique: noticeRead },
    clientPurchase: { findUnique: purchaseRead, findMany: purchases.findMany },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: 'card' })) },
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, i) => ({ status: 'ok' as const, id: `ticket-${i}` })),
  );
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
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
  if (source === 'client reminder' || source === 'coach Day 7') {
    const dispatcher = new DunningV2Dispatcher(
      new DunningEscalationClassifier(), new DunningV2Renderer(),
      stub<ConstructorParameters<typeof DunningV2Dispatcher>[2]>({
        attemptFailed: jest.fn(), notifySent: jest.fn(), coachNotified: jest.fn(),
      }),
      notifications, undefined, new CoachAlertEmitter(notifications),
    );
    await dispatcher.dispatchStepDetailed({
      dunningStateId: state.id, cycleKey: dunningCycleKey(ENTERED),
      stepIndex: source === 'coach Day 7' ? 3 : 1,
      isLateReversalCycle: false, clientUserId: 'client', coachUserId: 'coach',
      clientEmail: null, coachEmail: null,
      tokens: {
        firstName: 'Avery', clientName: 'Avery', coachName: 'Morgan',
        amount: 'USD 100.00', lockoutDate: 'October 15',
      },
      dunningDetailDeeplink: 'tgp://coach/clients/client',
    }, undefined, { channels: [source === 'coach Day 7' ? 'coach_push' : 'client_push'] });
  } else {
    await notices.createMany({
      data: [{
        id: 'notice', purchase_id: 'purchase', client_user_id: 'client',
        trial_ends_at: END, amount_cents: 4900, currency: 'usd',
        created_at: new Date(NIGHT.getTime() - 60_000),
      }],
      skipDuplicates: true,
    });
    const trial = new TrialNoticeService(
      stub<ConstructorParameters<typeof TrialNoticeService>[0]>(db), notifications,
    );
    await trial.deliver('notice', NIGHT);
  }
  expect(world.rows).toHaveLength(1);
  expect(world.rows[0]).toMatchObject({ status: 'pending', not_before: MORNING });
  expect(send).not.toHaveBeenCalled();
  const read = source === 'trial notice read'
    ? noticeRead
    : source === 'trial purchase read' ? purchaseRead : dunningRead;
  return {
    clock, world, send, delivery, read, state, purchase,
    end() {
      state.status = 'resolved';
      purchase.status = 'active';
    },
  };
}

describe('LS-1192R3 B1: unreadable money authority is unknown, not permission to send', () => {
  it.each(SOURCES)('%s: an ended overnight notice is not sent when its source read times out', async (source) => {
    const r = await rig(source);
    // Ordinary overnight payment/conversion committed before the worker.
    r.end();
    r.clock.at = MORNING;
    // One transient query failure, not a total DB outage: subsequent token,
    // preference and outbox writes work. No concurrency or second device.
    r.read.mockRejectedValueOnce(new Error('temporary source query timeout'));
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('pending');
    r.clock.at = new Date(MORNING.getTime() + 10 * 60_000);
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });

  it.each(SOURCES)('%s control: a readable ended notice is obsolete, not sent', async (source) => {
    const r = await rig(source);
    r.end();
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });

  it.each(SOURCES)('%s control: a readable still-owed notice sends once despite Mute all', async (source) => {
    const r = await rig(source);
    r.clock.at = MORNING;
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });

  it.each(SOURCES)('%s: a still-owed notice survives an unreadable source and sends once after recovery', async (source) => {
    const r = await rig(source);
    r.clock.at = MORNING;
    r.read.mockRejectedValueOnce(new Error('temporary source query timeout'));
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('pending');
    r.clock.at = new Date(MORNING.getTime() + 10 * 60_000);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });
});
