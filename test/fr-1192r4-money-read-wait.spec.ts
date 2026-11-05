// FR-1192R4 (agent 191): own proofs for operator ruling R4 at every read the
// worker makes before the handoff. For a held money push (the client's
// payment reminder, the trial-ending push, the coach's Day 7 alert) a failed
// read of who may get it, or whether it may still go, is neither yes nor no:
// the row waits (source_unread, no attempt spent) and is asked again; it is
// never sent and never dropped on a failed read. A safety alert keeps its
// own path: at once at night, and the bounded worker retry on a failed read.
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

/** The next pass of the minute sweep (SOURCE_RECHECK_MS). */
const SOURCE_RECHECK_MS = 60_000;
const NIGHT = new Date('2026-10-06T06:00:00Z'); // 11 pm in Los Angeles
const MORNING = new Date('2026-10-06T15:00:00Z'); // 8 am
const ENTERED = new Date('2026-10-05T06:00:00Z');
const END = new Date('2026-10-08T06:00:00Z');

type Source = 'client reminder' | 'trial notice' | 'coach Day 7' | 'coach crisis alert';
type Read = 'preferences read' | 'recipient read' | 'coach roster read';

async function rig(source: Source) {
  const clock = { at: NIGHT };
  const w = pushOutboxWorld({
    now: () => clock.at,
    tokens: { client: 'client-device', coach: 'coach-device' },
    prefs: {
      client: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT },
      coach: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT },
    },
  });
  const state = {
    id: 'cycle', status: 'active', locked_out_at: null,
    last_failure_reason: 'card_declined', client_canceled_at: null, entered_at: ENTERED,
  };
  const purchases = makeTable([['id']], () => ({}));
  purchases.rows.push({
    id: 'purchase', client_user_id: 'client', coach_user_id: 'coach',
    package_id: 'package', amount_cents: 4900, currency: 'usd',
    status: 'trialing', entitlement_active: true, trial_ends_at: END,
    card_on_file: true, cancel_at_period_end: false,
  });
  const purchase = purchases.rows[0] as Record<string, unknown>;
  const notices = makeTrialNoticeTable();
  const roster = async (): Promise<{ id: string }[]> => [{ id: 'client' }];
  const recipient = async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    role: where.id === 'coach' ? 'coach' : 'student',
    coach_id: where.id === 'coach' ? null : 'coach',
    name: 'Morgan',
    deleted_at: null,
    deletion_scheduled_at: null,
    archived_at: null,
    expo_push_token: w.tokens[where.id],
  });
  const prefs = w.db.notificationPreferences.findUnique;
  const rosterRead = jest.fn(roster);
  const recipientRead = jest.fn(recipient);
  const prefsRead = jest.fn(prefs);
  const db: Record<string, unknown> = {
    ...w.db,
    notificationPreferences: { findUnique: prefsRead },
    user: { ...w.db.user, findUnique: recipientRead, findMany: rosterRead },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    coachingSession: { ...w.db.coachingSession, findMany: jest.fn(async () => []) },
    dunningState: { findUnique: jest.fn(async () => ({ ...state })) },
    packageTrialNotice: notices,
    clientPurchase: {
      findUnique: jest.fn(async () => ({
        ...purchase,
        package: { name: 'Monthly', interval: 'month', interval_count: 1 },
        coach: { name: 'Coach' },
        client: { name: 'Client', email: null },
      })),
      findMany: purchases.findMany,
    },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: 'card' })) },
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, i) => ({ status: 'ok' as const, id: `ticket-${i}` })),
  );
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const makeDelivery = () => {
    const d = new Clocked(
      stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
      stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
    );
    d.autoDrain = false;
    return d;
  };
  const delivery = makeDelivery();
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined, undefined, delivery,
  );
  if (source === 'client reminder') {
    const dispatcher = new DunningV2Dispatcher(
      new DunningEscalationClassifier(), new DunningV2Renderer(),
      stub<ConstructorParameters<typeof DunningV2Dispatcher>[2]>({
        attemptFailed: jest.fn(), notifySent: jest.fn(), coachNotified: jest.fn(),
      }),
      notifications, undefined, new CoachAlertEmitter(notifications),
    );
    await dispatcher.dispatchStepDetailed({
      dunningStateId: state.id, cycleKey: dunningCycleKey(ENTERED), stepIndex: 1,
      isLateReversalCycle: false, clientUserId: 'client', coachUserId: 'coach',
      clientEmail: null, coachEmail: null,
      tokens: {
        firstName: 'Avery', clientName: 'Avery', coachName: 'Morgan',
        amount: 'USD 100.00', lockoutDate: 'October 15',
      },
      dunningDetailDeeplink: 'tgp://coach/clients/client',
    }, undefined, { channels: ['client_push'] });
  } else if (source === 'trial notice') {
    await notices.createMany({
      data: [{
        id: 'notice', purchase_id: 'purchase', client_user_id: 'client',
        trial_ends_at: END, amount_cents: 4900, currency: 'usd',
        created_at: new Date(NIGHT.getTime() - 60_000),
      }],
      skipDuplicates: true,
    });
    await new TrialNoticeService(
      stub<ConstructorParameters<typeof TrialNoticeService>[0]>(db), notifications,
    ).deliver('notice', NIGHT);
  } else {
    const crisis = source === 'coach crisis alert';
    await new CoachAlertEmitter(notifications).emit({
      coachId: 'coach',
      clientUserId: 'client',
      alertId: crisis ? 'crisis-alert' : 'day7-alert',
      alertType: crisis ? 'roman_crisis_reply' : 'dunning_step7',
      severity: crisis ? 'critical' : 'warning',
      message: 'An existing alert',
      ...(crisis
        ? {}
        : { money: true, dunning: { stateId: state.id, cycleKey: dunningCycleKey(ENTERED) } }),
    }, { inapp: false });
  }
  expect(w.rows).toHaveLength(1);
  const reads: Record<Read, { fail(): void; heal(): void }> = {
    'preferences read': {
      fail: () => prefsRead.mockRejectedValue(new Error('temporary read failure')),
      heal: () => prefsRead.mockImplementation(prefs),
    },
    'recipient read': {
      fail: () => recipientRead.mockRejectedValue(new Error('temporary read failure')),
      heal: () => recipientRead.mockImplementation(recipient),
    },
    'coach roster read': {
      fail: () => rosterRead.mockRejectedValue(new Error('temporary read failure')),
      heal: () => rosterRead.mockImplementation(roster),
    },
  };
  return { clock, w, send, delivery, makeDelivery, reads, rosterRead };
}

beforeEach(() => jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true));
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.FEATURE_DUNNING_V2;
});

const CASES: [Source, Read][] = [
  ['client reminder', 'preferences read'],
  ['client reminder', 'recipient read'],
  ['trial notice', 'preferences read'],
  ['trial notice', 'recipient read'],
  ['coach Day 7', 'preferences read'],
  ['coach Day 7', 'recipient read'],
  ['coach Day 7', 'coach roster read'],
];

describe('FR-1192R4: a held money push whose read fails before the handoff', () => {
  it.each(CASES)('%s, %s fails three times: waits unsent, then sends once', async (source, read) => {
    const r = await rig(source);
    const row = r.w.rows[0];
    expect(row).toMatchObject({ status: 'pending', not_before: MORNING });
    const key = row.dedupe_key;
    r.reads[read].fail();
    r.clock.at = MORNING;
    for (let pass = 0; pass < 3; pass += 1) {
      await r.delivery.drain();
      expect(r.send).not.toHaveBeenCalled();
      expect(r.w.rows).toHaveLength(1);
      expect(r.w.rows[0]).toMatchObject({
        status: 'pending', deferred_reason: 'source_unread', attempts: 0,
        not_before: new Date(r.clock.at.getTime() + SOURCE_RECHECK_MS),
      });
      r.clock.at = new Date(r.w.rows[0].not_before);
    }
    r.reads[read].heal();
    const restarted = r.makeDelivery();
    await restarted.drain();
    await restarted.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.w.rows).toHaveLength(1);
    expect(r.w.rows[0]).toMatchObject({ status: 'sent', attempts: 1, dedupe_key: key });
  });

  it('coach Day 7: the roster read fails twice, then reads: one send, same row and key', async () => {
    const r = await rig('coach Day 7');
    expect(r.w.rows[0].dedupe_key).toBe('coach_alert:day7-alert');
    r.rosterRead
      .mockRejectedValueOnce(new Error('timeout one'))
      .mockRejectedValueOnce(new Error('timeout two'));
    r.clock.at = MORNING;
    await r.delivery.drain();
    r.clock.at = new Date(MORNING.getTime() + SOURCE_RECHECK_MS);
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = new Date(MORNING.getTime() + 2 * SOURCE_RECHECK_MS);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.w.rows).toHaveLength(1);
    expect(r.w.rows[0]).toMatchObject({
      status: 'sent', attempts: 1, dedupe_key: 'coach_alert:day7-alert',
    });
  });

  it('coach Day 7: a readable roster without the client still retires it unsent', async () => {
    const r = await rig('coach Day 7');
    r.rosterRead.mockRejectedValueOnce(new Error('timeout one')).mockResolvedValue([]);
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.w.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'source_unread' });
    r.clock.at = new Date(MORNING.getTime() + SOURCE_RECHECK_MS);
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.w.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });
});

describe('FR-1192R4: a safety alert keeps its own path', () => {
  it('a crisis alert is not held for the morning: it goes at night', async () => {
    const r = await rig('coach crisis alert');
    expect(r.w.rows[0].not_before.getTime()).toBeLessThanOrEqual(NIGHT.getTime());
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.w.rows[0].status).toBe('sent');
  });

  it('a crisis alert whose roster read fails takes the bounded worker retry, not the money wait', async () => {
    const r = await rig('coach crisis alert');
    r.rosterRead.mockRejectedValueOnce(new Error('timeout one'));
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.w.rows[0]).toMatchObject({
      status: 'pending', deferred_reason: 'worker_retry', attempts: 1,
    });
    r.clock.at = new Date(r.w.rows[0].not_before);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
  });
});
