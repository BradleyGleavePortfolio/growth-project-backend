// LS-1192R5: independent controls for the round-4 shared catch boundary.
// Only transport is stubbed. The real notification service, emitter, worker,
// source checks, preference mapping and durable outbox fake run together.
import { Logger } from '@nestjs/common';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { isMoneyPush } from '../src/notifications/push/held-push-source';
import { SAFETY_ALERT_PUSH_BODY } from '../src/notifications/push/lock-screen-copy';
import { ExpoHttpError, type ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { MUTE_ALL_PASS } from '../src/notifications/push/push-preferences';
import { SENDERS } from './utils/notify-sender-registry';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const stub = <T>(value: unknown): T => value as T;
const NIGHT = new Date('2026-10-06T06:00:00Z');
const MORNING = new Date('2026-10-06T15:00:00Z');
const ENTERED = new Date('2026-10-05T06:00:00Z');
const END = new Date('2026-10-08T06:00:00Z');
const TOKEN = 'ExponentPushToken[ls1192r5independentcontrol]';
const MONEY_KINDS = ['dunning_blocker', 'first_payment', 'trial_ending', 'plan_renewal', 'coach_new_purchase'];
const MODES = ['dunning', 'trial', 'renewal', 'first payment', 'coach purchase', 'Day 7', 'hold notice', 'payout'] as const;
type Mode = typeof MODES[number];
type Gate = 'first preferences' | 'final preferences' | 'first token' | 'final token' | 'cap' | 'roster';
type UserRead = { where: { id: string }; select?: Record<string, unknown> };
type PrefsRead = { where: { user_id: string }; select?: Record<string, unknown> };

async function rig(mode: Mode | 'message' | 'safety', safetyType = 'roman_crisis_reply') {
  const clock = { at: NIGHT };
  const faults = { gate: null as Gate | null, fullPrefs: 0 };
  const state = {
    status: 'active', locked_out_at: null, last_failure_reason: 'card_declined',
    client_canceled_at: null, entered_at: ENTERED,
  };
  const authority = { roster: true, renewal: true };
  const purchase = { status: 'trialing', entitlement_active: true, trial_ends_at: END, cancel_at_period_end: false };
  const coach = ['coach purchase', 'Day 7', 'hold notice', 'payout', 'first payment', 'safety'].includes(mode);
  const w = pushOutboxWorld({
    now: () => clock.at, tokens: { reader: TOKEN },
    prefs: { reader: { muted: mode !== 'message', timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT } },
  });
  const fail = (): never => { throw new Error('independent read unavailable'); };
  const originalPrefs = w.db.notificationPreferences.findUnique;
  const prefsRead = jest.fn(async (args: PrefsRead) => {
    if (!args.select) {
      faults.fullPrefs += 1;
      if (faults.gate === 'first preferences' && faults.fullPrefs === 1) fail();
      if (faults.gate === 'final preferences' && faults.fullPrefs === 2) fail();
    }
    return originalPrefs(args);
  });
  const userRead = jest.fn(async (args: UserRead) => {
    if (args.select?.expo_push_token) {
      if (faults.gate === 'first token' && args.select.role) fail();
      if (faults.gate === 'final token' && !args.select.role) fail();
    }
    return {
      id: args.where.id, name: 'Reader',
      role: args.where.id === 'reader' && !coach ? 'student' : 'coach',
      coach_id: args.where.id === 'reader' && !coach ? 'coach' : null,
      deleted_at: null, deletion_scheduled_at: null, archived_at: null,
      expo_push_token: w.tokens[args.where.id] ?? null,
    };
  });
  const rosterRead = jest.fn(async () => {
    if (faults.gate === 'roster') fail();
    return authority.roster ? [{ id: 'client' }] : [];
  });
  const originalRecent = w.db.pushOutbox.findMany;
  const recentRead = jest.fn(async (args: Parameters<typeof originalRecent>[0]) => {
    if (faults.gate === 'cap') fail();
    return originalRecent(args);
  });
  const db = {
    ...w.db,
    pushOutbox: { ...w.db.pushOutbox, findMany: recentRead },
    notificationPreferences: { findUnique: prefsRead },
    user: { ...w.db.user, findUnique: userRead, findMany: rosterRead, findFirst: jest.fn(async () => null) },
    coachingSession: { ...w.db.coachingSession, findMany: jest.fn(async () => []) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    dunningState: { findUnique: jest.fn(async () => ({ ...state })), count: jest.fn(async () => 0) },
    packageTrialNotice: { findUnique: jest.fn(async () => ({ purchase_id: 'purchase', trial_ends_at: END })) },
    clientPurchase: {
      findUnique: jest.fn(async () => ({ ...purchase })),
      findMany: jest.fn(async () => []), count: jest.fn(async () => 0),
    },
    planRenewal: {
      findFirst: jest.fn(async () => authority.renewal
        ? { id: 'renewal', status: 'active', ended_at: ENTERED, popup_acked_step: -1 }
        : null),
    },
  };
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, i) => ({ status: 'ok' as const, id: `independent-ticket-${i}` })));
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const makeDelivery = () => {
    const delivery = new Clocked(
      stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
      stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
    );
    delivery.autoDrain = false;
    return delivery;
  };
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, makeDelivery(),
  );
  const cycle = { stateId: 'cycle', cycleKey: String(ENTERED.getTime()) };
  if (mode === 'payout') {
    expect(await notifications.pushToUser(
      'reader', 'Existing payout title', 'Existing payout body', { deepLink: 'tgp://coach/payouts' }, undefined,
      { kind: NotificationKind.COACH_ALERT, ...MUTE_ALL_PASS, dedupeKey: 'independent:payout' },
    )).toMatchObject({ delivered: true });
  } else if (mode === 'Day 7' || mode === 'hold notice' || mode === 'safety') {
    expect(await new CoachAlertEmitter(notifications).emit({
      coachId: 'reader', alertId: `independent:${mode}`,
      alertType: mode === 'safety' ? safetyType : mode === 'Day 7' ? 'dunning_step7' : 'coach_account_hold',
      severity: safetyType === 'roman_eating_disorder_reply' ? 'warning' : mode === 'safety' ? 'critical' : 'warning',
      message: 'Existing alert body',
      // A money bit on a safety alert must not change the safety context.
      money: true,
      ...(mode === 'hold notice' ? {} : { clientUserId: 'client' }),
      ...(mode === 'Day 7' ? { dunning: cycle } : {}),
    }, { inapp: false })).toMatchObject({ push: 'sent' });
  } else {
    const kind = mode === 'dunning' ? NotificationKind.DUNNING_BLOCKER
      : mode === 'trial' ? NotificationKind.TRIAL_ENDING
      : mode === 'renewal' ? NotificationKind.PLAN_RENEWAL
      : mode === 'first payment' ? NotificationKind.FIRST_PAYMENT
      : mode === 'coach purchase' ? NotificationKind.COACH_NEW_PURCHASE
      : NotificationKind.MESSAGE_RECEIVED;
    expect(await notifications.sendPush({
      user_id: 'reader', kind, body: 'Existing notice body',
      deep_link: mode === 'coach purchase' ? 'tgp://coach/clients/client' : 'tgp://notifications',
      dedupe_key: `independent:${mode}`,
      context: mode === 'dunning' ? { dunning: cycle }
        : mode === 'trial' ? { trialNotice: { noticeId: 'notice', cancelAtPeriodEnd: false } }
        : null,
    })).toBe(true);
  }
  expect(w.rows).toHaveLength(1);
  const row = w.rows[0];
  const drain = async (gate: Gate | null = null) => {
    faults.gate = gate;
    faults.fullPrefs = 0;
    return makeDelivery().drain();
  };
  return { clock, faults, state, authority, purchase, w, row, db, send, drain };
}

describe('LS-1192R5 money classification against kinds, persisted context and registry', () => {
  it.each(MONEY_KINDS)('%s is money without a held-source context', (kind) => {
    expect(isMoneyPush(kind, null)).toBe(true);
  });
  it.each(Object.values(NotificationKind).filter((kind) => !MONEY_KINDS.includes(kind)))(
    '%s without a money source is not money', (kind) => expect(isMoneyPush(kind, null)).toBe(false),
  );
  it.each(Object.keys(SAFETY_ALERT_PUSH_BODY))('%s is safety, not a money wait', (safetyAlert) => {
    expect(isMoneyPush(NotificationKind.COACH_ALERT, { safetyAlert, alertId: 'alert' })).toBe(false);
  });
  it.each([
    ['stored payout pass', { senderWords: true, ...MUTE_ALL_PASS }],
    ['stored coach hold pass', MUTE_ALL_PASS],
    ['dunning source alone', { dunning: { stateId: 'cycle' } }],
    ['trial source alone', { trialNotice: { noticeId: 'notice', cancelAtPeriodEnd: false } }],
  ])('%s remains identifiable after a worker restart', (_name, context) => {
    expect(isMoneyPush(NotificationKind.COACH_ALERT, context)).toBe(true);
  });
  it.each([null, [], false, 17, 'passesMuteAll', {}, { passesMuteAll: 'true' }])(
    'does not invent a money classification from %j', (context) => {
      expect(isMoneyPush(NotificationKind.MESSAGE_RECEIVED, context)).toBe(false);
    },
  );
  const registryCases = SENDERS.flatMap((sender) => (sender.funnel ?? [])
    .filter((push) => MONEY_KINDS.includes(push.kind) || push.context?.passesMuteAll === true)
    .map((push) => [`${sender.file}:${sender.fn} ${push.note}`, push] as const));
  it('the registry money-class comparison is not empty', () => expect(registryCases.length).toBeGreaterThan(8));
  it.each(registryCases)('%s is covered by the durable money classifier', (_label, push) => {
    expect(isMoneyPush(push.kind, push.context)).toBe(true);
  });
});

describe('LS-1192R5 independently drives each failed pre-handoff read', () => {
  const savedFlag = process.env.FEATURE_PLAN_RENEWAL;
  beforeAll(() => {
    process.env.FEATURE_PLAN_RENEWAL = 'true';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    if (savedFlag === undefined) delete process.env.FEATURE_PLAN_RENEWAL;
    else process.env.FEATURE_PLAN_RENEWAL = savedFlag;
    jest.restoreAllMocks();
  });
  const gates: Gate[] = ['first preferences', 'final preferences', 'first token', 'final token', 'cap'];
  const cases = MODES.flatMap((mode) =>
    [...gates, ...(mode === 'Day 7' || mode === 'coach purchase' ? ['roster' as const] : [])]
      .map((gate) => [mode, gate] as const));
  it.each(cases)('%s: %s waits without consuming provider attempts, then sends once', async (mode, gate) => {
    const r = await rig(mode);
    const identity = r.row.dedupe_key;
    expect(isMoneyPush(r.row.kind, r.row.context)).toBe(true);
    expect(r.row).toMatchObject({ status: 'pending', attempts: 0 });
    r.clock.at = MORNING;
    for (let pass = 0; pass < 4; pass += 1) {
      const before = r.clock.at.getTime();
      await r.drain(gate);
      expect(r.row).toMatchObject({
        status: 'pending', result_code: 'source-unread', deferred_reason: 'source_unread',
        attempts: 0, handed_off_at: null, dedupe_key: identity,
      });
      expect(r.row.not_before.getTime()).toBe(before + 60_000);
      expect(r.send).not.toHaveBeenCalled();
      const queries = r.db.$queryRaw.mock.calls.length;
      await r.drain(gate);
      expect(r.db.$queryRaw.mock.calls.length - queries).toBe(1);
      expect(r.send).not.toHaveBeenCalled();
      r.clock.at = new Date(r.row.not_before);
    }
    await r.drain();
    await r.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.row).toMatchObject({ status: 'sent', attempts: 1, dedupe_key: identity });
  });
  it.each(['dunning', 'trial', 'renewal', 'Day 7', 'coach purchase'] as const)(
    '%s: a readable ended source or revoked reader retires after an unread pass', async (mode) => {
      const r = await rig(mode);
      r.clock.at = MORNING;
      await r.drain('final token');
      if (mode === 'dunning' || mode === 'Day 7') r.state.status = 'resolved';
      else if (mode === 'trial') r.purchase.status = 'paid';
      else if (mode === 'renewal') r.authority.renewal = false;
      else r.authority.roster = false;
      r.clock.at = new Date(r.row.not_before);
      await r.drain();
      expect(r.row).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
      expect(r.send).not.toHaveBeenCalled();
    },
  );
  it('a healed read still re-checks sign-out rather than sending to the old device', async () => {
    const r = await rig('payout');
    r.clock.at = MORNING;
    await r.drain('first token');
    r.w.tokens.reader = null;
    r.clock.at = new Date(r.row.not_before);
    await r.drain();
    expect(r.row).toMatchObject({ status: 'dropped', result_code: 'no-token' });
    expect(r.send).not.toHaveBeenCalled();
  });
  it.each(Object.keys(SAFETY_ALERT_PUSH_BODY))('%s keeps bounded retries, not source_unread', async (type) => {
    const r = await rig('safety', type);
    expect(isMoneyPush(r.row.kind, r.row.context)).toBe(false);
    r.clock.at = MORNING;
    for (let pass = 0; pass < 3; pass += 1) {
      await r.drain('first preferences');
      expect(r.row.deferred_reason).not.toBe('source_unread');
      if (pass < 2) {
        expect(r.row).toMatchObject({ status: 'pending', deferred_reason: 'worker_retry', attempts: pass + 1 });
        r.clock.at = new Date(r.row.not_before);
      }
    }
    expect(r.row).toMatchObject({ status: 'dropped', result_code: 'worker-error', attempts: 3 });
    expect(r.send).not.toHaveBeenCalled();
  });
  it.each(Object.keys(SAFETY_ALERT_PUSH_BODY))('%s keeps its established night urgency', async (type) => {
    const r = await rig('safety', type);
    await r.drain();
    expect(r.send).toHaveBeenCalledTimes(type === 'roman_eating_disorder_reply' ? 0 : 1);
    if (type === 'roman_eating_disorder_reply') {
      expect(r.row).toMatchObject({ status: 'pending', attempts: 0 });
      r.clock.at = MORNING;
      await r.drain();
      expect(r.send).toHaveBeenCalledTimes(1);
    }
  });
  it('an ordinary no-source message keeps the bounded retry path', async () => {
    const r = await rig('message');
    r.clock.at = MORNING;
    for (let pass = 0; pass < 3; pass += 1) {
      await r.drain('final token');
      expect(r.row.deferred_reason).not.toBe('source_unread');
      r.clock.at = new Date(r.row.not_before);
    }
    expect(r.row).toMatchObject({ status: 'dropped', result_code: 'worker-error', attempts: 3 });
    expect(r.send).not.toHaveBeenCalled();
  });
  it('source waits preserve, rather than erase, the existing provider retry count', async () => {
    const r = await rig('payout');
    r.clock.at = MORNING;
    r.send.mockRejectedValueOnce(new ExpoHttpError(503, true, null));
    await r.drain();
    expect(r.row).toMatchObject({ status: 'pending', deferred_reason: 'provider_retry', attempts: 1 });
    r.clock.at = new Date(r.row.not_before);
    for (let pass = 0; pass < 4; pass += 1) {
      await r.drain('final preferences');
      expect(r.row).toMatchObject({ status: 'pending', deferred_reason: 'source_unread', attempts: 1 });
      r.clock.at = new Date(r.row.not_before);
    }
    await r.drain();
    await r.drain();
    expect(r.send).toHaveBeenCalledTimes(2);
    expect(r.row).toMatchObject({ status: 'sent', attempts: 2 });
  });
  it('an uncertain post-handoff network failure is not converted into a money wait or resend', async () => {
    const r = await rig('payout');
    r.clock.at = MORNING;
    r.send.mockRejectedValueOnce(new Error('transport unavailable'));
    await r.drain();
    expect(r.row).toMatchObject({ status: 'dropped', result_code: 'transport-error', attempts: 1 });
    expect(r.row.deferred_reason).not.toBe('source_unread');
    r.clock.at = new Date(MORNING.getTime() + 86_400_000);
    await r.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
  });
});
