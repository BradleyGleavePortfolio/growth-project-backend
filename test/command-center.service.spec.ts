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
          // P1c: client-authored filter is `sender_id IN clientIds`.
          if (where.sender_id?.in && !where.sender_id.in.includes(m.sender_id)) return false;
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
          // P1c: client-authored filter is `sender_id IN clientIds`.
          if (where.sender_id?.in && !where.sender_id.in.includes(m.sender_id)) return false;
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
    // P1b: CommandCenterService.dismissAlert now routes through the scoped
    // ack so a sub-coach may dismiss alerts for their assigned clients.
    acknowledgeForScope: jest.fn(
      async (_id: string, _owner: string, _allowed: string[]) => ({
        acknowledged_at: new Date(),
      }),
    ),
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
  it('delegates to alertsService.acknowledgeForScope — idempotent end-to-end', async () => {
    // Head coach c1 owns u1; the dismiss is authorized on
    // (coach_id = c1, client_id IN [u1]).
    const prisma = buildPrisma({
      users: [
        { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      ],
    });
    const alerts = buildAlertsService();
    const svc = new CommandCenterService(prisma, buildAdminPtm(), alerts);
    const out = await svc.dismissAlert('a1', 'c1');
    expect(out).toEqual({ ok: true });
    expect(alerts.acknowledgeForScope).toHaveBeenCalledWith('a1', 'c1', ['u1']);
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

// ─────────────────────────────────────────────────────────────────────────
// Wave-1 issue-specific coverage (CC-1..5, SC-2). Each test isolates the
// behaviour the corresponding fix introduced.
// ─────────────────────────────────────────────────────────────────────────

describe('CC-1: pending_actions is a distinct source from open_alerts', () => {
  it('pending_actions (unreviewed check-ins) differs from open_alerts', async () => {
    const now = new Date(PINNED_NOW);
    const recent = new Date(PINNED_NOW - 1000);
    const users = [
      { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      { id: 'u2', name: 'Bob', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    const prisma = buildPrisma({
      users,
      // 3 check-ins; only u1's morning one is reviewed → 2 unreviewed pending.
      checkIns: [
        { user_id: 'u1', logged_at: recent, reviewed_by_coach: true },
        { user_id: 'u1', logged_at: recent, reviewed_by_coach: false },
        { user_id: 'u2', logged_at: recent, reviewed_by_coach: false },
      ],
      // exactly 1 open alert
      alerts: [
        { id: 'a1', coach_id: 'c1', client_id: 'u1', acknowledged_at: null, created_at: now },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getOverview('c1');
    expect(out.open_alerts).toBe(1);
    expect(out.pending_actions).toBe(2);
    expect(out.pending_actions).not.toBe(out.open_alerts);
  });
});

describe('CC-2: active_today counts CheckIns, not ClientSignal rows', () => {
  it('signals do not inflate active_today; only real check-ins count', async () => {
    const recent = new Date(PINNED_NOW - 1000);
    const users = [
      { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      { id: 'u2', name: 'Bob', coach_id: 'c1', role: 'student', deleted_at: null },
      { id: 'u3', name: 'Carol', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    const prisma = buildPrisma({
      users,
      // All three have system signals today (PTM recalcs / streak updates)…
      signals: [
        { user_id: 'u1', signal_type: 'app_open', value: 1, recorded_at: recent },
        { user_id: 'u2', signal_type: 'app_open', value: 1, recorded_at: recent },
        { user_id: 'u3', signal_type: 'checkin_streak', value: 4, recorded_at: recent },
      ],
      // …but only u1 actually checked in today.
      checkIns: [{ user_id: 'u1', logged_at: recent }],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getOverview('c1');
    expect(out.active_today).toBe(1); // would have been 3 under the old signal-based logic
  });
});

describe('CC-3: top_factor reflects PtmPrediction.factors', () => {
  it('surfaces the highest-contribution factor label from the latest prediction', async () => {
    const board = [
      { user_id: 'u1', name: 'Alice', bucket: 'red', last_signal_at: '2026-05-31T00:00:00Z', email: 'a@a', role: 'student', risk_score: null, success_score: null, computed_at: new Date(), factors_count: 3, outcome_label: null },
    ];
    const prisma = buildPrisma({
      users: [
        { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      ],
      predictions: [
        {
          user_id: 'u1',
          risk_score: 0.8,
          computed_at: new Date(PINNED_NOW - 1000),
          factors: [
            { key: 'missed_checkins', label: 'Missed 4 of last 7 check-ins', contribution: 0.42 },
            { key: 'msg_silence', label: 'No messages in 10 days', contribution: 0.21 },
            { key: 'weight_gap', label: 'No weight logged in 8 days', contribution: 0.05 },
          ],
        },
      ],
    });
    const svc = new CommandCenterService(prisma, buildAdminPtm(board), buildAlertsService());
    const out = await svc.getAtRisk('c1', {});
    expect(out.items.length).toBe(1);
    // Highest-contribution factor wins, regardless of array order.
    expect(out.items[0].top_factor).toBe('Missed 4 of last 7 check-ins');
    // NOT the old hard-coded generic string.
    expect(out.items[0].top_factor).not.toBe('High churn risk — multiple signals fired');
  });
});

describe('CC-4: inbox/unread agree even beyond the old 1000-row slice', () => {
  it('a thread whose latest message is "old" still appears, and total_unread matches displayed threads', async () => {
    const users = [
      { id: 'u1', name: 'Alice', coach_id: 'c1', role: 'student', deleted_at: null },
      { id: 'u2', name: 'Bob', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    // u2's only (and latest) message is much older than u1's flood — under the
    // old take:1000 global slice u2's thread could fall off entirely while its
    // unread still counted. distinct-per-client keeps u2 present.
    const old = new Date(PINNED_NOW - 100 * 86_400_000);
    const recent = new Date(PINNED_NOW - 1000);
    const messages: any[] = [
      { id: 'mu2', coach_id: 'c1', client_id: 'u2', sender_id: 'u2', body: 'old unread', read_at: null, created_at: old },
    ];
    // Flood u1 with many recent messages.
    for (let i = 0; i < 50; i++) {
      messages.push({
        id: `mu1-${i}`,
        coach_id: 'c1',
        client_id: 'u1',
        sender_id: 'u1',
        body: `msg ${i}`,
        read_at: i === 0 ? null : new Date(recent.getTime()),
        created_at: new Date(recent.getTime() - i * 1000),
      });
    }
    const prisma = buildPrisma({ users, messages });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getInbox('c1', {});
    // Both threads represented.
    const clientIds = out.threads.map((t) => t.client_id).sort();
    expect(clientIds).toEqual(['u1', 'u2']);
    // total_unread equals the sum of the displayed threads' unread counts.
    const sum = out.threads.reduce((s, t) => s + t.unread_count, 0);
    expect(out.total_unread).toBe(sum);
    // u2's old unread is included (1) plus u1's single unread (1) = 2.
    expect(out.total_unread).toBe(2);
  });
});

describe('CC-5: check_in_rate_7day is a frequency, not binary participation', () => {
  it('10 clients each with 1 check-in is NOT 100%', async () => {
    const recent = new Date(PINNED_NOW - 1000);
    const users: any[] = [];
    const checkIns: any[] = [];
    for (let i = 0; i < 10; i++) {
      users.push({ id: `u${i}`, name: `U${i}`, coach_id: 'c1', role: 'student', deleted_at: null });
      checkIns.push({ user_id: `u${i}`, logged_at: recent }); // exactly one each
    }
    const prisma = buildPrisma({ users, checkIns });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getOverview('c1');
    // Old binary logic: 10 distinct clients / 10 roster = 1.0 (100%).
    // New frequency logic: 10 check-ins / (10 * 7 expected) = 0.142… → 0.14.
    expect(out.check_in_rate_7day).toBeCloseTo(0.14, 2);
    expect(out.check_in_rate_7day).toBeLessThan(1);
  });

  it('a fully adherent roster (1 check-in/client/day) reaches ~100%', async () => {
    const users = [
      { id: 'u1', name: 'A', coach_id: 'c1', role: 'student', deleted_at: null },
    ];
    const checkIns: any[] = [];
    for (let d = 0; d < 7; d++) {
      checkIns.push({ user_id: 'u1', logged_at: new Date(PINNED_NOW - d * 86_400_000 - 1000) });
    }
    const prisma = buildPrisma({ users, checkIns });
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService());
    const out = await svc.getOverview('c1');
    expect(out.check_in_rate_7day).toBe(1);
  });
});

describe('SC-2: roster scoping differs for head coach vs sub-coach', () => {
  // Head coach `head` owns u1,u2,u3. Sub-coach `sub` (role coach, coach_id=head)
  // is assigned only u2 via SubCoachAssignment.
  function scopedPrisma() {
    const now = new Date(PINNED_NOW);
    const recent = new Date(PINNED_NOW - 1000);
    return buildPrisma({
      users: [
        { id: 'head', name: 'Head', coach_id: null, role: 'coach', deleted_at: null },
        { id: 'sub', name: 'Sub', coach_id: 'head', role: 'coach', deleted_at: null },
        { id: 'u1', name: 'Alice', coach_id: 'head', role: 'student', deleted_at: null },
        { id: 'u2', name: 'Bob', coach_id: 'head', role: 'student', deleted_at: null },
        { id: 'u3', name: 'Carol', coach_id: 'head', role: 'student', deleted_at: null },
      ],
      assignments: [
        { sub_coach_id: 'sub', client_id: 'u2', unassigned_at: null },
      ],
      checkIns: [
        { user_id: 'u1', logged_at: recent },
        { user_id: 'u2', logged_at: recent },
        { user_id: 'u3', logged_at: recent },
      ],
      alerts: [
        { id: 'a1', coach_id: 'head', client_id: 'u1', alert_type: 'consecutive_misses', message: 'm', acknowledged_at: null, created_at: now },
        { id: 'a2', coach_id: 'head', client_id: 'u2', alert_type: 'consecutive_misses', message: 'm', acknowledged_at: null, created_at: now },
        { id: 'a3', coach_id: 'head', client_id: 'u3', alert_type: 'consecutive_misses', message: 'm', acknowledged_at: null, created_at: now },
      ],
    });
  }

  it('overview: head sees full roster (3); sub sees only assigned (1)', async () => {
    const prisma = scopedPrisma();
    const scope = buildSubCoachScope(prisma);
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService(), scope);

    const head = await svc.getOverview('head');
    expect(head.roster_size).toBe(3);
    expect(head.active_today).toBe(3);
    expect(head.open_alerts).toBe(3);

    const sub = await svc.getOverview('sub');
    expect(sub.roster_size).toBe(1);
    expect(sub.active_today).toBe(1);
    expect(sub.open_alerts).toBe(1); // only u2's alert, still owned by head coach_id
  });

  it('action-queue: sub-coach only sees alerts for assigned clients', async () => {
    const prisma = scopedPrisma();
    const scope = buildSubCoachScope(prisma);
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService(), scope);

    const head = await svc.getActionQueue('head', {});
    expect(head.total_pending).toBe(3);

    const sub = await svc.getActionQueue('sub', {});
    expect(sub.total_pending).toBe(1);
    expect(sub.items.map((i) => i.client_id)).toEqual(['u2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Wave-1 CC+SC re-audit fixes (P1a at-risk, P1b dismiss, P1c msg semantics).
// Head coach `head` owns u1,u2,u3. Sub-coach `sub` (role coach,
// coach_id=head) is assigned only u2 via SubCoachAssignment. Alerts and
// messages are owned by the HEAD coach's coach_id; sub-coach sends carry
// sender_id = 'sub'.
// ─────────────────────────────────────────────────────────────────────────

// A risk-board fake that HONOURS opts.clientIds (the P1a contract). Every
// student row is at amber/red; the board returns only the rows whose
// user_id is in the resolved clientIds set, mirroring the real
// getRiskBoardForCoach now that it scores the resolved authorized set.
function buildScopedAdminPtm(allBoardRows: any[]): any {
  return {
    getRiskBoardForCoach: jest.fn(async (_coachId: string, opts: any) => {
      const ids: string[] | undefined = opts?.clientIds;
      const data =
        ids === undefined
          ? allBoardRows
          : allBoardRows.filter((r) => ids.includes(r.user_id));
      return {
        data,
        next_cursor: null,
        generated_at: new Date(PINNED_NOW).toISOString(),
      };
    }),
  };
}

// An alerts-service fake whose acknowledgeForScope enforces the scoped
// ownership exactly like CoachAlertsService.acknowledgeForScope does:
// the alert must exist with coach_id = ownerCoachId AND client_id IN allowed.
function buildScopedAlertsService(alerts: any[]): any {
  return {
    acknowledge: jest.fn(),
    acknowledgeForScope: jest.fn(
      async (alertId: string, ownerCoachId: string, allowed: string[]) => {
        const row = alerts.find(
          (a) =>
            a.id === alertId &&
            a.coach_id === ownerCoachId &&
            allowed.includes(a.client_id),
        );
        if (!row) throw new Error('Alert not found');
        row.acknowledged_at = new Date();
        return row;
      },
    ),
  };
}

function ccscScopedRows() {
  const now = new Date(PINNED_NOW);
  return {
    users: [
      { id: 'head', name: 'Head', coach_id: null, role: 'coach', deleted_at: null },
      { id: 'sub', name: 'Sub', coach_id: 'head', role: 'coach', deleted_at: null },
      { id: 'u1', name: 'Alice', coach_id: 'head', role: 'student', deleted_at: null },
      { id: 'u2', name: 'Bob', coach_id: 'head', role: 'student', deleted_at: null },
      { id: 'u3', name: 'Carol', coach_id: 'head', role: 'student', deleted_at: null },
    ],
    assignments: [{ sub_coach_id: 'sub', client_id: 'u2', unassigned_at: null }],
    now,
  };
}

describe('CC+SC P1a: sub-coach at-risk list returns assigned clients', () => {
  const board = [
    { user_id: 'u1', name: 'Alice', bucket: 'red', last_signal_at: '2026-05-20T00:00:00Z', email: 'a@a', role: 'student', risk_score: null, success_score: null, computed_at: new Date(PINNED_NOW), factors_count: 1, outcome_label: null },
    { user_id: 'u2', name: 'Bob', bucket: 'amber', last_signal_at: '2026-05-30T00:00:00Z', email: 'b@b', role: 'student', risk_score: null, success_score: null, computed_at: new Date(PINNED_NOW), factors_count: 1, outcome_label: null },
    { user_id: 'u3', name: 'Carol', bucket: 'red', last_signal_at: '2026-05-21T00:00:00Z', email: 'c@c', role: 'student', risk_score: null, success_score: null, computed_at: new Date(PINNED_NOW), factors_count: 1, outcome_label: null },
  ];

  it('sub-coach sees ONLY their assigned client (u2), not an empty list', async () => {
    const { users, assignments } = ccscScopedRows();
    const prisma = buildPrisma({ users, assignments });
    const scope = buildSubCoachScope(prisma);
    const adminPtm = buildScopedAdminPtm(board);
    const svc = new CommandCenterService(prisma, adminPtm, buildAlertsService(), scope);

    const sub = await svc.getAtRisk('sub', {});
    // Before the fix the board was built with the raw sub-coach id, which
    // resolves NO roster (sub-coaches don't own students via coach_id), so
    // the list came back EMPTY. Now it is built against the resolved
    // authorized set [u2].
    expect(sub.items.map((i) => i.user_id)).toEqual(['u2']);
    expect(sub.total_at_risk).toBe(1);
    // The board was asked for exactly the sub-coach's authorized clients.
    expect(adminPtm.getRiskBoardForCoach).toHaveBeenCalledWith(
      'sub',
      expect.objectContaining({ clientIds: ['u2'] }),
    );
  });

  it('head coach behaviour unchanged: full roster at-risk (u1, u2, u3)', async () => {
    const { users, assignments } = ccscScopedRows();
    const prisma = buildPrisma({ users, assignments });
    const scope = buildSubCoachScope(prisma);
    const adminPtm = buildScopedAdminPtm(board);
    const svc = new CommandCenterService(prisma, adminPtm, buildAlertsService(), scope);

    const head = await svc.getAtRisk('head', {});
    expect(head.items.map((i) => i.user_id).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(head.total_at_risk).toBe(3);
    expect(adminPtm.getRiskBoardForCoach).toHaveBeenCalledWith(
      'head',
      expect.objectContaining({ clientIds: ['u1', 'u2', 'u3'] }),
    );
  });
});

describe('CC+SC P1b: sub-coach can dismiss an assigned client\'s alert', () => {
  it('sub-coach dismisses u2\'s alert (owned by head coach_id); u1\'s is denied', async () => {
    const { users, assignments, now } = ccscScopedRows();
    const alerts = [
      { id: 'a-u1', coach_id: 'head', client_id: 'u1', acknowledged_at: null, created_at: now },
      { id: 'a-u2', coach_id: 'head', client_id: 'u2', acknowledged_at: null, created_at: now },
    ];
    const prisma = buildPrisma({ users, assignments, alerts });
    const scope = buildSubCoachScope(prisma);
    const alertsSvc = buildScopedAlertsService(alerts);
    const svc = new CommandCenterService(prisma, buildAdminPtm(), alertsSvc, scope);

    // u2 is assigned to the sub-coach -> dismiss succeeds, authorized on
    // (coach_id = head, client_id IN ['u2']).
    const ok = await svc.dismissAlert('a-u2', 'sub');
    expect(ok).toEqual({ ok: true });
    expect(alertsSvc.acknowledgeForScope).toHaveBeenCalledWith('a-u2', 'head', ['u2']);
    expect(alerts.find((a) => a.id === 'a-u2')!.acknowledged_at).not.toBeNull();

    // u1 is NOT assigned to the sub-coach -> still denied (NotFound), no IDOR.
    await expect(svc.dismissAlert('a-u1', 'sub')).rejects.toThrow();
    expect(alerts.find((a) => a.id === 'a-u1')!.acknowledged_at).toBeNull();
  });

  it('head coach can still dismiss any of their own alerts', async () => {
    const { users, assignments, now } = ccscScopedRows();
    const alerts = [
      { id: 'a-u1', coach_id: 'head', client_id: 'u1', acknowledged_at: null, created_at: now },
    ];
    const prisma = buildPrisma({ users, assignments, alerts });
    const scope = buildSubCoachScope(prisma);
    const alertsSvc = buildScopedAlertsService(alerts);
    const svc = new CommandCenterService(prisma, buildAdminPtm(), alertsSvc, scope);

    const ok = await svc.dismissAlert('a-u1', 'head');
    expect(ok).toEqual({ ok: true });
    expect(alertsSvc.acknowledgeForScope).toHaveBeenCalledWith(
      'a-u1',
      'head',
      expect.arrayContaining(['u1', 'u2', 'u3']),
    );
  });
});

describe('CC+SC P1c: sub-coach outgoing message not unread / not coach-turn', () => {
  it('a sub-coach send (sender_id=sub) is coach-side: no unread, not coach turn', async () => {
    const { users, assignments } = ccscScopedRows();
    const t0 = new Date(PINNED_NOW - 2000);
    const t1 = new Date(PINNED_NOW - 1000);
    // Thread for u2 (assigned to sub): client sent first, then the SUB-coach
    // replied (sender_id='sub') under the head coach's coach_id namespace.
    const messages = [
      { id: 'm1', coach_id: 'head', client_id: 'u2', sender_id: 'u2', body: 'client msg', read_at: t1, created_at: t0 },
      { id: 'm2', coach_id: 'head', client_id: 'u2', sender_id: 'sub', body: 'sub reply', read_at: null, created_at: t1 },
    ];
    const prisma = buildPrisma({ users, assignments, messages });
    const scope = buildSubCoachScope(prisma);
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService(), scope);

    const sub = await svc.getInbox('sub', {});
    expect(sub.threads.length).toBe(1);
    const thread = sub.threads[0];
    // The sub-coach's own reply is the latest message -> NOT the coach's
    // turn (the coach already responded) and it must NOT count as unread,
    // even though its read_at is null (a coach-side send is never "unread
    // for the coach").
    expect(thread.is_coach_turn).toBe(false);
    expect(thread.unread_count).toBe(0);
    expect(sub.total_unread).toBe(0);

    // Overview unread for the sub-coach is likewise 0 (the only unread row
    // is the sub-coach's OWN send, which is coach-side).
    const overview = await svc.getOverview('sub');
    expect(overview.unread_messages).toBe(0);
  });

  it('a client send remains unread and flips the thread to coach-turn', async () => {
    const { users, assignments } = ccscScopedRows();
    const t0 = new Date(PINNED_NOW - 2000);
    const t1 = new Date(PINNED_NOW - 1000);
    const messages = [
      { id: 'm1', coach_id: 'head', client_id: 'u2', sender_id: 'sub', body: 'sub msg', read_at: t0, created_at: t0 },
      { id: 'm2', coach_id: 'head', client_id: 'u2', sender_id: 'u2', body: 'client reply', read_at: null, created_at: t1 },
    ];
    const prisma = buildPrisma({ users, assignments, messages });
    const scope = buildSubCoachScope(prisma);
    const svc = new CommandCenterService(prisma, buildAdminPtm(), buildAlertsService(), scope);

    const sub = await svc.getInbox('sub', {});
    expect(sub.threads[0].is_coach_turn).toBe(true);
    expect(sub.threads[0].unread_count).toBe(1);
    expect(sub.total_unread).toBe(1);

    const overview = await svc.getOverview('sub');
    expect(overview.unread_messages).toBe(1);
  });
});
