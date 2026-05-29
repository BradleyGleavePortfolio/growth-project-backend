import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';

// PR-15A A2 — verify _kindToPrefsPrefix routes 'coach_new_purchase'
// to its dedicated prefs prefix (NOT 'digest'). Mirrors the PR-10 R1
// audit-fix test the brief calls out:
//   "do NOT let it fall through to a default-off digest bucket, that
//    was a fixed PR-10 bug."

describe('NotificationsService — COACH_NEW_PURCHASE prefs routing', () => {
  it('routes kind=coach_new_purchase to coach_new_purchase_* prefs (not digest)', async () => {
    let lookupKey: string | null = null;
    const prisma = {
      notificationPreferences: {
        findUnique: jest.fn(async () => ({
          // Defaults match the migration: push + inapp default ON, email OFF.
          coach_new_purchase_email: false,
          coach_new_purchase_push: true,
          coach_new_purchase_inapp: true,
          // The digest bucket — kept default OFF on push+inapp so a
          // wrong routing would silently suppress the write. If our
          // branch lives, in-app create() reaches the DB call.
          digest_email: true,
          digest_push: false,
          digest_inapp: false,
        })),
      },
      notification: {
        create: jest.fn(async ({ data }: any) => {
          lookupKey = data.kind;
          return { id: 'n_1', ...data };
        }),
      },
    };
    const svc = new NotificationsService(prisma as never);

    const result = await svc.createNotification({
      user_id: 'coach_1',
      kind: NotificationKind.COACH_NEW_PURCHASE,
      body: 'Alex Buyer bought your Pro Strength package',
      channel: 'inapp',
    });
    expect(result).not.toBeNull();
    expect(lookupKey).toBe('coach_new_purchase');
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it('respects coach_new_purchase_inapp=false → suppresses the row', async () => {
    const prisma = {
      notificationPreferences: {
        findUnique: jest.fn(async () => ({
          coach_new_purchase_email: false,
          coach_new_purchase_push: true,
          coach_new_purchase_inapp: false,
        })),
      },
      notification: { create: jest.fn() },
    };
    const svc = new NotificationsService(prisma as never);

    const result = await svc.createNotification({
      user_id: 'coach_1',
      kind: NotificationKind.COACH_NEW_PURCHASE,
      body: 'Sale',
      channel: 'inapp',
    });
    expect(result).toBeNull();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('default prefs (no row yet) return push+inapp ON for coach_new_purchase', async () => {
    const prisma = {
      notificationPreferences: {
        findUnique: jest.fn(async () => null),
      },
    };
    const svc = new NotificationsService(prisma as never);
    const prefs = (await svc.getPreferences('coach_1')) as Record<string, unknown>;
    expect(prefs.coach_new_purchase_email).toBe(false);
    expect(prefs.coach_new_purchase_push).toBe(true);
    expect(prefs.coach_new_purchase_inapp).toBe(true);
  });
});
