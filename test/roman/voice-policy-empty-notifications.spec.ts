import { NotificationsService } from '../../src/notifications/notifications.service';
import { VoicePolicyService } from '../../src/roman/voice/voice-policy.service';
import {
  LEGACY,
  ROMAN_V2,
} from '../../src/roman/voice/voice-policy.constants';
import { FEATURE_ROMAN_COPY_V2_ENV } from '../../src/roman/voice/voice-policy.feature';

/**
 * Roman Phase 2 — integration: the notifications list empty-state copy routes
 * through VoicePolicyService.
 *
 *   - When there are zero items, `emptyState` carries the surface payload
 *     (text + avatar_crop), flag-aware.
 *   - When there ARE items, `emptyState` is null and the existing response
 *     shape (items / nextCursor / unreadCount) is preserved.
 */

function fakePrisma(rows: unknown[]) {
  return {
    notification: {
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function buildService(rows: unknown[]) {
  const prisma = fakePrisma(rows);
  const voice = new VoicePolicyService();
  // ctor: (prisma, audit?, voice?)
  const service = new NotificationsService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    undefined,
    voice,
  );
  return service;
}

describe('NotificationsService.listNotifications empty-state → VoicePolicyService', () => {
  const prev = process.env[FEATURE_ROMAN_COPY_V2_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[FEATURE_ROMAN_COPY_V2_ENV];
    else process.env[FEATURE_ROMAN_COPY_V2_ENV] = prev;
  });

  it('flag OFF → empty list carries the legacy empty-state copy + neutral crop', async () => {
    delete process.env[FEATURE_ROMAN_COPY_V2_ENV];
    const service = buildService([]);
    const res = await service.listNotifications('user_1', {} as never);
    expect(res.items).toHaveLength(0);
    expect(res.emptyState).not.toBeNull();
    expect(res.emptyState?.text).toBe(LEGACY.empty_notifications);
    expect(res.emptyState?.avatar_crop).toBe('neutral');
    expect(res.emptyState?.voice_variant).toBe('legacy');
  });

  it('flag ON → empty list carries the Roman empty-state copy', async () => {
    process.env[FEATURE_ROMAN_COPY_V2_ENV] = 'true';
    const service = buildService([]);
    const res = await service.listNotifications('user_1', {} as never);
    expect(res.emptyState?.text).toBe(ROMAN_V2.empty_notifications);
    expect(res.emptyState?.avatar_crop).toBe('neutral');
    expect(res.emptyState?.voice_variant).toBe('roman_v2');
  });

  it('non-empty list → emptyState is null, shape preserved', async () => {
    const service = buildService([
      { id: 'n1', created_at: new Date(), user_id: 'user_1' },
    ]);
    const res = await service.listNotifications('user_1', {} as never);
    expect(res.items).toHaveLength(1);
    expect(res.emptyState).toBeNull();
    expect(res).toHaveProperty('nextCursor');
    expect(res).toHaveProperty('unreadCount');
  });
});
