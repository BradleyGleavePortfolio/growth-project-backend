/**
 * test/coach-alerts-push-delivery.spec.ts
 *
 * Phase 6B — confirms that CoachAlertsService.createAlert:
 *   1. Calls NotificationsService.pushToCoach when a new alert is created.
 *   2. Falls back gracefully to in-app inbox only when pushToCoach returns false
 *      (simulating no push token scenario).
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
  let prismaMock: any;
  let notificationsMock: { pushToCoach: jest.Mock };

  const defaultInput: CreateAlertInput = {
    coachId: 'coach-1',
    clientId: 'client-1',
    alertType: 'risk_red_transition',
    severity: 'critical',
    message: 'Client risk is now red',
    payload: { prior_bucket: 'amber', next_bucket: 'red' },
  };

  beforeEach(async () => {
    prismaMock = {
      coachAlert: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };

    notificationsMock = {
      pushToCoach: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachAlertsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: NotificationsService, useValue: notificationsMock },
      ],
    }).compile();

    service = module.get<CoachAlertsService>(CoachAlertsService);
  });

  describe('createAlert — new row (dedup miss)', () => {
    it('calls NotificationsService.pushToCoach with the created alert data', async () => {
      const alert = makeAlert();
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);
      notificationsMock.pushToCoach.mockResolvedValue(true);

      const result = await service.createAlert(defaultInput);

      expect(result).toEqual(alert);
      expect(notificationsMock.pushToCoach).toHaveBeenCalledTimes(1);
      expect(notificationsMock.pushToCoach).toHaveBeenCalledWith('coach-1', {
        alertId: alert.id,
        alertType: alert.alert_type,
        severity: alert.severity,
        message: alert.message,
      });
    });

    it('still returns the created alert when pushToCoach returns false (no token)', async () => {
      const alert = makeAlert();
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);
      // Simulate: coach has no push token
      notificationsMock.pushToCoach.mockResolvedValue(false);

      const result = await service.createAlert(defaultInput);

      // Alert still written and returned — in-app inbox works regardless
      expect(result).toEqual(alert);
      expect(notificationsMock.pushToCoach).toHaveBeenCalledTimes(1);
    });

    it('does NOT throw and still returns the alert when pushToCoach throws', async () => {
      const alert = makeAlert();
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);
      notificationsMock.pushToCoach.mockRejectedValue(new Error('network failure'));

      // Should not throw
      await expect(service.createAlert(defaultInput)).resolves.toEqual(alert);
    });
  });

  describe('createAlert — dedup hit (existing unacknowledged row within 24h)', () => {
    it('returns existing row WITHOUT calling pushToCoach', async () => {
      const existing = makeAlert({ id: 'existing-alert' });
      prismaMock.coachAlert.findFirst.mockResolvedValue(existing);

      const result = await service.createAlert(defaultInput);

      expect(result).toEqual(existing);
      // No new row created
      expect(prismaMock.coachAlert.create).not.toHaveBeenCalled();
      // No push attempted for a dedup-hit
      expect(notificationsMock.pushToCoach).not.toHaveBeenCalled();
    });
  });

  describe('payload format', () => {
    it('passes alertType, severity, message verbatim in the push payload', async () => {
      const alert = makeAlert({
        alert_type: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);
      notificationsMock.pushToCoach.mockResolvedValue(true);

      await service.createAlert({
        ...defaultInput,
        alertType: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });

      const [, payload] = notificationsMock.pushToCoach.mock.calls[0];
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
