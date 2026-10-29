import type { AiActionDraft } from '@prisma/client';
import { SendNotificationMaterializer } from '../src/ai/gateway/materialisers/send-notification.materialiser';
import { stub } from './utils/trial-fakes';

// LO-1180R4B FOLLOW-UP: POST /v1/coach/ai/draft/send-notification drafts a
// push notification. Once the coach approves it, the materialiser writes one
// Notification row on the `push` channel and nothing else. The push pipeline
// sends only PushOutbox rows (push-delivery.service.ts), so no device push is
// ever queued. Expected: an approved push-channel draft queues a device push.
describe('LO-1180R4B: an approved AI push notification reaches the device', () => {
  it('queues a device push for a push-channel draft', async () => {
    const clientId = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
    const pushOutboxWrite = jest.fn(async () => ({ count: 1 }));
    const createNotification = jest.fn(async () => ({ id: 'notice-1' }));
    const prisma = {
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'coach-1' ? { id: 'coach-1', role: 'coach' } : { id: where.id, coach_id: 'coach-1' },
        ),
      },
      userBlock: { findMany: jest.fn(async () => []) },
      notification: { create: createNotification, findFirst: jest.fn(async () => null) },
      aiActionDraft: { updateMany: jest.fn(async () => ({ count: 1 })) },
      pushOutbox: { create: pushOutboxWrite, createMany: pushOutboxWrite },
    };
    const materialiser = new SendNotificationMaterializer(
      stub<ConstructorParameters<typeof SendNotificationMaterializer>[0]>(prisma),
    );
    const draft = stub<AiActionDraft>({
      id: 'draft-1',
      requester_id: 'coach-1',
      tenant_coach_id: 'coach-1',
      subject_user_id: clientId,
      decided_by_id: 'coach-1',
      payload: { clientId, kind: 'coach_nudge', body: 'Time to log today', channel: 'push' },
    });

    await expect(materialiser.materialize(draft)).resolves.toMatchObject({ status: 'sent' });
    expect(createNotification).toHaveBeenCalledWith({
      data: expect.objectContaining({ user_id: clientId, channel: 'push', kind: 'coach_nudge' }),
    });
    // Fails on main: nothing queues the device push.
    expect(pushOutboxWrite).toHaveBeenCalled();
  });
});
