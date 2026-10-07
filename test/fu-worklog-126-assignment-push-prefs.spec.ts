import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import * as pushPrefs from '../src/notifications/push/push-preferences';
import { stub } from './utils/trial-fakes';

// B-814-1: run the real preference gates, not a mocked sendPush. Only storage
// and the final outbox enqueue are mocked; no production writes or sends.
describe('workout_assigned through the real notification gates', () => {
  const kind = NotificationKind.WORKOUT_ASSIGNED;

  function service(prefs: Record<string, unknown> | null) {
    const prisma = {
      notificationPreferences: { findUnique: jest.fn(async () => prefs) },
      notification: { create: jest.fn(async (a: { data: object }) => ({ id: 'n1', ...a.data })) },
    };
    const delivery = { enqueue: jest.fn(async () => ({ id: 'push-1', deduplicated: false })) };
    const svc = new NotificationsService(
      stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
      undefined,
      undefined,
      stub<NonNullable<ConstructorParameters<typeof NotificationsService>[3]>>(delivery),
    );
    return { svc, prisma, delivery };
  }

  const input = {
    user_id: 'assignment-client',
    kind,
    body: 'Your coach added a workout for you.',
    deep_link: 'workout_assignment:assignment-1',
    context: { timeZone: 'America/Los_Angeles' },
  };

  it('maps assigned workouts to the default-on workout switches, not digest', () => {
    expect(pushPrefs.notificationPrefsPrefix(kind)).toBe('workout_reminder');
  });

  it('writes the inbox row and enqueues a push with no preferences row', async () => {
    const { svc, prisma, delivery } = service(null);
    expect(await svc.createNotification({ ...input, channel: 'inapp' })).not.toBeNull();
    expect(await svc.sendPush(input)).not.toBeNull();
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(delivery.enqueue).toHaveBeenCalledTimes(1);
    expect(delivery.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind, data: expect.objectContaining({ actionScreen: 'WorkoutMain' }) }),
      undefined,
    );
  });

  it('still delivers when the default digest switches are off', async () => {
    const { svc, delivery } = service({ muted: false, digest_push: false, digest_inapp: false });
    expect(await svc.createNotification({ ...input, channel: 'inapp' })).not.toBeNull();
    expect(await svc.sendPush(input)).not.toBeNull();
    expect(delivery.enqueue).toHaveBeenCalledTimes(1);
  });

  it('respects the client switching workout notifications off', async () => {
    const { svc, prisma, delivery } = service({
      muted: false, workout_reminder_push: false, workout_reminder_inapp: false,
    });
    expect(await svc.createNotification({ ...input, channel: 'inapp' })).toBeNull();
    expect(await svc.sendPush(input)).toBeNull();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(delivery.enqueue).not.toHaveBeenCalled();
  });

  it('respects mute all', async () => {
    const { svc, delivery } = service({ muted: true });
    expect(await svc.createNotification({ ...input, channel: 'inapp' })).toBeNull();
    expect(await svc.sendPush(input)).toBeNull();
    expect(delivery.enqueue).not.toHaveBeenCalled();
  });
});
