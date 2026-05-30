import { CoachEffectivenessService, bucketFor } from '../src/coach/coach-effectiveness.service';

// Phase 6A — coach effectiveness algorithm correctness.
//
// Three synthetic coaches with distinct roster outcomes:
//   * coach-A: high completion, large risk reduction, full retention,
//              healthy engagement → high-performer
//   * coach-B: middling completion + retention, neutral risk delta,
//              moderate engagement → consistent
//   * coach-C: zero completion, no risk reduction, low retention,
//              low engagement → developing
//
// We assert (i) ordering of scores (A > B > C), (ii) that buckets
// snap to the documented thresholds, and (iii) that the factors blob
// records every component.

const DAY_MS = 24 * 60 * 60 * 1000;

interface Client {
  id: string;
  coach_id: string;
  role: 'student';
  deleted_at: null;
  created_at: Date;
  archived_at: Date | null;
}

interface PtmRow {
  user_id: string;
  risk_score: number;
  computed_at: Date;
}

interface OutcomeRow {
  user_id: string;
  outcome_type: 'completed_90day' | 'churned' | 'renewed' | 'dropped_off' | 'milestone_hit' | 'upgraded' | 'referred';
  labelled_at: Date;
  coach_id: string;
}

interface MessageRow {
  coach_id: string;
  client_id: string;
  created_at: Date;
}

interface Fixture {
  clients: Client[];
  predictions: PtmRow[];
  outcomes: OutcomeRow[];
  messages: MessageRow[];
}

function fixtureFor(coachId: string): Fixture {
  const now = new Date('2026-05-06T00:00:00Z');
  if (coachId === 'coach-A') {
    // 5 long-tenured clients (assigned 75 days ago) all retained.
    // 75d sits inside the retention window (last 90d) AND past the
    // 60-day horizon, so they count for both retention and risk-delta.
    const clients: Client[] = Array.from({ length: 5 }).map((_, i) => ({
      id: `A-${i}`,
      coach_id: 'coach-A',
      role: 'student' as const,
      deleted_at: null,
      created_at: new Date(now.getTime() - 75 * DAY_MS),
      archived_at: null,
    }));
    // Each client started at risk=0.7 and ended at risk=0.2 → delta=0.5
    const predictions: PtmRow[] = clients.flatMap((c) => [
      { user_id: c.id, risk_score: 0.7, computed_at: new Date(c.created_at.getTime() + 1 * DAY_MS) },
      { user_id: c.id, risk_score: 0.2, computed_at: new Date(c.created_at.getTime() + 50 * DAY_MS) },
    ]);
    // 4 of 5 enrolled in last 120 days completed 90-day program.
    const outcomes: OutcomeRow[] = clients.slice(0, 4).map((c) => ({
      user_id: c.id,
      outcome_type: 'completed_90day' as const,
      labelled_at: new Date(now.getTime() - 5 * DAY_MS),
      coach_id: 'coach-A',
    }));
    // Healthy engagement: 12 messages each over the last 28 days
    // (~3/week per client; cap is 5/week, so all of it counts).
    const messages: MessageRow[] = clients.flatMap((c) =>
      Array.from({ length: 12 }).map((_, i) => ({
        coach_id: 'coach-A',
        client_id: c.id,
        created_at: new Date(now.getTime() - i * 2 * DAY_MS),
      })),
    );
    return { clients, predictions, outcomes, messages };
  }

  if (coachId === 'coach-B') {
    const clients: Client[] = Array.from({ length: 4 }).map((_, i) => ({
      id: `B-${i}`,
      coach_id: 'coach-B',
      role: 'student' as const,
      deleted_at: null,
      created_at: new Date(now.getTime() - 70 * DAY_MS),
      archived_at: i === 3 ? new Date(now.getTime() - 10 * DAY_MS) : null,
    }));
    // Neutral risk delta: started 0.5, still 0.5
    const predictions: PtmRow[] = clients.flatMap((c) => [
      { user_id: c.id, risk_score: 0.5, computed_at: new Date(c.created_at.getTime() + 1 * DAY_MS) },
      { user_id: c.id, risk_score: 0.5, computed_at: new Date(c.created_at.getTime() + 50 * DAY_MS) },
    ]);
    // 2 of 4 completed
    const outcomes: OutcomeRow[] = clients.slice(0, 2).map((c) => ({
      user_id: c.id,
      outcome_type: 'completed_90day' as const,
      labelled_at: new Date(now.getTime() - 5 * DAY_MS),
      coach_id: 'coach-B',
    }));
    const messages: MessageRow[] = clients.flatMap((c) =>
      Array.from({ length: 4 }).map((_, i) => ({
        coach_id: 'coach-B',
        client_id: c.id,
        created_at: new Date(now.getTime() - i * 2 * DAY_MS),
      })),
    );
    return { clients, predictions, outcomes, messages };
  }

  // coach-C — bottom of the pack.
  const clients: Client[] = Array.from({ length: 3 }).map((_, i) => ({
    id: `C-${i}`,
    coach_id: 'coach-C',
    role: 'student' as const,
    deleted_at: null,
    created_at: new Date(now.getTime() - 80 * DAY_MS),
    archived_at: i === 0 ? new Date(now.getTime() - 30 * DAY_MS) : null,
  }));
  // Risk got WORSE (started 0.3, ended 0.7).
  const predictions: PtmRow[] = clients.flatMap((c) => [
    { user_id: c.id, risk_score: 0.3, computed_at: new Date(c.created_at.getTime() + 1 * DAY_MS) },
    { user_id: c.id, risk_score: 0.7, computed_at: new Date(c.created_at.getTime() + 50 * DAY_MS) },
  ]);
  const outcomes: OutcomeRow[] = []; // no completions
  const messages: MessageRow[] = []; // no messages
  return { clients, predictions, outcomes, messages };
}

// `in` helper supporting both the old `coach_id` filter and the new EFF-3
// `id: { in }` / `client_id: { in }` / `user_id: { in }` filters.
function inList(filter: any): string[] | null {
  if (filter && Array.isArray(filter.in)) return filter.in as string[];
  return null;
}

function buildPrisma(fixtures: Fixture[]) {
  const allClients = fixtures.flatMap((f) => f.clients);
  const allPredictions = fixtures.flatMap((f) => f.predictions);
  const allOutcomes = fixtures.flatMap((f) => f.outcomes);
  const allMessages = fixtures.flatMap((f) => f.messages);
  return {
    user: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids = inList(where.id);
        return allClients.filter((c) => {
          if (ids !== null) {
            if (!ids.includes(c.id)) return false;
          } else if (c.coach_id !== where.coach_id) {
            return false;
          }
          if (where.role && c.role !== where.role) return false;
          if (where.deleted_at === null && c.deleted_at !== null) return false;
          return true;
        });
      }),
      count: jest.fn(async ({ where }: any) => {
        const ids = inList(where.id);
        return allClients.filter((c) => {
          if (ids !== null) {
            if (!ids.includes(c.id)) return false;
          } else if (c.coach_id !== where.coach_id) {
            return false;
          }
          if (where.role && c.role !== where.role) return false;
          if (where.created_at?.gte && c.created_at < where.created_at.gte) return false;
          return true;
        }).length;
      }),
    },
    clientOutcome: {
      count: jest.fn(async ({ where }: any) => {
        const ids = inList(where.user_id);
        return allOutcomes.filter((o) => {
          if (o.outcome_type !== where.outcome_type) return false;
          if (where.labelled_at?.gte && o.labelled_at < where.labelled_at.gte) return false;
          if (ids !== null) {
            if (!ids.includes(o.user_id)) return false;
          } else if (where.user) {
            if (o.coach_id !== where.user.coach_id) return false;
          }
          return true;
        }).length;
      }),
    },
    ptmPrediction: {
      // Kept so the equivalence test can call the OLD findFirst semantics
      // directly against the same fixture data.
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const rows = allPredictions.filter((p) => {
          if (p.user_id !== where.user_id) return false;
          if (where.computed_at?.gte && p.computed_at < where.computed_at.gte) return false;
          if (where.computed_at?.lte && p.computed_at > where.computed_at.lte) return false;
          return true;
        });
        if (rows.length === 0) return null;
        rows.sort((a, b) => {
          const dir = orderBy?.computed_at === 'desc' ? -1 : 1;
          return dir * (a.computed_at.getTime() - b.computed_at.getTime());
        });
        return rows[0];
      }),
      // EFF-1 batched path.
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        const ids = inList(where.user_id);
        let rows = allPredictions.filter((p) => {
          if (ids !== null && !ids.includes(p.user_id)) return false;
          if (where.computed_at?.gte && p.computed_at < where.computed_at.gte) return false;
          if (where.computed_at?.lte && p.computed_at > where.computed_at.lte) return false;
          return true;
        });
        if (orderBy?.computed_at) {
          const dir = orderBy.computed_at === 'desc' ? -1 : 1;
          rows = [...rows].sort(
            (a, b) => dir * (a.computed_at.getTime() - b.computed_at.getTime()),
          );
        }
        return rows.map((p) => ({
          user_id: p.user_id,
          risk_score: p.risk_score,
          computed_at: p.computed_at,
        }));
      }),
    },
    coachMessage: {
      groupBy: jest.fn(async ({ where }: any) => {
        const ids = inList(where.client_id);
        const grouped = new Map<string, number>();
        for (const m of allMessages) {
          if (ids !== null) {
            if (!ids.includes(m.client_id)) continue;
          } else if (m.coach_id !== where.coach_id) {
            continue;
          }
          if (where.created_at?.gte && m.created_at < where.created_at.gte) continue;
          grouped.set(m.client_id, (grouped.get(m.client_id) ?? 0) + 1);
        }
        return Array.from(grouped.entries()).map(([client_id, count]) => ({
          client_id,
          _count: { _all: count },
        }));
      }),
    },
    coachEffectivenessScore: {
      create: jest.fn(async ({ data }: any) => ({
        id: `ces-${data.coach_id}-${Date.now()}`,
        ...data,
        computed_at: new Date('2026-05-06T05:00:00Z'),
      })),
    },
  };
}

// EFF-3: a stub SubCoachScopeService. By default it mirrors the OLD naive
// behaviour (head coach → every client whose coach_id = coachId) so the
// pre-existing assertions stay green. Tests that need sub-coach scoping pass
// an explicit override map.
function buildScope(
  fixtures: Fixture[],
  override?: Record<string, string[]>,
) {
  const allClients = fixtures.flatMap((f) => f.clients);
  return {
    getAuthorizedClientIds: jest.fn(async (coachId: string) => {
      if (override && override[coachId]) return override[coachId];
      return allClients
        .filter((c) => c.coach_id === coachId && c.deleted_at === null)
        .map((c) => c.id);
    }),
    isSubCoach: jest.fn(async () => false),
    getHeadCoachIdForSubCoach: jest.fn(async () => null),
    canAccessClient: jest.fn(async () => true),
  };
}

function makeService(fixtures: Fixture[], override?: Record<string, string[]>) {
  const prisma = buildPrisma(fixtures);
  const scope = buildScope(fixtures, override);
  const svc = new CoachEffectivenessService(prisma as any, scope as any);
  return { prisma, scope, svc };
}

describe('CoachEffectivenessService', () => {
  it('orders coaches A > B > C by composed score', async () => {
    const fixtures = ['coach-A', 'coach-B', 'coach-C'].map(fixtureFor);
    const { svc } = makeService(fixtures);
    const now = new Date('2026-05-06T00:00:00Z');

    const a = await svc.score('coach-A', now);
    const b = await svc.score('coach-B', now);
    const c = await svc.score('coach-C', now);

    expect(a.score).toBeGreaterThan(b.score);
    expect(b.score).toBeGreaterThan(c.score);
  });

  it('persists factors blob with all four components', async () => {
    const fixtures = ['coach-A'].map(fixtureFor);
    const { prisma, svc } = makeService(fixtures);
    const now = new Date('2026-05-06T00:00:00Z');

    await svc.score('coach-A', now);
    const call = prisma.coachEffectivenessScore.create.mock.calls[0][0];
    const factors = call.data.factors as { components: Array<{ key: string }> };
    const keys = factors.components.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining(['completion', 'risk_delta', 'retention', 'engagement']),
    );
  });

  it('returns empty_roster factor when coach has no clients', async () => {
    const { prisma, svc } = makeService([]);
    const out = await svc.score('coach-empty', new Date('2026-05-06T00:00:00Z'));
    expect(out.score).toBe(0);
    expect(out.bucket).toBe('developing');
    const factors = (prisma.coachEffectivenessScore.create.mock.calls[0][0]).data
      .factors as { components: Array<{ key: string }> };
    expect(factors.components[0].key).toBe('empty_roster');
  });

  it('bucketFor snaps to documented thresholds', () => {
    expect(bucketFor(0)).toBe('developing');
    expect(bucketFor(49.9)).toBe('developing');
    expect(bucketFor(50)).toBe('consistent');
    expect(bucketFor(74.9)).toBe('consistent');
    expect(bucketFor(75)).toBe('high-performer');
    expect(bucketFor(100)).toBe('high-performer');
  });
});

// ── EFF-3: sub-coach roster scoping ──────────────────────────────────────
describe('CoachEffectivenessService — EFF-3 sub-coach roster scoping', () => {
  const now = new Date('2026-05-06T00:00:00Z');

  it('scores a sub-coach against their ASSIGNED roster, not coach_id', async () => {
    // coach-A owns 5 clients (A-0..A-4). The sub-coach is assigned only a
    // subset (A-0, A-1) via SubCoachScopeService. The naive coach_id filter
    // would have returned 0 clients for the sub-coach (its coach_id never
    // equals A-0/A-1's coach_id) → empty_roster → score 0.
    const fixtures = ['coach-A'].map(fixtureFor);
    const { svc, scope } = makeService(fixtures, {
      'sub-1': ['A-0', 'A-1'],
    });

    const sub = await svc.score('sub-1', now);

    expect(scope.getAuthorizedClientIds).toHaveBeenCalledWith('sub-1');
    // Non-empty roster → real components, not the empty_roster sentinel.
    const factors = sub.factors as unknown as {
      components: Array<{ key: string; sample_size?: number }>;
    };
    const keys = factors.components.map((f) => f.key);
    expect(keys).not.toContain('empty_roster');
    // risk_delta sample_size reflects the 2 assigned clients only.
    const risk = factors.components.find((f) => f.key === 'risk_delta');
    expect(risk?.sample_size).toBe(2);
    expect(sub.score).toBeGreaterThan(0);
  });

  it('head coach and sub-coach on the same team produce DIFFERENT rosters', async () => {
    const fixtures = ['coach-A'].map(fixtureFor);
    const { svc, scope } = makeService(fixtures, {
      // head sees full roster; sub sees a strict subset.
      'coach-A': ['A-0', 'A-1', 'A-2', 'A-3', 'A-4'],
      'sub-1': ['A-0'],
    });

    const head = await svc.score('coach-A', now);
    const sub = await svc.score('sub-1', now);

    const sampleFor = (s: typeof head, key: string) =>
      (s.factors as unknown as { components: Array<{ key: string; sample_size?: number }> })
        .components.find((f) => f.key === key)?.sample_size;

    expect(sampleFor(head, 'risk_delta')).toBe(5);
    expect(sampleFor(sub, 'risk_delta')).toBe(1);
    expect(scope.getAuthorizedClientIds).toHaveBeenCalledWith('coach-A');
    expect(scope.getAuthorizedClientIds).toHaveBeenCalledWith('sub-1');
  });

  it('sub-coach with no assignments scores empty_roster (0)', async () => {
    const fixtures = ['coach-A'].map(fixtureFor);
    const { svc } = makeService(fixtures, { 'sub-empty': [] });
    const out = await svc.score('sub-empty', now);
    expect(out.score).toBe(0);
    expect(out.bucket).toBe('developing');
  });
});

// ── EFF-1: batched prediction query (N+1 fix) ────────────────────────────
describe('CoachEffectivenessService — EFF-1 batched risk-delta predictions', () => {
  const now = new Date('2026-05-06T00:00:00Z');

  it('issues ONE findMany (not 2N findFirst) for the prediction read', async () => {
    const fixtures = ['coach-A'].map(fixtureFor); // 5 eligible clients
    const { prisma, svc } = makeService(fixtures);

    await svc.score('coach-A', now);

    // Old code: 2 findFirst per eligible client = 10 round-trips.
    // New code: exactly 1 findMany, 0 findFirst in the risk-delta path.
    expect(prisma.ptmPrediction.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.ptmPrediction.findFirst).not.toHaveBeenCalled();
  });

  it('batched result reproduces the prior per-client findFirst choice exactly', async () => {
    const fixtures = ['coach-A', 'coach-B', 'coach-C'].map(fixtureFor);
    const { prisma, svc } = makeService(fixtures);

    // Recompute the EXPECTED per-client deltas using the OLD findFirst
    // semantics against the same fixture data.
    const FIRST_60_DAYS = 60;
    const DAY = 24 * 60 * 60 * 1000;
    const cutoff = new Date(now.getTime() - FIRST_60_DAYS * DAY);
    for (const coachId of ['coach-A', 'coach-B', 'coach-C']) {
      const f = fixtureFor(coachId);
      const eligible = f.clients.filter((c) => c.created_at <= cutoff);
      const expectedDeltas: number[] = [];
      for (const client of eligible) {
        const windowEnd = new Date(client.created_at.getTime() + FIRST_60_DAYS * DAY);
        const earliest = await prisma.ptmPrediction.findFirst({
          where: { user_id: client.id, computed_at: { gte: client.created_at } },
          orderBy: { computed_at: 'asc' },
        });
        const latestInWindow = await prisma.ptmPrediction.findFirst({
          where: { user_id: client.id, computed_at: { gte: client.created_at, lte: windowEnd } },
          orderBy: { computed_at: 'desc' },
        });
        if (!earliest || !latestInWindow) continue;
        expectedDeltas.push(earliest.risk_score - latestInWindow.risk_score);
      }
      const expectedAvg =
        expectedDeltas.reduce((a, d) => a + d, 0) / (expectedDeltas.length || 1);
      const expectedObserved = Math.round(expectedAvg * 1000) / 1000;

      // Now run the batched path and compare the recorded observed value.
      const out = await svc.score(coachId, now);
      const risk = (out.factors as unknown as { components: Array<{ key: string; observed: number; sample_size?: number }> })
        .components.find((c) => c.key === 'risk_delta');
      expect(risk?.sample_size).toBe(expectedDeltas.length);
      expect(risk?.observed).toBeCloseTo(expectedObserved, 6);
    }
  });
});
