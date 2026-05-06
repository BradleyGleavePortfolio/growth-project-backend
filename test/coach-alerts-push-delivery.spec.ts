/**
 * test/coach-alerts-push-delivery.spec.ts
 *
 * Phase 6B — confirms that CoachAlertsService.createAlert:
 *   1. Calls NotificationsService.pushToCoach when a new alert is created.
 *   2. Falls back gracefully to in-app inbox only when the coach has no push
 *      token (pushToCoach returns false).
 *   3. Does NOT throw when pushToCoach throws.
 *   4. Skips push (returns existing row) when dedup window is active.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CoachAlertsService, CreateAlertInput } from '../src/coach/coach-alerts.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<{
  id: string;
  coach_id: string;
  client_id: string;
  alert_type: string;
  severity: string;
  message: string;
  payload: unknown;
  created_at: Date;
  acknowledged_at: Date | null;
}> = {}) {
  return {
    id: 'alert-1',
    coach_id: 'coach-1',
    client_id: 'client-1',
    alert_type: 'risk_red_transition',
    severity: 'critical',
    message: 'Test alert',
    payload: null,
    created_at: new Date(),
    acknowledged_at: null,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('CoachAlertsService — push delivery (Phase 6B)', () => {
  let service: CoachAlertsService;
  let prisma: jest.Mocked<Pick<PrismaService, 'coachAlert'>>;
  let notifications: jest.Mocked<Pick<NotificationsService, 'pushToCoach'>>;

  const defaultInput: CreateAlertInput = {
    coachId: 'coach-1',
    clientId: 'client-1',
    alertType: 'risk_red_transition',
    severity: 'critical',
    message: 'Client risk is now red',
    payload: { prior_bucket: 'amber', next_bucket: 'red' },
  };

  beforeEach(async () => {
    prisma = {
      coachAlert: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      } as unknown as jest.Mocked<PrismaService['coachAlert']>,
    };

    notifications = {
      pushToCoach: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachAlertsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<CoachAlertsService>(CoachAlertsService);
  });

  describe('createAlert — new row (dedup miss)', () => {
    it('calls NotificationsService.pushToCoach with the created alert data', async () => {
      const alert = makeAlert();
      (prisma.coachAlert.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.coachAlert.create as jest.Mock).mockResolvedValue(alert);
      (notifications.pushToCoach as jest.Mock).mockResolvedValue(true);

      const result = await service.createAlert(defaultInput);

      expect(result).toEqual(alert);
      expect(notifications.pushToCoach).toHaveBeenCalledTimes(1);
      expect(notifications.pushToCoach).toHaveBeenCalledWith('coach-1', {
        alertId: alert.id,
        alertType: alert.alert_type,
        severity: alert.severity,
        message: alert.message,
      });
    });

    it('still returns the created alert when pushToCoach returns false (no token)', async () => {
      const alert = makeAlert();
      (prisma.coachAlert.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.coachAlert.create as jest.Mock).mockResolvedValue(alert);
      // Simulate: coach has no push token
      (notifications.pushToCoach as jest.Mock).mockResolvedValue(false);

      const result = await service.createAlert(defaultInput);

      // Alert still written and returned — in-app inbox works regardless
      expect(result).toEqual(alert);
      expect(notifications.pushToCoach).toHaveBeenCalledTimes(1);
    });

    it('does NOT throw and still returns the alert when pushToCoach throws', async () => {
      const alert = makeAlert();
      (prisma.coachAlert.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.coachAlert.create as jest.Mock).mockResolvedValue(alert);
      (notifications.pushToCoach as jest.Mock).mockRejectedValue(
        new Error('network failure'),
      );

      // Should not throw
      await expect(service.createAlert(defaultInput)).resolves.toEqual(alert);
    });
  });

  describe('createAlert — dedup hit (existing unacknowledged row within 24h)', () => {
    it('returns existing row WITHOUT calling pushToCoach', async () => {
      const existing = makeAlert({ id: 'existing-alert' });
      (prisma.coachAlert.findFirst as jest.Mock).mockResolvedValue(existing);

      const result = await service.createAlert(defaultInput);

      expect(result).toEqual(existing);
      // No new row created
      expect(prisma.coachAlert.create).not.toHaveBeenCalled();
      // No push attempted for a dedup-hit
      expect(notifications.pushToCoach).not.toHaveBeenCalled();
    });
  });

  describe('payload format', () => {
    it('passes alertType, severity, message verbatim in the push payload', async () => {
      const alert = makeAlert({
        alert_type: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });
      (prisma.coachAlert.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.coachAlert.create as jest.Mock).mockResolvedValue(alert);
      (notifications.pushToCoach as jest.Mock).mockResolvedValue(true);

      await service.createAlert({
        ...defaultInput,
        alertType: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });

      const [, payload] = (notifications.pushToCoach as jest.Mock).mock.calls[0];
      expect(payload).toMatchObject({
        alertType: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });
      // Must include alertId
      expect(payload.alertId).toBe(alert.id);
    });
  });
});
