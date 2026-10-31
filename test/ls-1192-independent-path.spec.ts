import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';
import { Expo } from 'expo-server-sdk';
import { isOwnDeviceOperationWhileLocked } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

function rig(at = '2026-10-07T06:00:00Z', zone: string | null = 'America/Los_Angeles') {
  const clock = { at: new Date(at) };
  const prefs = zone ? { timezone: zone, timezone_updated_at: clock.at } : {};
  const world = pushOutboxWorld({
    now: () => clock.at,
    tokens: { reader: 'review-device' },
    prefs: { reader: { muted: false, ...prefs } },
  });
  const db = { ...world.db, userBlock: { findFirst: jest.fn(async () => null) } };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const direct = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);
  const send = jest.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok', id: 'review-ticket' })));
  class Clocked extends PushDeliveryService {
    protected now(): Date { return clock.at; }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery,
  );
  return { clock, world, db, direct, send, delivery, notifications };
}

describe('LS-1192 independent transport and delivery contracts', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-10-07T06:00:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('independent AST search: no product SDK sends or second Expo endpoint outside the outbox client', () => {
    const src = join(__dirname, '../src');
    const sdkSenders: string[] = [];
    const endpointOwners: string[] = [];
    for (const path of sources(src)) {
      const parsed = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'sendPushNotificationsAsync') sdkSenders.push(relative(src, path));
        if (ts.isStringLiteralLike(node) && /(?:exp\.host|expo\.dev)\/.*push\/send/.test(node.text)) {
          endpointOwners.push(relative(src, path));
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(sdkSenders).toEqual([]);
    expect([...new Set(endpointOwners)]).toEqual(['notifications/push/expo-push-client.ts']);
  });

  it.each([
    NotificationKind.DUNNING_BLOCKER, NotificationKind.TRIAL_ENDING, NotificationKind.COACH_ALERT,
    NotificationKind.COMMUNITY_DM_RECEIVED, NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
    NotificationKind.COMMUNITY_POST_REPLIED, 'coach_nudge', 'import.complete', 'coach_brief',
    'nudge_inactive',
  ])('independent transport probe: %s queues at 23:00 and uses only the outbox in the morning', async (kind) => {
    const r = rig();
    const data = { actionScreen: 'NotificationCenter', event_ref: 'review-event' };
    const route = { kind, dedupeKey: `review:${kind}` };
    await r.notifications.pushToUser('reader', 'Review title', 'Review body', data, undefined, route);
    await r.notifications.pushToUser('reader', 'Review title', 'Review body', data, undefined, route);
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0].not_before).toEqual(new Date('2026-10-07T15:00:00Z'));
    await r.delivery.drain();
    expect(r.direct).not.toHaveBeenCalled();
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = new Date('2026-10-07T15:00:00Z');
    jest.setSystemTime(r.clock.at);
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledWith([expect.objectContaining({
      title: 'Review title', body: 'Review body', data, sound: 'default',
    })]);
    expect(r.world.rows[0].status).toBe('sent');
  });

  it('a zone change across midnight re-holds the old release until 08:00 in the new zone', async () => {
    const r = rig();
    await r.notifications.pushToUser('reader', 'Review', 'Review', {}, undefined, {
      kind: NotificationKind.DUNNING_BLOCKER, dedupeKey: 'review-zone',
    });
    r.world.prefs.reader.timezone = 'Pacific/Honolulu';
    r.clock.at = new Date('2026-10-07T15:00:00Z'); // old 08:00, new 05:00
    jest.setSystemTime(r.clock.at);
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({
      status: 'pending', not_before: new Date('2026-10-07T18:00:00Z'), attempts: 0,
    });
    r.clock.at = new Date('2026-10-07T18:00:00Z');
    jest.setSystemTime(r.clock.at);
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
  });

  it('an unstamped recipient zone falls back to the assigned coach zone', async () => {
    const r = rig('2026-10-07T06:00:00Z', null);
    r.db.user.findUnique.mockImplementation(async () => stub<Awaited<ReturnType<typeof r.db.user.findUnique>>>({
      expo_push_token: r.world.tokens.reader, coach_id: 'review-coach',
    }));
    r.db.coachProfile.findUnique.mockImplementation(async () => stub<Awaited<ReturnType<typeof r.db.coachProfile.findUnique>>>({
      timezone: 'America/Los_Angeles',
    }));
    await r.notifications.pushToUser('reader', 'Review', 'Review');
    expect(r.world.rows[0].not_before).toEqual(new Date('2026-10-07T15:00:00Z'));
  });

  it('a recipient with no zone anywhere uses the existing no-zone immediate policy', async () => {
    const r = rig('2026-10-07T06:00:00Z', null);
    await r.notifications.pushToUser('reader', 'Review', 'Review');
    expect(r.world.rows[0].not_before).toEqual(r.clock.at);
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
  });

  it('the burst cap delays ten ordinary events but never drops the last two', async () => {
    const r = rig('2026-10-07T15:00:00Z');
    jest.setSystemTime(r.clock.at);
    for (let i = 0; i < 10; i += 1) {
      await r.notifications.pushToUser('reader', 'Review', 'Review', {}, undefined, {
        kind: 'import.complete', muteAllOnly: true, dedupeKey: `review-burst:${i}`,
      });
    }
    await r.delivery.drain();
    expect(r.world.rows.filter((row) => row.status === 'sent')).toHaveLength(8);
    expect(r.world.rows.filter((row) => row.status === 'pending')).toHaveLength(2);
    expect(r.world.rows.some((row) => row.status === 'dropped')).toBe(false);
    r.clock.at = new Date('2026-10-07T15:10:01Z');
    jest.setSystemTime(r.clock.at);
    await r.delivery.drain();
    expect(r.world.rows.filter((row) => row.status === 'sent')).toHaveLength(10);
  });

  it('the locked-device exception is exactly the PATCH operation, not a users prefix', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
      for (const path of ['users/me', 'users/me/preferences', 'users/me/push-token', 'users/me/push-token/extra', 'users/other/push-token']) {
        expect({ method, path, allowed: isOwnDeviceOperationWhileLocked(method, path) }).toEqual({
          method, path, allowed: method === 'PATCH' && path === 'users/me/push-token',
        });
      }
    }
  });
});
