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

function buildPrisma(fixtures: Fixture[]) {
  const allClients = fixtures.flatMap((f) => f.clients);
  const allPredictions = fixtures.flatMap((f) => f.predictions);
  const allOutcomes = fixtures.flatMap((f) => f.outcomes);
  const allMessages = fixtures.flatMap((f) => f.messages);
  return {
    user: {
      findMany: jest.fn(async ({ where }: any) => {
        return allClients.filter(
          (c) => c.coach_id === where.coach_id && c.role === where.role && c.deleted_at === null,
        );
      }),
      count: jest.fn(async ({ where }: any) => {
        return allClients.filter(
          (c) =>
            c.coach_id === where.coach_id &&
            c.role === where.role &&
            (!where.created_at?.gte || c.created_at >= where.created_at.gte),
        ).length;
      }),
    },
    clientOutcome: {
      count: jest.fn(async ({ where }: any) => {
        return allOutcomes.filter(
          (o) =>
            o.outcome_type === where.outcome_type &&
            (!where.labelled_at?.gte || o.labelled_at >= where.labelled_at.gte) &&
            (!where.user || o.coach_id === where.user.coach_id),
        ).length;
      }),
    },
    ptmPrediction: {
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
    },
    coachMessage: {
      groupBy: jest.fn(async ({ where }: any) => {
        const grouped = new Map<string, number>();
        for (const m of allMessages) {
          if (m.coach_id !== where.coach_id) continue;
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

describe('CoachEffectivenessService', () => {
  it('orders coaches A > B > C by composed score', async () => {
    const fixtures = ['coach-A', 'coach-B', 'coach-C'].map(fixtureFor);
    const prisma = buildPrisma(fixtures);
    const svc = new CoachEffectivenessService(prisma as any);
    const now = new Date('2026-05-06T00:00:00Z');

    const a = await svc.score('coach-A', now);
    const b = await svc.score('coach-B', now);
    const c = await svc.score('coach-C', now);

    expect(a.score).toBeGreaterThan(b.score);
    expect(b.score).toBeGreaterThan(c.score);
  });

  it('persists factors blob with all four components', async () => {
    const fixtures = ['coach-A'].map(fixtureFor);
    const prisma = buildPrisma(fixtures);
    const svc = new CoachEffectivenessService(prisma as any);
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
    const prisma = buildPrisma([]);
    const svc = new CoachEffectivenessService(prisma as any);
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
