import { readFileSync } from 'fs';
import { join } from 'path';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { PrismaService } from '../src/prisma.service';
import { stub } from './utils/trial-fakes';

describe('LS-BE3 B1: the notification README agrees with the Mute all row contract', () => {
  it('documents that Mute all preserves the inbox row, as the named preferences test proves', async () => {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'mute-readme-row',
      ...data,
    }));
    const service = new NotificationsService(stub<PrismaService>({
      notificationPreferences: {
        findUnique: jest.fn(async () => ({ user_id: 'mute-readme-user', muted: true })),
      },
      notification: { create },
    }));

    // The ordinary user has muted notifications, then earns a milestone.
    // Exercise the real row gate rather than infer its policy from prose.
    const row = await service.createNotification({
      user_id: 'mute-readme-user',
      kind: NotificationKind.MILESTONE_REACHED,
      channel: 'inapp',
      body: 'Milestone reached',
    });
    expect(row).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);

    // The README advertises what this very suite tests. Its description
    // must not assert the reverse of the implemented, owner-required rule.
    const readme = readFileSync(join(__dirname, '../src/notifications/README.md'), 'utf8');
    const description = readme.split('\n').find((line) =>
      line.includes('notification-prefs.spec.ts'),
    );
    expect(description).toBeDefined();
    expect(description).not.toMatch(/mute suppresses createNotification/i);
  });
});
