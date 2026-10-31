// FR-1192R2 (own tests, written red before the fix): a money push held for
// quiet hours is checked again when it goes, by the check its sender used
// when it queued it. Operator ruling R3 (owner #186-P1): a reminder whose
// cycle ended (paid or renewed, canceled, or over) is not owed, so not sent;
// one still owed is held to 08:00 and sent once.
import { Expo } from 'expo-server-sdk';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { dunningCycleKey } from '../src/checkout/dunning-v2/dunning-v2.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

afterEach(() => jest.restoreAllMocks());

const LA = 'America/Los_Angeles';
const NIGHT = new Date('2026-10-06T06:00:00Z'); // 23:00 LA
const THREE_AM = new Date('2026-10-06T10:00:00Z'); // 03:00 LA
const SEVEN_59 = new Date('2026-10-06T14:59:00Z'); // 07:59 LA
const MORNING = new Date('2026-10-06T15:00:00Z'); // 08:00 LA
const TRIAL_END = new Date('2026-10-09T06:00:00Z');
const ENTERED = new Date('2026-09-29T06:00:00Z');

function outbox(prefs: Record<string, Record<string, unknown>>) {
  const clock = { at: NIGHT };
  const world = pushOutboxWorld({ now: () => clock.at, prefs });
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const send = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok' as const, id: `t-${i}` })));
  const transport = stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) });
  return { clock, world, send, transport };
}

function wire(db: Record<string, unknown>, o: ReturnType<typeof outbox>) {
  const clock = o.clock;
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), o.transport);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  return { delivery, notifications };
}

// ── The trial-ending notice ─────────────────────────────────────────────────

function trialRig() {
  const o = outbox({ 'trial-client': { muted: false, timezone: LA, timezone_updated_at: NIGHT } });
  o.world.tokens['trial-client'] = 'trial-device';
  const purchases = makeTable([['id']], () => ({}));
  purchases.rows.push({
    id: 'trial-pur',
    client_user_id: 'trial-client',
    coach_user_id: 'trial-coach',
    package_id: 'trial-pkg',
    amount_cents: 4900,
    currency: 'usd',
    status: 'trialing',
    entitlement_active: true,
    card_on_file: true,
    cancel_at_period_end: false,
    trial_ends_at: TRIAL_END,
  });
  const notices = makeTrialNoticeTable();
  const db: Record<string, unknown> = {
    ...o.world.db,
    packageTrialNotice: notices,
    clientPurchase: {
      findMany: purchases.findMany,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = purchases.rows.find((r) => r.id === where.id);
        return p
          ? {
              ...p,
              package: { name: 'Monthly', interval: 'month', interval_count: 1 },
              coach: { name: 'Coach' },
              client: { name: 'Client', email: null },
            }
          : null;
      }),
    },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: 'pm_card' })) },
  };
  db.$transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb(db));
  const { delivery, notifications } = wire(db, o);
  const email = { send: jest.fn(async () => ({ status: 'sent' })) };
  const service = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(db),
    notifications,
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
  const purchase = purchases.rows[0] as Record<string, unknown>;
  const queue = async () => {
    await notices.createMany({
      data: [
        {
          id: 'trial-notice',
          purchase_id: 'trial-pur',
          client_user_id: 'trial-client',
          trial_ends_at: TRIAL_END,
          amount_cents: 4900,
          currency: 'usd',
          created_at: new Date(NIGHT.getTime() - 60_000),
        },
      ],
      skipDuplicates: true,
    });
    await service.deliver('trial-notice', NIGHT);
    expect(o.world.rows).toHaveLength(1);
    expect(o.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours', not_before: MORNING });
  };
  return { ...o, delivery, purchase, queue };
}

describe('FR-1192R2: a trial-ending push held overnight goes only while that trial is still the one it is about', () => {
  it.each([
    ['converted to a paid plan', (p: Record<string, unknown>) => { p.status = 'active'; }],
    ['canceled at once', (p: Record<string, unknown>) => { p.status = 'canceled'; }],
    ['canceled by the client (ends with no charge)', (p: Record<string, unknown>) => { p.cancel_at_period_end = true; }],
  ])('a 23:00 trial-ending push is not sent at 08:00 when the trial was %s at 03:00', async (_label, change) => {
    const r = trialRig();
    await r.queue();
    r.clock.at = THREE_AM;
    change(r.purchase);
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });

  it('control: a trial still running and still to be charged gets its push once, at 08:00', async () => {
    const r = trialRig();
    await r.queue();
    r.clock.at = SEVEN_59;
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = MORNING;
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
    const [[messages]] = r.send.mock.calls as unknown as Array<[Array<{ body: string }>]>;
    expect(messages[0].body).toContain('will be charged $49');
  });
});

// ── The dunning reminder (client) and the Day 7 alert (coach) ───────────────

function dunningRig(opts: { clientMuted?: boolean } = {}) {
  const o = outbox({
    'dun-client': { muted: opts.clientMuted ?? false, timezone: LA, timezone_updated_at: NIGHT },
    'dun-coach': { muted: false, timezone: LA, timezone_updated_at: NIGHT },
  });
  o.world.tokens['dun-client'] = 'dun-client-device';
  o.world.tokens['dun-coach'] = 'dun-coach-device';
  const state: Record<string, unknown> = {
    id: 'dun-cycle',
    status: 'active',
    locked_out_at: null,
    client_canceled_at: null,
    last_failure_reason: 'card_declined',
    entered_at: ENTERED,
  };
  const db = {
    ...o.world.db,
    dunningState: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string } }) => (where?.id === state.id ? { ...state } : null)),
    },
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'n-1', ...data })),
    },
  };
  const { delivery, notifications } = wire(db, o);
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    stub<ConstructorParameters<typeof DunningV2Dispatcher>[2]>({
      attemptFailed: jest.fn(),
      notifySent: jest.fn(),
      coachNotified: jest.fn(),
      blockerShown: jest.fn(),
    }),
    notifications,
    undefined,
    new CoachAlertEmitter(notifications),
  );
  const step = (stepIndex: number, channels: Array<'client_push' | 'coach_push'>) =>
    dispatcher.dispatchStepDetailed(
      {
        dunningStateId: 'dun-cycle',
        cycleKey: dunningCycleKey(ENTERED),
        stepIndex,
        isLateReversalCycle: false,
        clientUserId: 'dun-client',
        coachUserId: 'dun-coach',
        clientEmail: null,
        coachEmail: null,
        tokens: { firstName: 'Avery', clientName: 'Avery', coachName: 'Morgan', amount: 'USD 100.00', lockoutDate: 'October 15' },
        dunningDetailDeeplink: 'tgp://coach/clients/dun-client',
      },
      undefined,
      { channels },
    );
  return { ...o, delivery, state, step };
}

const DAY_7 = 3; // DUNNING_V2_CADENCE_DAYS [0, 1, 3, 7]: the coach is told at Day 7

describe('FR-1192R2: a live dunning cycle still gets its reminder, held to 08:00 and sent once', () => {
  it('control: an unpaid reminder queued at 23:00 with Mute all on waits, then goes once at 08:00', async () => {
    const r = dunningRig({ clientMuted: true });
    await r.step(0, ['client_push']);
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours', not_before: MORNING });
    r.clock.at = SEVEN_59;
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = MORNING;
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });
});

describe('FR-1192R2: the coach Day 7 payment alert held overnight is not sent once the cycle ended', () => {
  it('the client paid at 03:00: the coach is not told at 08:00 that the payment is overdue', async () => {
    const r = dunningRig();
    await r.step(DAY_7, ['coach_push']);
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0]).toMatchObject({ user_id: 'dun-coach', status: 'pending', deferred_reason: 'quiet_hours' });
    r.clock.at = THREE_AM;
    r.state.status = 'resolved';
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });

  it('control: still unpaid, the coach gets the alert once at 08:00', async () => {
    const r = dunningRig();
    await r.step(DAY_7, ['coach_push']);
    r.clock.at = MORNING;
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });
});
