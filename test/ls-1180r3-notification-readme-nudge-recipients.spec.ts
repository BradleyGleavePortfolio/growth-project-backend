import { readFileSync } from 'fs';
import { join } from 'path';
import type { Prisma } from '@prisma/client';
import { NudgeDetectorService } from '../src/notifications/nudges/nudge-detector.service';
import { NudgeEngineService } from '../src/notifications/nudges/nudge-engine.service';
import { NudgeStatus, NudgeTriggerType } from '../src/notifications/nudges/nudge.types';
import { NotificationsService } from '../src/notifications/notifications.service';
import { stub } from './utils/trial-fakes';

// Same B1 class: the matrix calls these recipients clients, although the
// detector explicitly supports active coaches and the engine delivers to them.
describe('LS-1180R3 B1: nudge recipients are not client-only', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [NudgeTriggerType.INACTIVE, 'nudge_inactive'],
    [NudgeTriggerType.ONBOARDING_ABANDONED, 'nudge_onboarding_abandoned'],
  ] as const)('documents coach recipients of %s', async (trigger, kind) => {
    const now = new Date('2026-05-08T18:00:00Z');
    const onboarding = trigger === NudgeTriggerType.ONBOARDING_ABANDONED;
    const coach = {
      id: 'eligible-coach',
      name: 'Eligible Coach',
      role: 'coach',
      created_at: new Date(now.getTime() - (onboarding ? 3 : 30) * 86_400_000),
      archived_at: null,
      deleted_at: null,
      profile: { onboardingCompleted: false },
    };
    const createNotification = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'coach-nudge-notice',
      ...data,
    }));
    const prisma = {
      user: {
        findMany: jest.fn(async ({ where }: { where: Prisma.UserWhereInput }) => {
          // These real queries contain no student-only role restriction.
          expect(where.role).toBeUndefined();
          // This fixture belongs to exactly one of the two creation windows.
          return Boolean(where.profile) === onboarding ? [coach] : [];
        }),
      },
      checkIn: {
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async () => []),
      },
      notification: {
        create: createNotification,
        groupBy: jest.fn(async () => onboarding ? [] : [{
          user_id: coach.id,
          _max: { read_at: new Date(now.getTime() - 10 * 86_400_000) },
        }]),
      },
      notificationPreferences: {
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
      coachSubscription: {
        findMany: jest.fn(async () => [{ coach_id: coach.id, status: 'active' }]),
      },
      clientPurchase: { findMany: jest.fn(async () => []) },
      nudgeLog: {
        create: jest.fn(async () => ({ id: 'coach-nudge-log' })),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async () => ({ id: 'coach-nudge-log' })),
      },
    };
    const notifications = new NotificationsService(
      stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
    );
    const push = jest.spyOn(notifications, 'pushToUser').mockResolvedValue({
      delivered: true,
      code: 'delivered',
    });
    const detector = new NudgeDetectorService(
      stub<ConstructorParameters<typeof NudgeDetectorService>[0]>(prisma),
    );
    const candidates = await detector.scanAll(now);
    expect(candidates).toEqual([expect.objectContaining({
      user_id: coach.id,
      trigger_type: trigger,
    })]);
    const engine = new NudgeEngineService(
      stub<ConstructorParameters<typeof NudgeEngineService>[0]>(prisma),
      notifications,
    );
    expect(await engine.process(candidates[0], now)).toMatchObject({
      status: NudgeStatus.SENT,
      channels: ['inapp', 'push'],
    });
    expect(createNotification).toHaveBeenCalledWith({
      data: expect.objectContaining({ user_id: coach.id, kind, channel: 'inapp' }),
    });
    expect(push).toHaveBeenCalledWith(
      coach.id, expect.any(String), expect.any(String), expect.objectContaining({ kind }),
    );

    const readme = readFileSync(join(__dirname, '../src/notifications/README.md'), 'utf8');
    const row = readme.split('\n').find((line) => line.startsWith(`| \`${kind}\` |`));
    expect(row).toBeDefined();
    const recipients = row!.split('|').slice(1, -1).map((cell) => cell.trim())[6];
    expect(recipients).toMatch(/\bCoach\b/i);
  });
});
