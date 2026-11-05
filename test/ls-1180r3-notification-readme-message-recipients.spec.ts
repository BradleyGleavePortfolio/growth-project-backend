import { readFileSync } from 'fs';
import { join } from 'path';
import { MessagingService } from '../src/messaging/messaging.service';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { stub } from './utils/trial-fakes';

// LS-1180R3 B1: an ordinary client reply tells the assigned coach, too.
// Exercise the public send path and real emitter before checking its README row.
describe('LS-1180R3 B1: message_received names both real recipient roles', () => {
  const original = process.env.FEATURE_MESSAGING_CORE_V2;

  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env.FEATURE_MESSAGING_CORE_V2;
    else process.env.FEATURE_MESSAGING_CORE_V2 = original;
  });

  it.each(['false', 'true'])(
    'documents the coach receiving a client reply with messaging core v2=%s',
    async (flag) => {
      process.env.FEATURE_MESSAGING_CORE_V2 = flag;
      const createNotification = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'recipient-notice',
        ...data,
      }));
      const prisma = {
        user: {
          findUnique: jest.fn(async () => ({
            coach_id: 'recipient-coach',
            name: 'Reply sender',
          })),
        },
        coachMessage: {
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'recipient-message',
            ...data,
          })),
        },
        coachThreadState: { findUnique: jest.fn(async () => null) },
        notificationPreferences: { findUnique: jest.fn(async () => null) },
        notification: { create: createNotification },
      };
      const notifications = new NotificationsService(
        stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
      );
      const push = jest.spyOn(notifications, 'sendPush').mockResolvedValue({
        code: 'queued',
        notBefore: new Date(),
      });
      const messaging = new MessagingService(
        stub<ConstructorParameters<typeof MessagingService>[0]>(prisma),
        stub<ConstructorParameters<typeof MessagingService>[1]>({
          pingChat: jest.fn(async () => undefined),
        }),
        stub<ConstructorParameters<typeof MessagingService>[2]>({ capture: jest.fn() }),
        stub<ConstructorParameters<typeof MessagingService>[3]>({ emit: jest.fn() }),
        new MessageReceivedEmitter(notifications),
        stub<ConstructorParameters<typeof MessagingService>[5]>({
          write: jest.fn(async () => undefined),
        }),
        stub<ConstructorParameters<typeof MessagingService>[6]>({ invalidateForUser: jest.fn() }),
      );

      await messaging.sendAsClient('recipient-client', { body: 'A normal reply' });
      // The notification tail is intentionally fire-and-forget.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createNotification).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id: 'recipient-coach',
          kind: NotificationKind.MESSAGE_RECEIVED,
          channel: 'inapp',
        }),
      });
      expect(push).toHaveBeenCalledWith(expect.objectContaining({
        user_id: 'recipient-coach',
        kind: NotificationKind.MESSAGE_RECEIVED,
      }));

      const readme = readFileSync(join(__dirname, '../src/notifications/README.md'), 'utf8');
      const row = readme.split('\n').find((line) => /^\|\s*`message_received`\s*\|/.test(line));
      expect(row).toBeDefined();
      const recipients = row!.split('|').slice(1, -1).map((cell) => cell.trim())[6];
      expect(recipients).toMatch(/\bClient\b/i);
      expect(recipients).toMatch(/\bCoach\b/i);
    },
  );
});
