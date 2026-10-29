import { MessagingService } from '../src/messaging/messaging.service';

// Adjacent legacy/off-mode note, not a new inbox leak: reading an empty
// closed thread must not acknowledge message notices that were not visible.
// The current v2 phone avoids this request on an empty page.
describe('LS-NOTIFY5B legacy empty closed-thread read note', () => {
  const clientId = 'client-1';
  const coachId = 'coach-1';

  function setup(block: 'client' | 'coach' | null) {
    const row: { read_at: Date | null } = { read_at: null };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: clientId, role: 'student', coach_id: coachId }),
      },
      userBlock: {
        findFirst: jest.fn().mockResolvedValue(block ? {
          blocker_id: block === 'client' ? clientId : coachId,
          blocked_id: block === 'client' ? coachId : clientId,
        } : null),
      },
      coachMessage: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notification: {
        updateMany: jest.fn().mockImplementation(async ({ data }) => {
          row.read_at = data.read_at;
          return { count: 1 };
        }),
      },
    };
    const service = new MessagingService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, row, prisma };
  }

  it.each(['client', 'coach'] as const)(
    'keeps an unseen notice unread after a legacy read of a %s-blocked empty thread',
    async (side) => {
      const { service, row } = setup(side);
      await expect(service.listThreadForClient(clientId, {})).resolves.toEqual([]);
      await service.markReadByClient(clientId);
      expect(row.read_at).toBeNull();
    },
  );

  it('ordinary unblocked read still acknowledges the message notice', async () => {
    const { service, row, prisma } = setup(null);
    await service.markReadByClient(clientId);
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    expect(row.read_at).toBeInstanceOf(Date);
  });
});
