import { Expo } from 'expo-server-sdk';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { stub } from './utils/trial-fakes';

// Review witness, not the desired contract. TrialNoticeService calls this
// low-level sender at trial-notice.service.ts:744 instead of the queued
// sender. The inherited native/web path therefore bypasses the quiet policy.
describe('LS-1193R2 shared trial notice follow-up witness', () => {
  it('C FOLLOW-UP: the direct trial_ending sender sends at 02:00 although the common quiet policy defers it', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-01T02:00:00Z') });
    try {
      const kind = NotificationKind.TRIAL_ENDING;
      expect(quietHoursFor({ kind, timeZone: 'Europe/London', now: new Date() })).toMatchObject({
        deferred: true,
        reason: 'quiet_hours',
        deliverAt: new Date('2026-11-01T08:00:00Z'),
      });
      const prisma = stub<ConstructorParameters<typeof NotificationsService>[0]>({
        user: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[synthetic-quiet]' })) },
      });
      const send = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync')
        .mockResolvedValue([{ status: 'ok', id: 'synthetic-ticket' }]);
      jest.spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync').mockResolvedValue({});
      const service = new NotificationsService(prisma);
      const result = await service.pushToUser(
        'synthetic-client', 'Trial ending', 'Synthetic trial reminder', { kind },
      );
      expect(result).toEqual({ delivered: true, code: 'delivered' });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });
});
