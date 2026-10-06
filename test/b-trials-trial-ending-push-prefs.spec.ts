import { Expo } from 'expo-server-sdk';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import * as pushPrefs from '../src/notifications/push/push-preferences';
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
    const prisma = {
      notificationPreferences: { findUnique: jest.fn(async () => prefs) },
      notification: { create: jest.fn(async (a: { data: object }) => ({ id: 'n1', ...a.data })) },
      user: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[trial]' })) },
    };
    const svc = new NotificationsService(
      stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
    );
    const send = jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
    jest.spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync').mockResolvedValue({});
    const body = 'Your free trial ends in 3 days.';
    const row = await svc.createNotification({ user_id: 'client-1', kind, body, channel: 'inapp' });
    expect(row).not.toBeNull();
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const sent = await svc.pushToUser('client-1', 'Trial ending', body, { kind });
    expect(sent).toEqual({ delivered: true, code: 'delivered' });
    expect(send).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});
