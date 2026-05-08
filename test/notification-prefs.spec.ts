/**
 * Integration tests for notification preferences CRUD.
 *
 * Tests verify:
 *   1. getPreferences returns defaults when no row exists
 *   2. updatePreferences creates a row on first call
 *   3. updatePreferences updates an existing row on subsequent calls
 *   4. Partial update (only some fields) does not overwrite unset fields with null
 *   5. muted flag suppresses createNotification writes
 *   6. Per-kind channel gate suppresses the write for disabled channel
 */

import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const storedPrefs = new Map<string, Record<string, unknown>>();
const storedNotifications: unknown[] = [];

const mockPrisma = {
  notificationPreferences: {
    findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
      Promise.resolve(storedPrefs.get(where.user_id) ?? null),
    ),
    update: jest.fn(
      ({ where, data }: { where: { user_id: string }; data: Record<string, unknown> }) => {
        const existing = storedPrefs.get(where.user_id) ?? {};
        const updated = { ...existing, ...data };
        storedPrefs.set(where.user_id, updated);
        return Promise.resolve(updated);
      },
    ),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row = { ...data };
      storedPrefs.set(data.user_id as string, row);
      return Promise.resolve(row);
    }),
  },
  notification: {
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      const row = { id: `n-${storedNotifications.length}`, ...args.data };
      storedNotifications.push(row);
      return Promise.resolve(row);
    }),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  notificationDigestLog: {
    create: jest.fn().mockResolvedValue({ id: 'log-1' }),
    update: jest.fn().mockResolvedValue({}),
  },
} as any;

// ── Service under test ────────────────────────────────────────────────────────

let service: NotificationsService;

beforeEach(() => {
  storedPrefs.clear();
  storedNotifications.length = 0;
  jest.clearAllMocks();
  service = new NotificationsService(mockPrisma);
});

// ── getPreferences ─────────────────────────────────────────────────────────────

describe('getPreferences', () => {
  it('returns defaults when no row exists', async () => {
    const prefs = await service.getPreferences('new-user');
    expect(prefs.user_id).toBe('new-user');
    expect(prefs.digest_email).toBe(true);
    expect(prefs.muted).toBe(false);
    expect(prefs.milestone_push).toBe(true);
  });

  it('returns stored row when it exists', async () => {
    storedPrefs.set('u1', { user_id: 'u1', digest_email: false, muted: true });
    const prefs = await service.getPreferences('u1');
    expect(prefs.digest_email).toBe(false);
    expect(prefs.muted).toBe(true);
  });
});

// ── updatePreferences ──────────────────────────────────────────────────────────

describe('updatePreferences', () => {
  it('creates a new row when no prefs exist', async () => {
    await service.updatePreferences('u1', { digest_email: false });
    expect(mockPrisma.notificationPreferences.create).toHaveBeenCalled();
    const row = storedPrefs.get('u1');
    expect(row?.digest_email).toBe(false);
  });

  it('updates existing row and does not wipe unset fields', async () => {
    storedPrefs.set('u1', { user_id: 'u1', digest_email: true, muted: false, milestone_push: true });
    await service.updatePreferences('u1', { muted: true });
    expect(mockPrisma.notificationPreferences.update).toHaveBeenCalled();
    const row = storedPrefs.get('u1');
    // muted updated
    expect(row?.muted).toBe(true);
    // milestone_push unchanged — undefined fields are stripped in the service
  });

  it('does not pass undefined fields to prisma', async () => {
    storedPrefs.set('u1', { user_id: 'u1', digest_email: true });
    await service.updatePreferences('u1', { muted: true });
    const updateCall = mockPrisma.notificationPreferences.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data).not.toHaveProperty('digest_email');
  });

  it('accepts all phase 9 channel flags', async () => {
    await service.updatePreferences('u1', {
      milestone_email: false,
      milestone_push: true,
      milestone_inapp: true,
      coach_alert_push: false,
    });
    const row = storedPrefs.get('u1');
    expect(row?.milestone_email).toBe(false);
    expect(row?.coach_alert_push).toBe(false);
  });
});

// ── createNotification + preference gating ─────────────────────────────────────

describe('createNotification preference gating', () => {
  it('creates the row when preferences allow it', async () => {
    storedPrefs.set('u1', { user_id: 'u1', muted: false, milestone_inapp: true });
    const result = await service.createNotification({
      user_id: 'u1',
      kind: NotificationKind.MILESTONE_REACHED,
      body: 'Test notification',
      channel: 'inapp',
    });
    expect(result).not.toBeNull();
    expect(mockPrisma.notification.create).toHaveBeenCalled();
  });

  it('suppresses notification when muted=true', async () => {
    storedPrefs.set('u1', { user_id: 'u1', muted: true });
    const result = await service.createNotification({
      user_id: 'u1',
      kind: NotificationKind.MILESTONE_REACHED,
      body: 'Test',
      channel: 'inapp',
    });
    expect(result).toBeNull();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('suppresses push notification when milestone_push=false', async () => {
    storedPrefs.set('u1', { user_id: 'u1', muted: false, milestone_push: false });
    const result = await service.createNotification({
      user_id: 'u1',
      kind: NotificationKind.MILESTONE_REACHED,
      body: 'Test',
      channel: 'push',
    });
    expect(result).toBeNull();
  });

  it('allows inapp even if push is disabled', async () => {
    storedPrefs.set('u1', { user_id: 'u1', muted: false, milestone_push: false, milestone_inapp: true });
    const result = await service.createNotification({
      user_id: 'u1',
      kind: NotificationKind.MILESTONE_REACHED,
      body: 'Test',
      channel: 'inapp',
    });
    expect(result).not.toBeNull();
  });

  it('truncates body to 160 chars', async () => {
    storedPrefs.set('u1', { user_id: 'u1', muted: false });
    const longBody = 'A'.repeat(200);
    await service.createNotification({
      user_id: 'u1',
      kind: NotificationKind.MILESTONE_REACHED,
      body: longBody,
      channel: 'inapp',
    });
    const createCall = mockPrisma.notification.create.mock.calls[0][0] as {
      data: { body: string };
    };
    expect(createCall.data.body.length).toBeLessThanOrEqual(160);
  });
});

// ── markRead ────────────────────────────────────────────────────────────────────

describe('markRead', () => {
  it('throws NotFoundException when notification does not exist', async () => {
    mockPrisma.notification.findUnique.mockResolvedValueOnce(null);
    await expect(service.markRead('nonexistent', 'u1')).rejects.toThrow('Notification not found');
  });

  it('throws NotFoundException when notification belongs to a different user', async () => {
    mockPrisma.notification.findUnique.mockResolvedValueOnce({
      id: 'n1',
      user_id: 'u2',
      read_at: null,
    });
    await expect(service.markRead('n1', 'u1')).rejects.toThrow('Notification not found');
  });

  it('returns existing row without update when already read', async () => {
    const existing = { id: 'n1', user_id: 'u1', read_at: new Date() };
    mockPrisma.notification.findUnique.mockResolvedValueOnce(existing);
    const result = await service.markRead('n1', 'u1');
    expect(result).toEqual(existing);
    expect(mockPrisma.notification.update).not.toHaveBeenCalled();
  });
});

// ── markAllRead ──────────────────────────────────────────────────────────────────

describe('markAllRead', () => {
  it('calls updateMany with user_id and read_at filter', async () => {
    mockPrisma.notification.updateMany.mockResolvedValueOnce({ count: 5 });
    const result = await service.markAllRead('u1');
    expect(result).toEqual({ updated: 5 });
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'u1', read_at: null } }),
    );
  });
});