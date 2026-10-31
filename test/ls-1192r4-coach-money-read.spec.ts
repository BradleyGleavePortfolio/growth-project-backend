// Independent money-retention probe: a real Day-7 coach alert and its real
// current-coach authorization path, with only the datastore boundary failing.
import { Expo } from 'expo-server-sdk';
import { dunningPushStillDue } from '../src/checkout/dunning-v2/dunning-cycle';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const NIGHT = new Date('2026-10-07T06:00:00Z');
const MORNING = new Date('2026-10-07T15:00:00Z');
const ENTERED = new Date('2026-10-01T00:00:00Z');
const SOURCE = { stateId: 'still-active-cycle', cycleKey: String(ENTERED.getTime()) };

function rig() {
  const clock = { at: NIGHT };
  const w = pushOutboxWorld({
    now: () => clock.at,
    tokens: { coach: 'coach-device' },
    prefs: {
      coach: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT },
    },
  });
  const rosterRead = jest.fn(async () => [{ id: 'client' }]);
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
      findMany: rosterRead,
    },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    coachingSession: { ...w.db.coachingSession, findMany: jest.fn(async () => []) },
    dunningState: {
      findUnique: jest.fn(async () => ({
        status: 'active',
        locked_out_at: null,
        client_canceled_at: null,
        last_failure_reason: null,
        entered_at: ENTERED,
      })),
    },
  };
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, index) => ({ status: 'ok' as const, id: `money-proof-${index}` })));
  const transport = stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) });
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
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
  const queue = () => new CoachAlertEmitter(notifications).emit({
    coachId: 'coach',
    clientUserId: 'client',
    alertId: 'day7-money-proof',
    alertType: 'dunning_step7',
    severity: 'warning',
    message: 'An existing payment reminder',
    money: true,
    dunning: SOURCE,
  }, { inapp: false });
  return { clock, w, db, rosterRead, send, delivery, makeDelivery, queue };
}

beforeEach(() => jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true));
afterEach(() => jest.restoreAllMocks());

describe('LS-1192R4: a Day-7 money alert must survive unread coach reach', () => {
  it('control: the real coach Day-7 alert waits for morning and sends once through a readable roster', async () => {
    const r = rig();
    expect(await r.queue()).toMatchObject({ push: 'sent' });
    expect(r.w.rows[0]).toMatchObject({ status: 'pending', not_before: MORNING });
    r.clock.at = MORNING;
    await r.delivery.sweep();
    await r.delivery.sweep();
    expect(r.rosterRead).toHaveBeenCalled();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.w.rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('B1: an owed coach money reminder is not dropped when three current-roster reads fail', async () => {
    const r = rig();
    expect(await r.queue()).toMatchObject({ push: 'sent' });
    expect(r.w.rows[0]).toMatchObject({
      kind: 'coach_alert', status: 'pending', not_before: MORNING,
      context: expect.objectContaining({ dunning: SOURCE, passesMuteAll: true }),
    });
    expect(await dunningPushStillDue(
      stub<Parameters<typeof dunningPushStillDue>[0]>(r.db), SOURCE,
    )).toBe(true);
    r.rosterRead.mockRejectedValue(new Error('temporary roster query failure'));
    r.clock.at = MORNING;
    for (let i = 0; i < 3; i += 1) {
      await r.delivery.sweep();
      expect(r.send).not.toHaveBeenCalled();
      expect(r.w.rows[0].status).toBe('pending');
      r.clock.at = new Date(r.w.rows[0].not_before);
    }
    r.rosterRead.mockResolvedValue([{ id: 'client' }]);
    const restarted = r.makeDelivery();
    await restarted.sweep();
    await restarted.sweep();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.w.rows[0].status).toBe('sent');
  });
});
