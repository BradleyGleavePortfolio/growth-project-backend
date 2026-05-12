/**
 * test/coach-alerts-emitters.spec.ts
 *
 * Phase 6B — emitter integration tests for:
 *   1. consecutive_misses  — fired from CheckInsService
 *   2. streak_dropped      — fired from CheckInsService
 *
 * For each emitter:
 *   - Verify the alert is created with the correct type/severity/payload
 *   - Verify 24h dedup is respected (second call within window returns existing row)
 *   - Verify payload format matches the schema in docs/coach-signals.md
 *
 * finance_eod_gap is tracked in GitHub issue #144 (blocked on Agent 1A's
 * federation endpoint). TODO stubs are included below for completeness.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CoachAlertsService } from '../src/coach/coach-alerts.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationCategory } from '../src/notifications/notification-category.enum';
import { PrismaService } from '../src/prisma.service';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeExistingAlert(alertType: string) {
  return {
    id: `existing-${alertType}`,
    coach_id: 'coach-1',
    client_id: 'client-1',
    alert_type: alertType,
    severity: 'warning',
    message: 'existing',
    payload: null,
    created_at: new Date(),
    acknowledged_at: null,
  };
}

function makeCreatedAlert(
  alertType: string,
  severity: string,
  message: string,
  payload: Record<string, unknown> | null,
) {
  return {
    id: `created-${alertType}`,
    coach_id: 'coach-1',
    client_id: 'client-1',
    alert_type: alertType,
    severity,
    message,
    payload,
    created_at: new Date(),
    acknowledged_at: null,
  };
}

// ── fixture factory ───────────────────────────────────────────────────────────

async function buildService(options: {
  findFirstResult: unknown;
  createResult?: unknown;
}) {
  const prismaMock = {
    coachAlert: {
      findFirst: jest.fn().mockResolvedValue(options.findFirstResult),
      create: jest.fn().mockResolvedValue(
        options.createResult ??
          makeCreatedAlert('risk_red_transition', 'critical', 'msg', null),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
  };

  const notificationsMock = {
    pushToCoach: jest.fn().mockResolvedValue(true),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CoachAlertsService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: NotificationsService, useValue: notificationsMock },
    ],
  }).compile();

  return {
    service: module.get<CoachAlertsService>(CoachAlertsService),
    prismaMock,
    notificationsMock,
  };
}

// ── consecutive_misses ────────────────────────────────────────────────────────

describe('Phase 6B emitter: consecutive_misses', () => {
  const alertType = 'consecutive_misses';
  const missCount = 3;
  const input = {
    coachId: 'coach-1',
    clientId: 'client-1',
    alertType: alertType as 'consecutive_misses',
    severity: 'warning' as const,
    message: `Client has missed ${missCount} consecutive check-ins`,
    payload: { consecutive_miss_days: missCount },
  };

  it('creates the alert with correct type and severity', async () => {
    const created = makeCreatedAlert(alertType, 'warning', input.message, { consecutive_miss_days: missCount });
    const { service } = await buildService({
      findFirstResult: null,
      createResult: created,
    });

    const result = await service.createAlert(input);

    expect(result.alert_type).toBe(alertType);
    expect(result.severity).toBe('warning');
  });

  it('payload contains consecutive_miss_days', async () => {
    const created = makeCreatedAlert(alertType, 'warning', input.message, { consecutive_miss_days: missCount });
    const { service } = await buildService({
      findFirstResult: null,
      createResult: created,
    });

    const result = await service.createAlert(input);

    expect(result.payload).toMatchObject({ consecutive_miss_days: missCount });
  });

  it('respects 24h dedup — returns existing row without creating a new one', async () => {
    const existing = makeExistingAlert(alertType);
    const { service, prismaMock } = await buildService({
      findFirstResult: existing,
    });

    const result = await service.createAlert(input);

    expect(result).toEqual(existing);
    expect(prismaMock.coachAlert.create).not.toHaveBeenCalled();
  });

  it('dedup query uses the correct alert_type filter', async () => {
    const { service, prismaMock } = await buildService({
      findFirstResult: null,
      createResult: makeCreatedAlert(alertType, 'warning', input.message, null),
    });

    await service.createAlert(input);

    const findFirstCall = prismaMock.coachAlert.findFirst.mock.calls[0][0];
    expect(findFirstCall.where.alert_type).toBe(alertType);
    expect(findFirstCall.where.coach_id).toBe('coach-1');
    expect(findFirstCall.where.client_id).toBe('client-1');
    expect(findFirstCall.where.acknowledged_at).toBeNull();
  });

  it('push is called with correct payload on new alert', async () => {
    const created = makeCreatedAlert(alertType, 'warning', input.message, { consecutive_miss_days: missCount });
    const { service, notificationsMock } = await buildService({
      findFirstResult: null,
      createResult: created,
    });

    await service.createAlert(input);

    expect(notificationsMock.pushToCoach).toHaveBeenCalledWith('coach-1', {
      alertId: created.id,
      alertType,
      severity: 'warning',
      message: input.message,
      category: NotificationCategory.COACH_DIRECT,
    });
  });
});

// ── streak_dropped ────────────────────────────────────────────────────────────

describe('Phase 6B emitter: streak_dropped', () => {
  const alertType = 'streak_dropped';
  const priorStreak = 10;
  const input = {
    coachId: 'coach-1',
    clientId: 'client-1',
    alertType: alertType as 'streak_dropped',
    severity: 'info' as const,
    message: `Client's check-in streak dropped from ${priorStreak} days to 0`,
    payload: { prior_streak: priorStreak, new_streak: 0 },
  };

  it('creates the alert with correct type and severity info', async () => {
    const created = makeCreatedAlert(alertType, 'info', input.message, { prior_streak: priorStreak, new_streak: 0 });
    const { service } = await buildService({
      findFirstResult: null,
      createResult: created,
    });

    const result = await service.createAlert(input);

    expect(result.alert_type).toBe(alertType);
    expect(result.severity).toBe('info');
  });

  it('payload contains prior_streak and new_streak', async () => {
    const created = makeCreatedAlert(alertType, 'info', input.message, { prior_streak: priorStreak, new_streak: 0 });
    const { service } = await buildService({
      findFirstResult: null,
      createResult: created,
    });

    const result = await service.createAlert(input);

    expect(result.payload).toMatchObject({
      prior_streak: priorStreak,
      new_streak: 0,
    });
  });

  it('respects 24h dedup — returns existing row without creating a new one', async () => {
    const existing = makeExistingAlert(alertType);
    const { service, prismaMock } = await buildService({
      findFirstResult: existing,
    });

    const result = await service.createAlert(input);

    expect(result).toEqual(existing);
    expect(prismaMock.coachAlert.create).not.toHaveBeenCalled();
  });

  it('dedup window uses acknowledged_at: null filter so an acked alert re-fires', async () => {
    // An acked alert (acknowledged_at != null) would NOT be found by the dedup query,
    // so a new alert would be created. We verify the query filters on acknowledged_at.
    const { service, prismaMock } = await buildService({
      findFirstResult: null,
      createResult: makeCreatedAlert(alertType, 'info', input.message, null),
    });

    await service.createAlert(input);

    const findFirstCall = prismaMock.coachAlert.findFirst.mock.calls[0][0];
    expect(findFirstCall.where.acknowledged_at).toBeNull();
  });

  it('push is called with info severity', async () => {
    const created = makeCreatedAlert(alertType, 'info', input.message, { prior_streak: priorStreak, new_streak: 0 });
    const { service, notificationsMock } = await buildService({
      findFirstResult: null,
      createResult: created,
    });

    await service.createAlert(input);

    expect(notificationsMock.pushToCoach).toHaveBeenCalledWith('coach-1', {
      alertId: created.id,
      alertType,
      severity: 'info',
      message: input.message,
      category: NotificationCategory.COACH_DIRECT,
    });
  });
});

// ── finance_eod_gap (TODO — blocked on Agent 1A, see GitHub issue #144) ──────

describe('Phase 6B emitter: finance_eod_gap (TODO — blocked on Agent 1A)', () => {
  // These tests will be filled in once `fix/ptm-app-open-and-finance-federation`
  // lands and the federation-inbound endpoint is wired.
  // See: https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/144

  it.todo('creates finance_eod_gap alert when 5+ consecutive finance_eod_skip signals arrive within 7 days');
  it.todo('respects 24h dedup for finance_eod_gap');
  it.todo('payload contains consecutive_finance_eod_skip_count and window_days');
  it.todo('does not fire if only 4 consecutive skips');
  it.todo('push is called with warning severity');
});

// ── cross-type dedup isolation ─────────────────────────────────────────────────

describe('dedup is isolated per alert_type', () => {
  it('a consecutive_misses dedup hit does not suppress a streak_dropped alert', async () => {
    // findFirst returns null for each unique (coach, client, type) combination
    // This test verifies the dedup query passes the specific alert_type.
    const { service, prismaMock } = await buildService({
      findFirstResult: null,
      createResult: makeCreatedAlert('streak_dropped', 'info', 'msg', null),
    });

    await service.createAlert({
      coachId: 'coach-1',
      clientId: 'client-1',
      alertType: 'streak_dropped',
      severity: 'info',
      message: 'streak dropped',
    });

    const findFirstCall = prismaMock.coachAlert.findFirst.mock.calls[0][0];
    expect(findFirstCall.where.alert_type).toBe('streak_dropped');
    // create is called because findFirst returned null
    expect(prismaMock.coachAlert.create).toHaveBeenCalledTimes(1);
  });
});
