// FR-1192R3 (agent 190), the same class as LS-1192R3 B1: the plan renewal
// push is a money push (MONEY_NOTIFICATION_KINDS) whose send-time check
// (planRenewalPushStillDue) threw into the bounded provider-retry path, which
// ends by dropping a renewal push still owed. Ruling R4: a failed read waits
// for a later pass and is asked again; it is neither sent nor dropped.
import { Expo } from 'expo-server-sdk';
import * as renewalState from '../src/checkout/plan-renewal/plan-renewal.state';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

/** 12:00 in Los Angeles: no quiet hours. */
const NOON = new Date('2026-10-06T19:00:00Z');
/** The next pass of the minute sweep (SOURCE_RECHECK_MS). */
const NEXT_PASS_MS = 60_000;

afterEach(() => jest.restoreAllMocks());

async function rig() {
  const clock = { at: NOON };
  const world = pushOutboxWorld({
    now: () => clock.at,
    prefs: { client: { timezone: 'America/Los_Angeles', timezone_updated_at: NOON } },
    tokens: { client: 'client-device' },
  });
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, i) => ({ status: 'ok' as const, id: `ticket-${i}` })),
  );
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(world.db),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  await delivery.enqueue({
    userId: 'client',
    kind: NotificationKind.PLAN_RENEWAL,
    title: 'Your plan ended',
    body: 'See what is next',
    data: { type: 'plan_renewal' },
    context: { senderWords: true },
    dedupeKey: 'plan_renewal:client:day0',
    collapseKey: 'plan_renewal:client:day0',
    timeZone: 'America/Los_Angeles',
  });
  const stillDue = jest.spyOn(renewalState, 'planRenewalPushStillDue');
  stillDue.mockRejectedValueOnce(new Error('timeout one')).mockRejectedValueOnce(new Error('timeout two'));
  return { clock, world, delivery, send, stillDue };
}

async function twoFailedPasses(r: Awaited<ReturnType<typeof rig>>) {
  await r.delivery.drain();
  expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'source_unread', attempts: 0 });
  r.clock.at = new Date(NOON.getTime() + NEXT_PASS_MS);
  await r.delivery.drain();
  expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'source_unread', attempts: 0 });
  expect(r.send).not.toHaveBeenCalled();
  r.clock.at = new Date(NOON.getTime() + 2 * NEXT_PASS_MS);
}

describe('FR-1192R3: a plan renewal push whose renewal read fails', () => {
  it('waits without spending an attempt, then sends once when the read says it is still due', async () => {
    const r = await rig();
    await twoFailedPasses(r);
    r.stillDue.mockResolvedValue(true);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });

  it('retires as obsolete when a read succeeds and the sequence stopped', async () => {
    const r = await rig();
    await twoFailedPasses(r);
    r.stillDue.mockResolvedValue(false);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });
});
