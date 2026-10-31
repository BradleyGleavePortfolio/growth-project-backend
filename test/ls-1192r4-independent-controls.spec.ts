// Independent round-4 controls: exercise the real worker and source predicates,
// not a mocked still-owed answer. The original B-tests run separately.
import { Expo } from 'expo-server-sdk';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { SAFETY_ALERT_PUSH_BODY } from '../src/notifications/push/lock-screen-copy';
import {
  PushDeliveryService,
  SOURCE_RECHECK_MS,
  type SendPathContext,
} from '../src/notifications/push/push-delivery.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const NOON = new Date('2026-10-06T19:00:00Z');
const NIGHT = new Date('2026-10-07T06:00:00Z');
const MORNING = new Date('2026-10-07T15:00:00Z');
const ENTERED = new Date('2026-10-01T00:00:00Z');
const TRIAL_END = new Date('2026-12-01T00:00:00Z');
const CASES = [
  'client dunning',
  'coach dunning',
  'trial notice',
  'trial purchase',
  'workout assignments',
  'workout sessions',
  'workout lock',
  'plan renewal',
] as const;
type Case = (typeof CASES)[number];

function rig(source: Case, at = NOON) {
  const clock = { at };
  const state = { unread: true, ended: false };
  const w = pushOutboxWorld({
    now: () => clock.at,
    tokens: { client: 'client-device', coach: 'coach-device' },
    prefs: {
      client: { muted: !source.startsWith('workout'), timezone: 'America/Los_Angeles', timezone_updated_at: NOON },
      coach: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NOON },
    },
  });
  // Failure injection is at the datastore boundary of each actual predicate.
  const read = jest.fn(async () => {
    if (state.unread) throw new Error('temporary authoritative query failure');
  });
  const db = {
    ...w.db,
    user: {
      ...w.db.user,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        role: where.id === 'coach' ? 'coach' : 'student',
        coach_id: where.id === 'coach' ? null : 'coach',
        name: 'Morgan',
        deleted_at: null,
        deletion_scheduled_at: null,
        archived_at: null,
        expo_push_token: w.tokens[where.id],
      })),
      findFirst: jest.fn(async () => ({ id: 'client' })),
      findMany: jest.fn(async () => [{ id: 'client' }]),
    },
    coachingSession: { ...w.db.coachingSession, findMany: jest.fn(async () => []) },
    dunningState: {
      findUnique: jest.fn(async () => {
        if (source.includes('dunning')) await read();
        return {
          status: state.ended ? 'resolved' : 'active',
          locked_out_at: null,
          client_canceled_at: null,
          last_failure_reason: null,
          entered_at: ENTERED,
        };
      }),
      findFirst: jest.fn(async () => {
        if (source === 'workout lock') await read();
        return null;
      }),
      count: jest.fn(async () => {
        if (source === 'plan renewal') await read();
        return 0;
      }),
    },
    packageTrialNotice: {
      findUnique: jest.fn(async () => {
        if (source === 'trial notice') await read();
        return state.ended ? null : { purchase_id: 'purchase', trial_ends_at: TRIAL_END };
      }),
    },
    clientPurchase: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => {
        if (source === 'trial purchase') await read();
        return {
          status: state.ended ? 'active' : 'trialing',
          entitlement_active: true,
          trial_ends_at: TRIAL_END,
          cancel_at_period_end: false,
        };
      }),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(async () => {
        if (source === 'workout assignments') await read();
        return [{ id: 'assignment', completed_at: state.ended ? clock.at : null }];
      }),
    },
    workoutSession: {
      findFirst: jest.fn(async () => {
        if (source === 'workout sessions') await read();
        return null;
      }),
    },
    planRenewal: {
      findFirst: jest.fn(async () => state.ended ? null : ({
        id: 'renewal',
        ended_at: ENTERED,
        popup_acked_step: -1,
        status: 'active',
      })),
    },
  };
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_m, i) => ({ status: 'ok' as const, id: `proof-ticket-${i}` })));
  const transport = stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) });
  const makeDelivery = () => {
    const delivery = new Clocked(
      stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
      transport,
    );
    delivery.autoDrain = false;
    return delivery;
  };
  const delivery = makeDelivery();
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined, undefined, delivery,
  );
  const workout = source.startsWith('workout');
  const context: SendPathContext = {
    senderWords: true,
    ...(source.includes('dunning')
      ? { dunning: { stateId: 'state', cycleKey: String(ENTERED.getTime()) } } : {}),
    ...(source.startsWith('trial')
      ? { trialNotice: { noticeId: 'notice', cancelAtPeriodEnd: false } } : {}),
    ...(workout
      ? { workoutReminder: { localDate: '2026-10-06', assignmentId: 'assignment' } } : {}),
  };
  const userId = source === 'coach dunning' ? 'coach' : 'client';
  const kind = workout ? 'workout_reminder'
    : source === 'coach dunning' ? 'coach_alert'
      : source.includes('dunning') ? NotificationKind.DUNNING_BLOCKER
        : source.startsWith('trial') ? 'trial_ending' : NotificationKind.PLAN_RENEWAL;
  return {
    clock, state, w, db, read, send, delivery, makeDelivery, notifications,
    queue: () => source === 'coach dunning'
      ? new CoachAlertEmitter(notifications).emit({
          coachId: 'coach', clientUserId: 'client', alertId: 'day7-proof',
          alertType: 'dunning_step7', severity: 'warning', money: true,
          message: 'An existing reminder',
          dunning: { stateId: 'state', cycleKey: String(ENTERED.getTime()) },
        }, { inapp: false })
      : delivery.enqueue({
          userId, kind, title: 'Notice', body: 'An existing reminder',
          data: {}, context, timeZone: 'America/Los_Angeles',
          dedupeKey: `independent:${source}`, collapseKey: `independent:${source}`,
        }),
  };
}

const savedFlags = {
  renewal: process.env.FEATURE_PLAN_RENEWAL,
  dunning: process.env.FEATURE_DUNNING_V2,
  house: process.env.HOUSE_COACH_USER_ID,
};
beforeEach(() => {
  process.env.FEATURE_PLAN_RENEWAL = 'true';
  process.env.FEATURE_DUNNING_V2 = 'true';
  delete process.env.HOUSE_COACH_USER_ID;
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of [
    ['FEATURE_PLAN_RENEWAL', savedFlags.renewal],
    ['FEATURE_DUNNING_V2', savedFlags.dunning],
    ['HOUSE_COACH_USER_ID', savedFlags.house],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});

describe('LS-1192R4 independent source recovery controls', () => {
  it.each(CASES)('%s: six failed passes cost no provider attempts and a restarted worker sends once', async (source) => {
    const r = rig(source);
    await r.queue();
    for (let i = 0; i < 6; i += 1) {
      const at = r.clock.at;
      await r.delivery.sweep();
      expect(r.w.rows[0]).toMatchObject({
        status: 'pending', attempts: 0, result_code: 'source-unread',
        deferred_reason: 'source_unread', lease_token: null, handed_off_at: null,
        not_before: new Date(at.getTime() + SOURCE_RECHECK_MS),
      });
      expect(r.send).not.toHaveBeenCalled();
      r.clock.at = new Date(at.getTime() + SOURCE_RECHECK_MS - 1);
      const reads = r.read.mock.calls.length;
      await r.delivery.drain();
      expect(r.read).toHaveBeenCalledTimes(reads);
      r.clock.at = new Date(at.getTime() + SOURCE_RECHECK_MS);
    }
    expect(r.read).toHaveBeenCalledTimes(6);
    r.state.unread = false;
    const restarted = r.makeDelivery();
    await restarted.sweep();
    await restarted.sweep();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.w.rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
    const message = r.send.mock.calls[0][0][0];
    expect(message).toMatchObject({ body: r.w.rows[0].body });
    if (source.startsWith('workout')) expect(message).toMatchObject({ channelId: 'default' });
  });

  it.each(['client dunning', 'coach dunning', 'trial notice', 'trial purchase', 'plan renewal'] as const)(
    '%s: an unknown row is not pruned after 31 days, and ended recovery retires it',
    async (source) => {
      const r = rig(source);
      await r.queue();
      await r.delivery.drain();
      r.clock.at = new Date(NOON.getTime() + 31 * 24 * 60 * 60_000);
      await r.delivery.checkReceipts();
      expect(r.w.rows).toHaveLength(1);
      expect(r.w.rows[0].status).toBe('pending');
      r.state.unread = false;
      r.state.ended = true;
      await r.makeDelivery().sweep();
      expect(r.w.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
      expect(r.send).not.toHaveBeenCalled();
    },
  );

  it('an unread client money row does not postpone a source-free crisis alert or an ordinary peer', async () => {
    const r = rig('client dunning', NIGHT);
    await r.queue();
    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.w.rows[0]).toMatchObject({ status: 'pending', result_code: 'source-unread' });
    // Return to a quiet-hours instant for an actual critical emitter call.
    r.clock.at = new Date(MORNING.getTime() + 15 * 60 * 60_000);
    const alertType = Object.keys(SAFETY_ALERT_PUSH_BODY)[0];
    await new CoachAlertEmitter(r.notifications).emit({
      coachId: 'coach', alertId: 'crisis-proof', alertType,
      severity: 'critical', message: 'Safety alert',
    }, { inapp: false });
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.w.rows.find((row) => row.dedupe_key === 'coach_alert:crisis-proof'))
      .toMatchObject({ status: 'sent', attempts: 1 });
    expect(r.w.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    // At noon a plain admitted push carries no held source and must not read one.
    r.clock.at = new Date(NOON.getTime() + 2 * 24 * 60 * 60_000);
    r.w.prefs.client.muted = false;
    await r.notifications.pushToUser('client', 'Import complete', 'Your import is ready.',
      {}, undefined, { kind: 'import.complete', muteAllOnly: true, dedupeKey: 'ordinary-proof' });
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.w.rows.find((row) => row.dedupe_key === 'ordinary-proof')).toMatchObject({ status: 'sent' });
    expect(r.send).toHaveBeenCalledTimes(2);
    expect(r.w.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it.each(Object.values(NotificationKind).filter((kind) => kind !== NotificationKind.PLAN_RENEWAL))(
    '%s: without a held source there is no new source wait',
    async (kind) => {
      const r = rig('client dunning');
      const id = `source-free:${kind}`;
      r.w.tokens[id] = 'source-free-device';
      r.db.user.findFirst.mockRejectedValue(new Error('source query must not run'));
      r.db.clientWorkoutAssignment.findMany.mockRejectedValue(new Error('source query must not run'));
      r.db.workoutSession.findFirst.mockRejectedValue(new Error('source query must not run'));
      r.db.packageTrialNotice.findUnique.mockRejectedValue(new Error('source query must not run'));
      await r.delivery.enqueue({
        userId: id, kind, title: 'Ordinary notice', body: 'Existing copy', data: {},
        context: { senderWords: true, muteAllOnly: true },
        timeZone: 'America/Los_Angeles', dedupeKey: id, collapseKey: id,
      });
      await r.delivery.drain();
      await r.delivery.drain();
      expect(r.send).toHaveBeenCalledTimes(1);
      expect(r.w.rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
      expect(r.read).not.toHaveBeenCalled();
      expect(r.db.user.findFirst).not.toHaveBeenCalled();
      expect(r.db.clientWorkoutAssignment.findMany).not.toHaveBeenCalled();
      expect(r.db.workoutSession.findFirst).not.toHaveBeenCalled();
      expect(r.db.packageTrialNotice.findUnique).not.toHaveBeenCalled();
    },
  );
});
