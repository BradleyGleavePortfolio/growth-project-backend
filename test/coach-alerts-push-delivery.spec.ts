/**
 * test/coach-alerts-push-delivery.spec.ts
 *
 * Phase 6B — confirms that CoachAlertsService.createAlert:
 *   1. Delivers a new alert through CoachAlertEmitter (inbox row + quiet push
 *      via sendPush; AUDIT-09-125), never through the raw pushToCoach send.
 *   2. Still returns the alert when the push is skipped (muted, no token).
 *   3. Does NOT throw when the emitter throws.
 *   4. Skips push (returns existing row) when dedup window is active.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CoachAlertsService, CreateAlertInput } from '../src/coach/coach-alerts.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
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
  let emitterMock: { emit: jest.Mock };
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

    emitterMock = {
      emit: jest.fn().mockResolvedValue({ inapp: 'sent', push: 'sent' }),
    };
    notificationsMock = {
      pushToCoach: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachAlertsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CoachAlertEmitter, useValue: emitterMock },
        { provide: NotificationsService, useValue: notificationsMock },
      ],
    }).compile();

    service = module.get<CoachAlertsService>(CoachAlertsService);
  });

  describe('createAlert — new row (dedup miss)', () => {
    it('delivers through CoachAlertEmitter with the created alert data', async () => {
      const alert = makeAlert();
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);

      const result = await service.createAlert(defaultInput);

      expect(result).toEqual(alert);
      expect(emitterMock.emit).toHaveBeenCalledTimes(1);
      expect(emitterMock.emit).toHaveBeenCalledWith({
        coachId: 'coach-1',
        alertId: alert.id,
        alertType: alert.alert_type,
        message: alert.message,
        severity: alert.severity,
        clientUserId: 'client-1',
      });
    });

    it('never sends the alert text straight to the lock screen (pushToCoach)', async () => {
      const alert = makeAlert({ message: 'Jordan Client crossed into the red risk band (82%).' });
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);

      await service.createAlert(defaultInput);

      expect(notificationsMock.pushToCoach).not.toHaveBeenCalled();
    });

    it('still returns the created alert when the push is skipped (muted or no token)', async () => {
      const alert = makeAlert();
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);
      emitterMock.emit.mockResolvedValue({ inapp: 'skipped', push: 'skipped' });

      const result = await service.createAlert(defaultInput);

      expect(result).toEqual(alert);
      expect(emitterMock.emit).toHaveBeenCalledTimes(1);
    });

    it('does NOT throw and still returns the alert when the emitter throws', async () => {
      const alert = makeAlert();
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);
      emitterMock.emit.mockRejectedValue(new Error('network failure'));

      await expect(service.createAlert(defaultInput)).resolves.toEqual(alert);
    });
  });

  describe('createAlert — dedup hit (existing unacknowledged row within 24h)', () => {
    it('returns existing row WITHOUT delivering again', async () => {
      const existing = makeAlert({ id: 'existing-alert' });
      prismaMock.coachAlert.findFirst.mockResolvedValue(existing);

      const result = await service.createAlert(defaultInput);

      expect(result).toEqual(existing);
      // No new row created
      expect(prismaMock.coachAlert.create).not.toHaveBeenCalled();
      // No push attempted for a dedup-hit
      expect(emitterMock.emit).not.toHaveBeenCalled();
    });
  });

  describe('payload format', () => {
    it('passes alertType, severity, message verbatim to the emitter', async () => {
      const alert = makeAlert({
        alert_type: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });
      prismaMock.coachAlert.findFirst.mockResolvedValue(null);
      prismaMock.coachAlert.create.mockResolvedValue(alert);

      await service.createAlert({
        ...defaultInput,
        alertType: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });

      const [payload] = emitterMock.emit.mock.calls[0];
      expect(payload).toMatchObject({
        alertType: 'consecutive_misses',
        severity: 'warning',
        message: 'Client has missed 3 consecutive check-ins',
      });
      expect(payload.alertId).toBe(alert.id);
    });
  });
});
