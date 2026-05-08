import { CoachAlertsService } from '../src/coach/coach-alerts.service';

// Phase 6B — verify the alert service contract:
//   * createAlert deduplicates within 24h for the same
//     (coach_id, client_id, alert_type) tuple — returns the prior row
//     instead of inserting a duplicate.
//   * createAlert inserts a fresh row when no recent unacknowledged
//     match exists (or when the prior match is older than 24h).
//   * acknowledge is idempotent: repeating against an already-acked
//     row returns the existing row without writing.
//   * acknowledge raises NotFoundException when the alert belongs to
//     another coach (no existence leak).
//   * listForCoach honors the acknowledged filter.

// Pin a stable "now" so the 24h dedup window arithmetic is deterministic
// regardless of when CI runs. The service calls Date.now() internally; we
// override it so fixture timestamps remain within (or outside) the window
// as intended by each test.
const PINNED_NOW = new Date('2026-05-06T10:00:00Z').getTime();

function nowMs() {
  return PINNED_NOW;
}

function buildPrisma(initial: any[] = []) {
  let rows = [...initial];
  let counter = 0;
  return {
    rows: () => rows,
    coachAlert: {
      findFirst: jest.fn(async ({ where, orderBy: _orderBy }: any) => {
        const candidates = rows.filter((r) => {
          if (where.id && r.id !== where.id) return false;
          if (where.coach_id && r.coach_id !== where.coach_id) return false;
          if (where.client_id && r.client_id !== where.client_id) return false;
          if (where.alert_type && r.alert_type !== where.alert_type) return false;
          if (where.acknowledged_at === null && r.acknowledged_at !== null) return false;
          if (where.created_at?.gte && r.created_at < where.created_at.gte) return false;
          return true;
        });
        candidates.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return candidates[0] ?? null;
      }),
      findMany: jest.fn(async ({ where, take }: any) => {
        let items = rows.filter((r) => {
          if (where.coach_id && r.coach_id !== where.coach_id) return false;
          if (where.acknowledged_at === null && r.acknowledged_at !== null) return false;
          if (where.acknowledged_at?.not === null && r.acknowledged_at === null) return false;
          return true;
        });
        items.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return items.slice(0, take);
      }),
      create: jest.fn(async ({ data }: any) => {
        counter += 1;
        const row = {
          id: `a-${counter}`,
          severity: 'warning',
          payload: null,
          acknowledged_at: null,
          created_at: new Date(nowMs()),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx < 0) throw new Error('not found');
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      }),
    },
  };
}

const HOUR = 60 * 60 * 1000;

// Pin Date.now() for the whole suite so the 24h dedup window is stable.
beforeAll(() => {
  jest.spyOn(Date, 'now').mockReturnValue(PINNED_NOW);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('CoachAlertsService', () => {
  it('createAlert dedups within 24h for the same coach/client/type', async () => {
    const prisma = buildPrisma([
      {
        id: 'existing-1',
        coach_id: 'c1',
        client_id: 's1',
        alert_type: 'risk_red_transition',
        severity: 'critical',
        message: 'previous',
        payload: null,
        created_at: new Date(nowMs() - 2 * HOUR),
        acknowledged_at: null,
      },
    ]);
    const svc = new CoachAlertsService(prisma as any);
    const out = await svc.createAlert({
      coachId: 'c1',
      clientId: 's1',
      alertType: 'risk_red_transition',
      message: 'duplicate within window',
    });
    expect(out.id).toBe('existing-1');
    expect(prisma.coachAlert.create).not.toHaveBeenCalled();
  });

  it('createAlert writes a fresh row when no recent match exists', async () => {
    const prisma = buildPrisma([]);
    const svc = new CoachAlertsService(prisma as any);
    const out = await svc.createAlert({
      coachId: 'c1',
      clientId: 's1',
      alertType: 'risk_red_transition',
      severity: 'critical',
      message: 'first alert',
      payload: { k: 'v' },
    });
    expect(out.message).toBe('first alert');
    expect(prisma.coachAlert.create).toHaveBeenCalledTimes(1);
  });

  it('createAlert writes a fresh row when prior match is older than 24h', async () => {
    const prisma = buildPrisma([
      {
        id: 'old-1',
        coach_id: 'c1',
        client_id: 's1',
        alert_type: 'risk_red_transition',
        severity: 'critical',
        message: 'old',
        payload: null,
        created_at: new Date(nowMs() - 30 * HOUR),
        acknowledged_at: null,
      },
    ]);
    const svc = new CoachAlertsService(prisma as any);
    await svc.createAlert({
      coachId: 'c1',
      clientId: 's1',
      alertType: 'risk_red_transition',
      message: 'new',
    });
    expect(prisma.coachAlert.create).toHaveBeenCalledTimes(1);
  });

  it('acknowledge is idempotent', async () => {
    const acked = new Date(nowMs() - 5 * HOUR);
    const prisma = buildPrisma([
      {
        id: 'a-1',
        coach_id: 'c1',
        client_id: 's1',
        alert_type: 'risk_red_transition',
        severity: 'critical',
        message: 'm',
        payload: null,
        created_at: new Date(nowMs() - 6 * HOUR),
        acknowledged_at: acked,
      },
    ]);
    const svc = new CoachAlertsService(prisma as any);
    const row = await svc.acknowledge('a-1', 'c1');
    expect(row.acknowledged_at).toEqual(acked);
    expect(prisma.coachAlert.update).not.toHaveBeenCalled();
  });

  it('acknowledge throws NotFoundException for foreign coach', async () => {
    const prisma = buildPrisma([
      {
        id: 'a-1',
        coach_id: 'c1',
        client_id: 's1',
        alert_type: 'risk_red_transition',
        severity: 'critical',
        message: 'm',
        payload: null,
        created_at: new Date(nowMs() - 1 * HOUR),
        acknowledged_at: null,
      },
    ]);
    const svc = new CoachAlertsService(prisma as any);
    await expect(svc.acknowledge('a-1', 'other-coach')).rejects.toThrow(/not found/i);
  });

  it('listForCoach respects the acknowledged filter', async () => {
    const prisma = buildPrisma([
      {
        id: 'unack-1',
        coach_id: 'c1',
        client_id: 's1',
        alert_type: 'risk_red_transition',
        severity: 'critical',
        message: 'unack',
        payload: null,
        created_at: new Date(nowMs() - 3 * HOUR),
        acknowledged_at: null,
      },
      {
        id: 'ack-1',
        coach_id: 'c1',
        client_id: 's2',
        alert_type: 'consecutive_misses',
        severity: 'warning',
        message: 'ack',
        payload: null,
        created_at: new Date(nowMs() - 4 * HOUR),
        acknowledged_at: new Date(nowMs() - 1 * HOUR),
      },
    ]);
    const svc = new CoachAlertsService(prisma as any);
    const unread = await svc.listForCoach({ coachId: 'c1', acknowledged: false });
    const acked = await svc.listForCoach({ coachId: 'c1', acknowledged: true });
    expect(unread.map((r) => r.id)).toEqual(['unack-1']);
    expect(acked.map((r) => r.id)).toEqual(['ack-1']);
  });
});
