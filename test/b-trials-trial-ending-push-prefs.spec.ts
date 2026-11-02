import { Expo } from 'expo-server-sdk';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import * as pushPrefs from '../src/notifications/push/push-preferences';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

// B-TR11-122 (Opus C-672-L1): main moved the preference mapping to push/push-preferences.ts. The
// notice three days before the first charge keeps its own prefix there, never 'digest' (off).
describe('trial_ending notice through main notification and push senders', () => {
  const prefs = { muted: false, digest_push: false, digest_inapp: false };
  const kind = NotificationKind.TRIAL_ENDING;

  it('maps trial_ending to its own prefix, so the push worker gate lets it through', () => {
    expect(pushPrefs.notificationPrefsPrefix(kind)).toBe('trial_ending');
    expect(pushPrefs.pushAllowedByPreferences(prefs, kind)).toBe(true);
  });

  it('writes the in-app notice and delivers the push with digest switched off', async () => {
    // PF-3-BE: pushToUser queues in the push outbox; the worker re-reads the
    // same switches when it sends (digest_push off never stops it).
    const at = new Date('2026-10-06T18:00:00Z'); // 11:00 PDT, outside quiet hours
    const world = pushOutboxWorld({
      now: () => at,
      prefs: { 'client-1': { ...prefs, timezone: 'America/Los_Angeles', timezone_updated_at: at } },
    });
    world.tokens['client-1'] = 'ExponentPushToken[trial]';
    const db = {
      ...world.db,
      notification: { create: jest.fn(async (a: { data: object }) => ({ id: 'n1', ...a.data })) },
    };
    const send = jest.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok', id: 'ticket-1' })));
    class Clocked extends PushDeliveryService {
      protected now(): Date {
        return at;
      }
    }
    const delivery = new Clocked(
      stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
      stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
    );
    delivery.autoDrain = false;
    const svc = new NotificationsService(
      stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
      undefined,
      undefined,
      delivery,
    );
    const direct = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);
    const body = 'Your free trial ends in 3 days.';
    const row = await svc.createNotification({ user_id: 'client-1', kind, body, channel: 'inapp' });
    expect(row).not.toBeNull();
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    const sent = await svc.pushToUser('client-1', 'Trial ending', body, { kind }, undefined, {
      kind,
      passesMuteAll: true,
      dedupeKey: 'trial_notice:n1:push',
    });
    expect(sent).toEqual({ delivered: true, code: 'delivered', detail: 'queued' });
    await delivery.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
