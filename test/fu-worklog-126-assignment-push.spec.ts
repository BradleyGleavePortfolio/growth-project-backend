/**
 * FU-WORKLOG-126 (agent 126): a coach-assigned workout reaches the client's
 * phone and the tap opens the Workouts tab.
 *
 * Before: the assignment wrote only an inbox row (createNotification), so no
 * device push was ever sent, and a workout push tap opened the notification
 * center instead of the workout.
 */
import { PrismaService } from '../src/prisma.service';
import { NotificationsService, pushTapData } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('FU-WORKLOG-126 workout push tap target', () => {
  it('opens the Workouts tab for workout_assigned and workout_reminder', () => {
    expect(pushTapData(NotificationKind.WORKOUT_ASSIGNED, 'tgp://workouts/a-1', undefined)).toEqual({
      actionScreen: 'WorkoutMain',
      deepLink: 'tgp://workouts/a-1',
    });
    expect(pushTapData(NotificationKind.WORKOUT_REMINDER, undefined, undefined).actionScreen).toBe('WorkoutMain');
  });

  it('keeps messages on Messages and other kinds on the notification center', () => {
    expect(pushTapData('message_received', undefined, undefined).actionScreen).toBe('Messages');
    expect(pushTapData(NotificationKind.MEAL_PLAN_ASSIGNED, undefined, undefined).actionScreen).toBe('NotificationCenter');
  });
});

describe('FU-WORKLOG-126 assignment notification', () => {
  function build() {
    const createNotification = jest.fn(async () => ({ id: 'n-1' }));
    const sendPush = jest.fn(async () => null);
    const notifications = { createNotification, sendPush } as Partial<NotificationsService> as NotificationsService;
    const service = new WorkoutBuilderService({} as PrismaService, undefined, undefined, notifications);
    return { service, createNotification, sendPush };
  }

  it('writes the inbox row and queues the device push', async () => {
    const { service, createNotification, sendPush } = build();
    service.notifyProgramAssigned('client-1', 'asg-1', 'plan-1');
    await flush();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'client-1',
        kind: NotificationKind.WORKOUT_ASSIGNED,
        deep_link: 'tgp://workouts/asg-1',
      }),
    );
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledWith({
      user_id: 'client-1',
      kind: NotificationKind.WORKOUT_ASSIGNED,
      body: 'Your coach assigned a new workout.',
      deep_link: 'tgp://workouts/asg-1',
    });
  });

  it('never throws when the push fails (the assignment stands)', async () => {
    const { service, sendPush } = build();
    sendPush.mockRejectedValueOnce(new Error('expo down'));
    expect(() => service.notifyProgramAssigned('client-1', 'asg-2', 'plan-1')).not.toThrow();
    await flush();
    expect(sendPush).toHaveBeenCalledTimes(1);
  });
});
