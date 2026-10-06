import { Logger } from '@nestjs/common';
import { MessagingService } from '../../src/messaging/messaging.service';

/**
 * AUDIT-03-125 U4: reading a thread also reads the reader's "New message"
 * inbox rows for that thread, so the notification bell stops counting
 * messages that were just read. Best effort: a notification failure never
 * fails the read.
 */
describe('MessagingService read clears the thread message notifications', () => {
  const notificationUpdate = jest.fn();
  const messageUpdate = jest.fn();
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ coach_id: 'coach-A' })),
      findFirst: jest.fn(async () => ({ id: 'client-1', coach_id: 'coach-A' })),
    },
    coachMessage: { updateMany: messageUpdate },
    notification: { updateMany: notificationUpdate },
  };

  function service(): MessagingService {
    const svc: MessagingService = Object.create(MessagingService.prototype);
    return Object.assign(svc, { prisma, logger: new Logger('test') });
  }

  beforeEach(() => {
    notificationUpdate.mockReset().mockResolvedValue({ count: 2 });
    messageUpdate.mockReset().mockResolvedValue({ count: 1 });
  });

  it('client read marks the client\'s message_received rows for the thread read', async () => {
    await expect(service().markReadByClient('client-1')).resolves.toEqual({ updated: 1 });
    expect(notificationUpdate).toHaveBeenCalledWith({
      where: {
        user_id: 'client-1',
        kind: 'message_received',
        deep_link: 'tgp://messages/client-1',
        read_at: null,
      },
      data: { read_at: expect.any(Date) },
    });
  });

  it('coach read marks only that client thread\'s rows for the coach', async () => {
    await expect(service().markReadByCoach('coach-A', 'client-1')).resolves.toEqual({ updated: 1 });
    expect(notificationUpdate).toHaveBeenCalledWith({
      where: {
        user_id: 'coach-A',
        kind: 'message_received',
        deep_link: 'tgp://messages/client-1',
        read_at: null,
      },
      data: { read_at: expect.any(Date) },
    });
  });

  it('a notification failure never fails the read', async () => {
    notificationUpdate.mockRejectedValueOnce(new Error('db down'));
    await expect(service().markReadByClient('client-1')).resolves.toEqual({ updated: 1 });
  });
});
