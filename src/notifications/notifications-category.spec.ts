/**
 * notifications-category.spec.ts — Phase 11 / Push Taxonomy
 *
 * Asserts that:
 *   1. NotificationCategory enum has the four expected values.
 *   2. PushPayload can carry a category.
 *   3. buildExpoPushPayload() sets the categoryId field correctly.
 *   4. buildExpoPushPayload() defaults categoryId to SYSTEM when omitted.
 *   5. pushToCoach() logs the category in its delivery log line.
 */

import { Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import {
  NotificationCategory,
  DEFAULT_NOTIFICATION_CATEGORY,
} from './notification-category.enum';

// Minimal PrismaService stub — only the methods used by NotificationsService.
const mockPrisma = {
  notificationPreferences: {
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
  },
} as never;

describe('NotificationCategory enum', () => {
  it('has COACH_DIRECT value', () => {
    expect(NotificationCategory.COACH_DIRECT).toBe('COACH_DIRECT');
  });

  it('has CLIENT_BOT value', () => {
    expect(NotificationCategory.CLIENT_BOT).toBe('CLIENT_BOT');
  });

  it('has MILESTONE value', () => {
    expect(NotificationCategory.MILESTONE).toBe('MILESTONE');
  });

  it('has SYSTEM value', () => {
    expect(NotificationCategory.SYSTEM).toBe('SYSTEM');
  });

  it('DEFAULT_NOTIFICATION_CATEGORY is SYSTEM', () => {
    expect(DEFAULT_NOTIFICATION_CATEGORY).toBe(NotificationCategory.SYSTEM);
  });
});

describe('NotificationsService.buildExpoPushPayload()', () => {
  let service: NotificationsService;

  beforeEach(() => {
    service = new NotificationsService(mockPrisma);
  });

  it('sets categoryId to the supplied category', () => {
    const payload = service.buildExpoPushPayload({
      to: 'ExponentPushToken[test]',
      title: 'Test',
      body: 'Hello',
      category: NotificationCategory.COACH_DIRECT,
    });

    expect(payload.categoryId).toBe(NotificationCategory.COACH_DIRECT);
    expect(payload.to).toBe('ExponentPushToken[test]');
    expect(payload.title).toBe('Test');
    expect(payload.body).toBe('Hello');
  });

  it('defaults categoryId to SYSTEM when category is omitted', () => {
    const payload = service.buildExpoPushPayload({
      to: 'ExponentPushToken[test]',
      title: 'System alert',
      body: 'Your subscription has renewed.',
    });

    expect(payload.categoryId).toBe(NotificationCategory.SYSTEM);
  });

  it('defaults data to empty object when not provided', () => {
    const payload = service.buildExpoPushPayload({
      to: 'ExponentPushToken[test]',
      title: 'Reminder',
      body: 'Log your meal.',
      category: NotificationCategory.CLIENT_BOT,
    });

    expect(payload.data).toEqual({});
  });

  it('forwards custom data when provided', () => {
    const payload = service.buildExpoPushPayload({
      to: 'ExponentPushToken[test]',
      title: 'Milestone',
      body: 'Seven days in a row.',
      category: NotificationCategory.MILESTONE,
      data: { streak: 7 },
    });

    expect(payload.data).toEqual({ streak: 7 });
    expect(payload.categoryId).toBe(NotificationCategory.MILESTONE);
  });
});

describe('NotificationsService.pushToCoach()', () => {
  let service: NotificationsService;
  let loggerSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new NotificationsService(mockPrisma);
    loggerSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerSpy.mockRestore();
  });

  it('returns true and logs the delivery attempt', async () => {
    const result = await service.pushToCoach('coach-uuid-1', {
      alertId: 'alert-1',
      alertType: 'risk',
      severity: 'high',
      message: 'Client risk detected.',
      category: NotificationCategory.COACH_DIRECT,
    });

    expect(result).toBe(true);
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=COACH_DIRECT'),
    );
  });

  it('uses SYSTEM as default category when payload.category is omitted', async () => {
    const result = await service.pushToCoach('coach-uuid-2', {
      alertId: 'alert-2',
      alertType: 'system',
      severity: 'low',
      message: 'Subscription renewed.',
      // category intentionally omitted — should default to SYSTEM
    });

    expect(result).toBe(true);
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('category=SYSTEM'),
    );
  });
});
