// test/command-center.service.spec.ts
//
// Unit tests for CommandCenterService — the 5 P0 endpoints + dismiss.
// Uses in-memory Prisma fakes rather than a real DB so tests run on
// every CI without provisioning Postgres.

import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

const PINNED_NOW = new Date('2026-06-01T12:00:00Z').getTime();

beforeAll(() => {
  jest.spyOn(Date, 'now').mockReturnValue(PINNED_NOW);
});
afterAll(() => {
  jest.restoreAllMocks();
});

interface FakeRows {
  users: any[];
  signals: any[];
  checkIns: any[];
  predictions: any[];
  alerts: any[];
  messages: any[];
  assignments: any[];
}

function buildPrisma(initial: Partial<FakeRows> = {}): any {
  const rows: FakeRows = {
    users: initial.users ?? [],
    signals: initial.signals ?? [],
    checkIns: initial.checkIns ?? [],
    predictions: initial.predictions ?? [],
    alerts: initial.alerts ?? [],
    messages: initial.messages ?? [],
    assignments: initial.assignments ?? [],
  };

  return {
    rows,
    user: {
      findMany: jest.fn(async ({ where, select: _ }: any) => {
        return rows.users.filter((u) => {
          if (where.coach_id && u.coach_id !== where.coach_id) return false;
          if (where.id?.in && !where.id.in.includes(u.id)) return false;
          if (where.role && u.role !== where.role) return false;
          if (where.deleted_at === null && u.deleted_at !== null) return false;
          return true;
        });
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return rows.users.find((u) => u.id === where.id) ?? null;
      }),
    },
    subCoachAssignment: {
      findMany: jest.fn(async ({ where }: any) => {
        return rows.assignments.filter((a) => {
          if (where.sub_coach_id && a.sub_coach_id !== where.sub_coach_id)
            return false;
          if (where.unassigned_at === null && a.unassigned_at != null)
            return false;
          return true;
        });
      }),
    },
    clientSignal: {
      groupBy: jest.fn(async (args: any) => {
        const { where, by } = args;
        const filtered = rows.signals.filter((s) => {
          if (where.user_id?.in && !where.user_id.in.includes(s.user_id)) return false;
          if (where.signal_type && s.signal_type !== where.signal_type) return false;
          if (where.recorded_at?.gte && s.recorded_at < where.recorded_at.gte) return false;
          if (where.value?.gte != null && s.value < where.value.gte) return false;
          return true;
        });
        const groups = new Map<string, { rows: any[]; max: Date | null }>();
        for (const r of filtered) {
          const key = by.map((b: string) => r[b]).join('::');
          const g = groups.get(key) ?? { rows: [], max: null };
          g.rows.push(r);
          if (!g.max || r.recorded_at > g.max) g.max = r.recorded_at;
          groups.set(key, g);
        }
        return Array.from(groups.entries()).map(([key, g]) => {
          const out: any = {};
          const parts = key.split('::');
          by.forEach((b: string, i: number) => {
            out[b] = parts[i];
          });
          out._count = { _all: g.rows.length };
          out._max = {
            value: Math.max(...g.rows.map((r) => r.value)),
            recorded_at: g.max,
          };
          return out;
        });
      }),
      findMany: jest.fn(async ({ where, orderBy: _ob, select: _sel }: any) => {
        const filtered = rows.signals.filter((s) => {
          if (where.user_id?.in && !where.user_id.in.includes(s.user_id)) return false;
          if (where.signal_type && s.signal_type !== where.signal_type) return false;
          if (where.recorded_at?.gte && s.recorded_at < where.recorded_at.gte) return false;
          if (where.value?.gte != null && s.value < where.value.gte) return false;
          return true;
        });
        filtered.sort((a, b) => b.value - a.value);
        return filtered;
      }),
    },
    checkIn: {
      groupBy: jest.fn(async ({ where }: any) => {
        const filtered = rows.checkIns.filter((c) => {
          if (where.user_id?.in && !where.user_id.in.includes(c.user_id)) return false;
          if (where.logged_at?.gte && c.logged_at < where.logged_at.gte) return false;
          return true;
        });
        const byUser = new Map<string, any[]>();
        for (const c of filtered) {
          const arr = byUser.get(c.user_id) ?? [];
          arr.push(c);
          byUser.set(c.user_id, arr);
        }
        return Array.from(byUser.entries()).map(([uid, arr]) => ({
          user_id: uid,
          _count: { _all: arr.length },
        }));
      }),
      count: jest.fn(async ({ where }: any) => {
        return rows.checkIns.filter((c) => {
          if (where.user_id?.in && !where.user_id.in.includes(c.user_id)) return false;
          if (where.logged_at?.gte && c.logged_at < where.logged_at.gte) return false;
          if (
            where.reviewed_by_coach !== undefined &&
            (c.reviewed_by_coach ?? false) !== where.reviewed_by_coach
          )
            return false;
          return true;
        }).length;
      }),
    },
    coachAlert: {
      count: jest.fn(async ({ where }: any) => {
        return rows.alerts.filter((a) => {
          if (where.coach_id && a.coach_id !== where.coach_id) return false;
          if (where.client_id?.in && !where.client_id.in.includes(a.client_id)) return false;
          if (where.acknowledged_at === null && a.acknowledged_at !== null) return false;
          return true;
        }).length;
      }),
      findMany: jest.fn(async ({ where, take }: any) => {
        const filtered = rows.alerts.filter((a) => {
          if (where.coach_id && a.coach_id !== where.coach_id) return false;
          if (where.client_id?.in && !where.client_id.in.includes(a.client_id)) return false;
          if (where.acknowledged_at === null && a.acknowledged_at !== null) return false;
          if (where.created_at?.lt && a.created_at >= where.created_at.lt) return false;
          return true;
        });
        filtered.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return filtered.slice(0, take).map((a) => ({
          ...a,
          client: { name: rows.users.find((u) => u.id === a.client_id)?.name ?? 'Unknown' },
        }));
      }),
    },
    ptmPrediction: {
      groupBy: jest.fn(async ({ where }: any) => {
        const filtered = rows.predictions.filter((p) => {
          if (where.user_id?.in && !where.user_id.in.includes(p.user_id)) return false;
          return true;
        });
        const byUser = new Map<string, Date>();
        for (const p of filtered) {
          const prev = byUser.get(p.user_id);
          if (!prev || p.computed_at > prev) byUser.set(p.user_id, p.computed_at);
        }
        return Array.from(byUser.entries()).map(([uid, max]) => ({
          user_id: uid,
          _max: { computed_at: max },
        }));
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const ors: any[] = where.OR ?? [];
        return rows.predictions.filter((p) =>
          ors.some(
            (o) => o.user_id === p.user_id && o.computed_at?.getTime?.() === p.computed_at.getTime(),
          ),
        );
      }),
    },
    coachMessage: {
      count: jest.fn(async ({ where }: any) => {
        return rows.messages.filter((m) => {
          if (where.coach_id && m.coach_id !== where.coach_id) return false;
          if (where.client_id?.in && !where.client_id.in.includes(m.client_id)) return false;
          if (where.read_at === null && m.read_at != null) return false;
          if (where.NOT?.sender_id && m.sender_id === where.NOT.sender_id) return false;
          return true;
        }).length;
      }),
      findMany: jest.fn(async ({ where, take, distinct }: any) => {
        const filtered = rows.messages.filter((m) => {
          if (where.coach_id && m.coach_id !== where.coach_id) return false;
          if (where.client_id?.in && !where.client_id.in.includes(m.client_id)) return false;
          return true;
        });
        filtered.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        let out = filtered;
        // Emulate Prisma `distinct: ['client_id']` over an ordered result:
        // keep the FIRST row per client_id (i.e. newest, given the sort).
        if (distinct && distinct.includes('client_id')) {
          const seen = new Set<string>();
          out = filtered.filter((m) => {
            if (seen.has(m.client_id)) return false;
            seen.add(m.client_id);
            return true;
          });
        }
        return take ? out.slice(0, take) : out;
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const filtered = rows.messages.filter((m) => {
          if (where.coach_id && m.coach_id !== where.coach_id) return false;
          if (where.client_id?.in && !where.client_id.in.includes(m.client_id)) return false;
          if (where.read_at === null && m.read_at != null) return false;
          if (where.NOT?.sender_id && m.sender_id === where.NOT.sender_id) return false;
          return true;
        });
        const byClient = new Map<string, number>();
        for (const m of filtered) {
          byClient.set(m.client_id, (byClient.get(m.client_id) ?? 0) + 1);
        }
        return Array.from(byClient.entries()).map(([cid, n]) => ({
          client_id: cid,
          _count: { _all: n },
        }));
      }),
    },
  };
}

function buildAdminPtm(boardData: any[] = []): any {
  return {
    getRiskBoardForCoach: jest.fn(async (_coachId: string, _opts: any) => ({
      data: boardData,
      next_cursor: null,
      generated_at: new Date(PINNED_NOW).toISOString(),
    })),
  };
}

function buildAlertsService(): any {
  return {
    acknowledge: jest.fn(async (_id: string, _coach: string) => ({ acknowledged_at: new Date() })),
  };
}

// SC-2: a real SubCoachScopeService instance backed by the same in-memory
// Prisma fake. Head coach (coach_id IS NULL) -> own roster; sub-coach
// (role='coach' AND coach_id set) -> assigned clients via SubCoachAssignment.
function buildSubCoachScope(prisma: any): SubCoachScopeService {
  return new SubCoachScopeService(prisma);
}

describe('CommandCenterService.getOverview', () => {
  it('returns all zeros for a coach with no clients', async () => {
    const prisma = buildPrisma({ users: [] });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getOverview('c1');
    expect(out.roster_size).toBe(0);
    expect(out.active_today).toBe(0);
    expect(out.at_risk_count).toBe(0);
    expect(out.unread_messages).toBe(0);
    expect(out.pending_actions).toBe(0);
  });

  it('aggregates roster, alerts, unread messages, and at-risk count', async () => {
    const users = [
      { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      { id: 'u2', name: 'Bob', coach_id: 'c1', role: 'student', deleted_at: null },
      { id: 'u3', name: 'Carol', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    const now = new Date(PINNED_NOW);
    const recent = new Date(PINNED_NOW - 1000);
    const prisma = buildPrisma({
      users,
      signals: [
        { user_id: 'u1', signal_type: 'app_open', value: 1, recorded_at: recent },
        { user_id: 'u2', signal_type: 'checkin_streak', value: 5, recorded_at: recent },
      ],
      checkIns: [
        { user_id: 'u1', logged_at: recent },
        { user_id: 'u3', logged_at: recent },
      ],
      alerts: [
        { id: 'a1', coach_id: 'c1', client_id: 'u1', acknowledged_at: null, created_at: now },
        { id: 'a2', coach_id: 'c1', client_id: 'u2', acknowledged_at: null, created_at: now },
        { id: 'a3', coach_id: 'c1', client_id: 'u3', acknowledged_at: new Date(PINNED_NOW - 86_400_000), created_at: now },
      ],
      predictions: [
        { user_id: 'u1', risk_score: 0.7, computed_at: now },
        { user_id: 'u2', risk_score: 0.1, computed_at: now },
        { user_id: 'u3', risk_score: 0.4, computed_at: now },
      ],
      messages: [
        { coach_id: 'c1', client_id: 'u1', sender_id: 'u1', body: 'hi', read_at: null, created_at: now },
        { coach_id: 'c1', client_id: 'u2', sender_id: 'u2', body: 'yo', read_at: null, created_at: now },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getOverview('c1');
    expect(out.roster_size).toBe(3);
    // CC-2: active_today now counts real CheckIns in the last 24h (u1, u3),
    // NOT ClientSignal rows. u2 had a signal but no check-in, so is excluded.
    expect(out.active_today).toBe(2);
    expect(out.open_alerts).toBe(2);
    // CC-1: pending_actions is a DISTINCT source (unreviewed check-ins).
    // Both check-ins above have reviewed_by_coach defaulting to false, so 2.
    expect(out.pending_actions).toBe(2);
    expect(out.at_risk_count).toBe(2); // u1 (0.7) and u3 (0.4) > 0.3
    expect(out.win_streak_count).toBe(1); // u2 checkin_streak >= 3
    expect(out.unread_messages).toBe(2);
  });
});

describe('CommandCenterService.getAtRisk', () => {
  it('filters to amber + red when no bucket specified, maps risk_score=null', async () => {
    const board = [
      { user_id: 'u1', name: 'Alice', bucket: 'red', last_signal_at: '2026-05-20T00:00:00Z', email: 'a@a', role: 'student', risk_score: null, success_score: null, computed_at: new Date(), factors_count: 4, outcome_label: null },
      { user_id: 'u2', name: 'Bob', bucket: 'amber', last_signal_at: '2026-05-30T12:00:00Z', email: 'b@b', role: 'student', risk_score: null, success_score: null, computed_at: new Date(), factors_count: 2, outcome_label: null },
      { user_id: 'u3', name: 'Carol', bucket: 'green', last_signal_at: '2026-06-01T11:00:00Z', email: 'c@c', role: 'student', risk_score: null, success_score: null, computed_at: new Date(), factors_count: 0, outcome_label: null },
    ];
    // SC-2: getAtRisk now intersects the board with the SubCoachScope-resolved
    // roster, so the users must exist on coach c1's roster.
    const prisma = buildPrisma({
      users: [
        { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
        { id: 'u2', name: 'Bob', coach_id: 'c1', role: 'student', deleted_at: null },
        { id: 'u3', name: 'Carol', coach_id: 'c1', role: 'student', deleted_at: null },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(board), buildAlertsService());
    const out = await svc.getAtRisk('c1', {});
    expect(out.items.length).toBe(2);
    expect(out.items.every((i) => i.risk_score === null)).toBe(true);
    expect(out.items.map((i) => i.bucket).sort()).toEqual(['amber', 'red']);
    expect(out.total_at_risk).toBe(2);
  });

  it('new clients (no signal) get days_since_checkin=0 not 999', async () => {
    const board = [
      { user_id: 'u1', name: 'Alice', bucket: 'amber', last_signal_at: null, email: 'a@a', role: 'student', risk_score: null, success_score: null, computed_at: new Date(), factors_count: 0, outcome_label: null },
    ];
    const prisma = buildPrisma({
      users: [
        { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(board), buildAlertsService());
    const out = await svc.getAtRisk('c1', {});
    expect(out.items[0].days_since_checkin).toBe(0);
    // CC-3: no PtmPrediction.factors recorded for this user -> falls back to
    // the activity-based label (no recent signal).
    expect(out.items[0].top_factor).toBe('No recent activity');
  });
});

describe('CommandCenterService.getActionQueue', () => {
  it('returns only unacknowledged alerts and maps alert_type', async () => {
    const now = new Date(PINNED_NOW);
    const users = [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }];
    const prisma = buildPrisma({
      users,
      alerts: [
        {
          id: 'a1',
          coach_id: 'c1',
          client_id: 'u1',
          alert_type: 'risk_red_transition',
          severity: 'critical',
          message: 'red',
          payload: null,
          created_at: now,
          acknowledged_at: null,
        },
        {
          id: 'a2',
          coach_id: 'c1',
          client_id: 'u1',
          alert_type: 'consecutive_misses',
          severity: 'warning',
          message: 'misses',
          payload: null,
          created_at: now,
          acknowledged_at: null,
        },
        {
          id: 'a3',
          coach_id: 'c1',
          client_id: 'u1',
          alert_type: 'streak_dropped',
          severity: 'warning',
          message: 'dropped',
          payload: null,
          created_at: now,
          acknowledged_at: new Date(PINNED_NOW - 1000), // already acked
        },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getActionQueue('c1', {});
    expect(out.items.length).toBe(2);
    const types = out.items.map((i) => i.alert_type).sort();
    expect(types).toEqual(['high_churn_risk', 'missed_checkins']);
    expect(out.total_pending).toBe(2);
  });

  it('maps bloodwork_review backend alerts to bloodwork_review (not high_churn_risk)', async () => {
    const now = new Date(PINNED_NOW);
    const users = [
      { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    const prisma = buildPrisma({
      users,
      alerts: [
        {
          id: 'a1',
          coach_id: 'c1',
          client_id: 'u1',
          alert_type: 'bloodwork_review',
          severity: 'info',
          message: 'new labs uploaded',
          payload: null,
          created_at: now,
          acknowledged_at: null,
        },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getActionQueue('c1', {});
    expect(out.items.length).toBe(1);
    expect(out.items[0].alert_type).toBe('bloodwork_review');
  });
});

describe('CommandCenterService.dismissAlert', () => {
  it('delegates to alertsService.acknowledge — idempotent end-to-end', async () => {
    const prisma = buildPrisma();
    const alerts = buildAlertsService();
    const svc = new CommandCenterService(prisma, buildAdminPtm(), alerts);
    const out = await svc.dismissAlert('a1', 'c1');
    expect(out).toEqual({ ok: true });
    expect(alerts.acknowledge).toHaveBeenCalledWith('a1', 'c1');
    const out2 = await svc.dismissAlert('a1', 'c1');
    expect(out2).toEqual({ ok: true });
  });
});

describe('CommandCenterService.getInbox', () => {
  it('returns the latest message per client thread and deduplicates', async () => {
    const users = [
      { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    const t0 = new Date(PINNED_NOW - 1000);
    const t1 = new Date(PINNED_NOW - 500);
    const prisma = buildPrisma({
      users,
      messages: [
        { id: 'm1', coach_id: 'c1', client_id: 'u1', sender_id: 'u1', body: 'hello coach', read_at: null, created_at: t0 },
        { id: 'm2', coach_id: 'c1', client_id: 'u1', sender_id: 'c1', body: 'hi there client', read_at: t1, created_at: t1 },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getInbox('c1', {});
    expect(out.threads.length).toBe(1);
    // latest is t1 (coach -> client), so is_coach_turn === false
    expect(out.threads[0].is_coach_turn).toBe(false);
    expect(out.threads[0].last_message_preview).toBe('hi there client');
    expect(out.threads[0].unread_count).toBe(1);
    expect(out.total_unread).toBe(1);
  });

  it('truncates last_message_preview to 120 chars', async () => {
    const longBody = 'x'.repeat(500);
    const users = [{ id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null }];
    const prisma = buildPrisma({
      users,
      messages: [
        {
          id: 'm1',
          coach_id: 'c1',
          client_id: 'u1',
          sender_id: 'u1',
          body: longBody,
          read_at: null,
          created_at: new Date(PINNED_NOW),
        },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getInbox('c1', {});
    expect(out.threads[0].last_message_preview.length).toBe(120);
  });
});

describe('CommandCenterService.getWinStreaks', () => {
  it('returns clients with checkin_streak >= minStreak', async () => {
    const users = [
      { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      { id: 'u2', name: 'Bob', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    const now = new Date(PINNED_NOW - 1000);
    const prisma = buildPrisma({
      users,
      signals: [
        { user_id: 'u1', signal_type: 'checkin_streak', value: 7, recorded_at: now },
        { user_id: 'u2', signal_type: 'checkin_streak', value: 2, recorded_at: now }, // below min
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getWinStreaks('c1', { minStreak: 3 });
    expect(out.items.length).toBe(1);
    expect(out.items[0].user_id).toBe('u1');
    expect(out.items[0].streak_days).toBe(7);
    expect(out.items[0].streak_type).toBe('check_in');
  });
});
