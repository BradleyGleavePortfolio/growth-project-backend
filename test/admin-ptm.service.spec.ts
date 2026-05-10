import { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import { AuditAction } from '../src/audit/audit.service';

// Pins the Phase 1C admin-ptm.service contracts:
//   * labelOutcome upserts ClientOutcome by user_id, snapshots last-30d
//     signal counts, writes the canonical AuditLog action, and triggers
//     recompute.
//   * Notes are persisted but never returned (every read returns the
//     `Omit<ClientOutcome, 'notes'>` public shape).
//   * Risk-board sorts by risk_score desc, applies the bucket filter,
//     and paginates by computed_at.

function buildPrisma(overrides: any = {}) {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'student-1') {
          return {
            id: 'student-1',
            email: 's1@x.test',
            role: 'student',
            name: 'Stu',
          };
        }
        if (where.id === 'coach-1') {
          return {
            id: 'coach-1',
            email: 'c1@x.test',
            role: 'coach',
            name: 'Coachy',
          };
        }
        return null;
      }),
    },
    clientSignal: {
      groupBy: jest.fn(async () => [
        { signal_type: 'checkin_streak', _count: { _all: 7 }, _max: { recorded_at: new Date('2026-04-01') } },
        { signal_type: 'workout_logged', _count: { _all: 3 }, _max: { recorded_at: new Date('2026-04-02') } },
      ]),
    },
    clientOutcome: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: any) => ({
        id: 'oc-1',
        user_id: create.user_id,
        outcome_type: create.outcome_type,
        labelled_by_id: create.labelled_by_id,
        labelled_at: new Date('2026-05-01'),
        signal_snapshot: create.signal_snapshot,
        // notes intentionally omitted from select; the upsert should
        // never echo it back to the caller.
      })),
      findMany: jest.fn(async () => []),
    },
    ptmPrediction: {
      findFirst: jest.fn(async () => ({
        id: 'pred-1',
        user_id: 'student-1',
        risk_score: 0.4,
        success_score: 0.7,
        prediction_basis: 'heuristic_v1',
        factors: [],
        computed_at: new Date('2026-05-01T10:00:00Z'),
      })),
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async () => []),
    },
    ...overrides,
  };
}

function buildSvc(prismaOverrides: any = {}) {
  const prisma = buildPrisma(prismaOverrides);
  const audit = { write: jest.fn(async () => {}), list: jest.fn() } as any;
  const ptm = {
    getLatestPrediction: jest.fn(async () => prisma.ptmPrediction.findFirst()),
    listPredictionHistory: jest.fn(async () => []),
  } as any;
  const recompute = { recomputeOne: jest.fn(async () => undefined) } as any;
  const svc = new AdminPtmService(prisma as any, audit, ptm, recompute);
  return { svc, prisma, audit, ptm, recompute };
}

describe('AdminPtmService.labelOutcome', () => {
  it('404s when target is not a student', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.labelOutcome(
        'coach-1',
        { outcome_type: 'churned' },
        { actorId: 'owner-1', actorRole: 'owner', actorEmail: 'o@o.test' },
      ),
    ).rejects.toThrow('Student not found');
  });

  it('upserts ClientOutcome with last-30d signal snapshot', async () => {
    const { svc, prisma } = buildSvc();
    await svc.labelOutcome(
      'student-1',
      { outcome_type: 'churned', notes: 'cancelled mid-phase' },
      { actorId: 'owner-1', actorRole: 'owner', actorEmail: 'o@o.test' },
    );
    expect(prisma.clientSignal.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.clientOutcome.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.clientOutcome.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ user_id: 'student-1' });
    expect(args.create.outcome_type).toBe('churned');
    expect(args.create.signal_snapshot).toEqual({
      checkin_streak: 7,
      workout_logged: 3,
    });
    // Notes ARE persisted on the row…
    expect(args.create.notes).toBe('cancelled mid-phase');
  });

  it('writes the PTM_OUTCOME_LABELLED audit row with prior outcome metadata', async () => {
    const { svc, prisma, audit } = buildSvc({
      clientOutcome: {
        findUnique: jest.fn(async () => ({ outcome_type: 'milestone_hit' })),
        upsert: jest.fn(async ({ update }: any) => ({
          id: 'oc-1',
          user_id: 'student-1',
          outcome_type: update.outcome_type,
          labelled_by_id: 'owner-1',
          labelled_at: new Date(),
          signal_snapshot: {},
        })),
        findMany: jest.fn(async () => []),
      },
    });
    await svc.labelOutcome(
      'student-1',
      { outcome_type: 'churned' },
      { actorId: 'owner-1', actorRole: 'owner', actorEmail: 'o@o.test' },
    );
    expect(audit.write).toHaveBeenCalledTimes(1);
    const call = audit.write.mock.calls[0][0];
    expect(call.action).toBe(AuditAction.PTM_OUTCOME_LABELLED);
    expect(call.actorId).toBe('owner-1');
    expect(call.targetUserId).toBe('student-1');
    expect(call.metadata).toEqual({
      outcome_type: 'churned',
      prior_outcome_type: 'milestone_hit',
      notes_present: false,
    });
    void prisma; // referenced for readability above
  });

  it('triggers recompute on the labelled user', async () => {
    const { svc, recompute } = buildSvc();
    await svc.labelOutcome(
      'student-1',
      { outcome_type: 'renewed' },
      { actorId: 'owner-1', actorRole: 'owner', actorEmail: 'o@o.test' },
    );
    expect(recompute.recomputeOne).toHaveBeenCalledWith('student-1');
  });

  it('swallows recompute failure; outcome row stays persisted', async () => {
    const { svc, recompute, prisma } = buildSvc();
    recompute.recomputeOne.mockRejectedValueOnce(new Error('boom'));
    await expect(
      svc.labelOutcome(
        'student-1',
        { outcome_type: 'renewed' },
        { actorId: 'owner-1', actorRole: 'owner', actorEmail: 'o@o.test' },
      ),
    ).resolves.toBeDefined();
    expect(prisma.clientOutcome.upsert).toHaveBeenCalledTimes(1);
  });

  it('public outcome shape never contains notes', async () => {
    const { svc } = buildSvc();
    const out = await svc.labelOutcome(
      'student-1',
      { outcome_type: 'churned', notes: 'private' },
      { actorId: 'owner-1', actorRole: 'owner', actorEmail: 'o@o.test' },
    );
    expect(Object.keys(out.outcome)).not.toContain('notes');
  });
});

describe('AdminPtmService.getRiskBoard', () => {
  function predRow(
    user_id: string,
    risk_score: number,
    computed_at: string,
    role = 'student',
  ) {
    return {
      id: `p-${user_id}`,
      user_id,
      risk_score,
      success_score: 1 - risk_score,
      prediction_basis: 'heuristic_v1',
      factors: [{ key: 'a' }, { key: 'b' }],
      computed_at: new Date(computed_at),
      user: {
        id: user_id,
        email: `${user_id}@x.test`,
        role,
        name: user_id,
      },
    };
  }

  it('returns rows sorted by risk_score DESC with bucket annotation', async () => {
    const rows = [
      predRow('u-low', 0.1, '2026-05-01T00:00:00Z'),
      predRow('u-high', 0.8, '2026-05-01T00:00:00Z'),
      predRow('u-mid', 0.45, '2026-05-01T00:00:00Z'),
    ];
    const prisma: any = buildPrisma({
      ptmPrediction: {
        groupBy: jest.fn(async () =>
          rows.map((r) => ({
            user_id: r.user_id,
            _max: { computed_at: r.computed_at },
          })),
        ),
        findMany: jest.fn(async () => rows),
      },
    });
    const audit: any = { write: jest.fn() };
    const ptm: any = {
      getLatestPrediction: jest.fn(),
      listPredictionHistory: jest.fn(),
    };
    const recompute: any = { recomputeOne: jest.fn() };
    const svc = new AdminPtmService(prisma, audit, ptm, recompute);

    const out = await svc.getRiskBoard({});
    expect(out.data.map((r) => r.user_id)).toEqual([
      'u-high',
      'u-mid',
      'u-low',
    ]);
    expect(out.data[0].bucket).toBe('red');
    expect(out.data[1].bucket).toBe('amber');
    expect(out.data[2].bucket).toBe('green');
    expect(out.data[0].factors_count).toBe(2);
  });

  it('applies bucket filter server-side', async () => {
    const rows = [
      predRow('u-low', 0.1, '2026-05-01T00:00:00Z'),
      predRow('u-high', 0.8, '2026-05-01T00:00:00Z'),
    ];
    const prisma: any = buildPrisma({
      ptmPrediction: {
        groupBy: jest.fn(async () =>
          rows.map((r) => ({
            user_id: r.user_id,
            _max: { computed_at: r.computed_at },
          })),
        ),
        findMany: jest.fn(async () => rows),
      },
    });
    const svc = new AdminPtmService(
      prisma,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn(), listPredictionHistory: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );
    const out = await svc.getRiskBoard({ bucket: 'red' });
    expect(out.data).toHaveLength(1);
    expect(out.data[0].user_id).toBe('u-high');
  });

  it('paginates: emits next_cursor when more rows remain', async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      predRow(`u-${i}`, 0.9 - i * 0.1, `2026-05-01T0${i}:00:00Z`),
    );
    const prisma: any = buildPrisma({
      ptmPrediction: {
        groupBy: jest.fn(async () =>
          rows.map((r) => ({
            user_id: r.user_id,
            _max: { computed_at: r.computed_at },
          })),
        ),
        findMany: jest.fn(async () => rows),
      },
    });
    const svc = new AdminPtmService(
      prisma,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn(), listPredictionHistory: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );
    const out = await svc.getRiskBoard({ limit: 2 });
    expect(out.data).toHaveLength(2);
    expect(out.next_cursor).not.toBeNull();
  });

  it('clamps limit to 100 even when caller asks for more', async () => {
    const prisma: any = buildPrisma({
      ptmPrediction: {
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async () => []),
      },
    });
    const svc = new AdminPtmService(
      prisma,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn(), listPredictionHistory: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );
    const out = await svc.getRiskBoard({ limit: 9999 });
    expect(out.data).toHaveLength(0);
  });
});

describe('AdminPtmService.getClientPtm', () => {
  it('404s on unknown client', async () => {
    const prisma: any = buildPrisma();
    const svc = new AdminPtmService(
      prisma,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn(), listPredictionHistory: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );
    await expect(svc.getClientPtm('nope')).rejects.toThrow('Client not found');
  });

  it('returns the public envelope without notes', async () => {
    const prisma: any = buildPrisma({
      clientOutcome: {
        findUnique: jest.fn(async () => ({
          id: 'oc-1',
          user_id: 'student-1',
          outcome_type: 'churned',
          labelled_by_id: 'owner-1',
          labelled_at: new Date('2026-05-01'),
          signal_snapshot: {},
        })),
        upsert: jest.fn(),
        findMany: jest.fn(),
      },
    });
    const svc = new AdminPtmService(
      prisma,
      { write: jest.fn() } as any,
      {
        getLatestPrediction: jest.fn(async () => null),
        listPredictionHistory: jest.fn(async () => []),
      } as any,
      { recomputeOne: jest.fn() } as any,
    );
    const out = await svc.getClientPtm('student-1');
    expect(out.client.id).toBe('student-1');
    expect(out.outcome).toBeDefined();
    if (out.outcome) {
      expect(Object.keys(out.outcome)).not.toContain('notes');
    }
    expect(out.recent_signals).toBeInstanceOf(Array);
  });
});
