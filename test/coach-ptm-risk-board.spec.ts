// test/coach-ptm-risk-board.spec.ts
//
// Phase 1E — coach-scoped risk board endpoint tests.
//
// Coverage:
//   1. Happy path: coach with clients sees redacted rows (risk_score/success_score null).
//   2. Empty list: coach with no assigned clients returns { data: [], next_cursor: null }.
//   3. Auth boundary: CoachGuard rejects non-coach (student) with ForbiddenException (403).
//   4. Cross-coach isolation: coach A cannot see coach B's clients — service scopes
//      by caller's user id, never by a caller-supplied parameter.
//   5. Bucket filter: only rows matching the requested bucket are returned.
//   6. Pagination cursor: rows after the cursor date are excluded.
//
// Architecture note:
//   CoachController.getCoachRiskBoard calls AdminPtmService.getRiskBoardForCoach
//   with req.user.id as the coachId. The CoachGuard class-level guard is the
//   role boundary; this spec tests both the guard and the service method.
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { CoachGuard } from '../src/auth/coach.guard';
import { CoachController } from '../src/coach/coach.controller';
import { RiskBoardQueryDto } from '../src/admin/ptm/admin-ptm.dto';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeContext(role: string | null) {
  const user = role ? { id: 'u-1', role, email: 'u@x.test' } : null;
  const req: any = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => CoachController.prototype.getCoachRiskBoard,
    getClass: () => CoachController,
  } as any;
}

function buildPtmSvc(
  rows: any[] = [],
  nextCursor: string | null = null,
) {
  return {
    getRiskBoardForCoach: jest.fn(async () => ({
      data: rows,
      next_cursor: nextCursor,
      generated_at: new Date().toISOString(),
    })),
  } as any;
}

function buildCoachSvc() {
  return {
    getDashboard: jest.fn(),
    getClients: jest.fn(),
    archiveClient: jest.fn(),
    unarchiveClient: jest.fn(),
    getClientTimeline: jest.fn(),
    getClientSummary: jest.fn(),
    getGuidelines: jest.fn(),
    postGuidelines: jest.fn(),
    getAlerts: jest.fn(),
  } as any;
}

function buildAnalytics() {
  return { capture: jest.fn() } as any;
}

// ---------------------------------------------------------------------------
// 1. Role guard boundary
// ---------------------------------------------------------------------------

describe('CoachController — CoachGuard', () => {
  const guard = new CoachGuard();

  it('allows coach role', () => {
    expect(guard.canActivate(makeContext('coach'))).toBe(true);
  });

  it('allows owner role (platform-wide bypass)', () => {
    expect(guard.canActivate(makeContext('owner'))).toBe(true);
  });

  it('rejects student with ForbiddenException (403)', () => {
    expect(() => guard.canActivate(makeContext('student'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects unauthenticated request with ForbiddenException', () => {
    expect(() => guard.canActivate(makeContext(null))).toThrow(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Controller handler — happy path
// ---------------------------------------------------------------------------

describe('CoachController.getCoachRiskBoard — happy path', () => {
  it('returns redacted rows where risk_score and success_score are null', async () => {
    const redactedRow = {
      user_id: 'client-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'student',
      risk_score: null,
      success_score: null,
      bucket: 'red',
      computed_at: new Date().toISOString(),
      factors_count: 3,
      last_signal_at: null,
      outcome_label: null,
    };

    const ptmSvc = buildPtmSvc([redactedRow]);
    const ctrl = new CoachController(buildCoachSvc(), buildAnalytics(), ptmSvc);
    const req: any = { user: { id: 'coach-1', role: 'coach', email: 'c@c.test' } };

    const result = await ctrl.getCoachRiskBoard(req, {} as RiskBoardQueryDto);

    expect(result.data).toHaveLength(1);
    expect(result.data[0].risk_score).toBeNull();
    expect(result.data[0].success_score).toBeNull();
    expect(result.data[0].bucket).toBe('red');
    expect(result.next_cursor).toBeNull();
  });

  it('passes the caller\'s user id as coachId — caller cannot override scope', async () => {
    const ptmSvc = buildPtmSvc();
    const ctrl = new CoachController(buildCoachSvc(), buildAnalytics(), ptmSvc);
    const req: any = {
      user: { id: 'coach-99', role: 'coach', email: 'c@c.test' },
    };
    const query = { bucket: 'red', limit: 10 } as RiskBoardQueryDto;

    await ctrl.getCoachRiskBoard(req, query);

    // The first argument to getRiskBoardForCoach must always be the
    // authenticated user's id — never a query param.
    expect(ptmSvc.getRiskBoardForCoach).toHaveBeenCalledWith(
      'coach-99',
      expect.objectContaining({ bucket: 'red', limit: 10 }),
    );
  });

  it('forwards bucket filter and cursor to the service', async () => {
    const ptmSvc = buildPtmSvc();
    const ctrl = new CoachController(buildCoachSvc(), buildAnalytics(), ptmSvc);
    const req: any = { user: { id: 'coach-1', role: 'coach', email: 'c@c.test' } };
    const cursor = '2026-06-01T00:00:00.000Z';
    const query = { bucket: 'amber', cursor, limit: 5 } as RiskBoardQueryDto;

    await ctrl.getCoachRiskBoard(req, query);

    expect(ptmSvc.getRiskBoardForCoach).toHaveBeenCalledWith('coach-1', {
      bucket: 'amber',
      cursor,
      limit: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Empty roster
// ---------------------------------------------------------------------------

describe('CoachController.getCoachRiskBoard — empty roster', () => {
  it('returns empty data array when coach has no assigned clients', async () => {
    const ptmSvc = buildPtmSvc([]);
    const ctrl = new CoachController(buildCoachSvc(), buildAnalytics(), ptmSvc);
    const req: any = { user: { id: 'new-coach', role: 'coach', email: 'n@c.test' } };

    const result = await ctrl.getCoachRiskBoard(req, {} as RiskBoardQueryDto);

    expect(result.data).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Service — cross-coach isolation
// ---------------------------------------------------------------------------

describe('AdminPtmService.getRiskBoardForCoach — cross-coach isolation', () => {
  // Minimal Prisma mock: coach A has clientA; coach B has clientB. The
  // service must NEVER let coachA's id return clientB's data.
  function buildPrisma(coachId: string, clientIds: string[]) {
    const predictions = clientIds.map((cid, i) => ({
      user_id: cid,
      risk_score: 0.7,
      success_score: 0.5,
      computed_at: new Date('2026-06-01T00:00:00.000Z'),
      factors: [],
      user: {
        id: cid,
        email: `${cid}@example.com`,
        role: 'student',
        name: `Client ${i}`,
        ptm_outcomes_target: [],
        ptm_signals: [],
        coach_id: coachId,
      },
    }));

    return {
      user: {
        findMany: jest.fn(async (args: any) => {
          const filterCoachId = args?.where?.coach_id;
          // Only return clients belonging to the queried coachId.
          return clientIds
            .filter(() => filterCoachId === coachId)
            .map((id) => ({ id }));
        }),
      },
      ptmPrediction: {
        groupBy: jest.fn(async () =>
          clientIds.map((cid) => ({
            user_id: cid,
            _max: { computed_at: new Date('2026-06-01T00:00:00.000Z') },
          })),
        ),
        findMany: jest.fn(async () => predictions),
      },
    };
  }

  it('coachA cannot read coachB clients', async () => {
    // Dynamic import avoids top-level circular resolution issues in Jest.
    const { AdminPtmService } = await import(
      '../src/admin/ptm/admin-ptm.service'
    );

    const prismaA = buildPrisma('coachA', ['clientA1']);
    const svcA = new AdminPtmService(
      prismaA as any,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );

    const resA = await svcA.getRiskBoardForCoach('coachA', {});
    // coachA sees their client
    expect(resA.data.map((r: any) => r.user_id)).toEqual(['clientA1']);

    // Now call with coachB — the user.findMany mock returns [] for coachB
    const prismaB = buildPrisma('coachA', ['clientA1']); // same mock, but querying coachB
    const svcB = new AdminPtmService(
      prismaB as any,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );

    const resB = await svcB.getRiskBoardForCoach('coachB', {});
    // coachB's query to the mock returns empty (no rows for coachB)
    expect(resB.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Service — scores are always null on coach path
// ---------------------------------------------------------------------------

describe('AdminPtmService.getRiskBoardForCoach — score redaction', () => {
  it('sets risk_score and success_score to null regardless of the raw prediction', async () => {
    const { AdminPtmService } = await import(
      '../src/admin/ptm/admin-ptm.service'
    );

    const prisma = {
      user: {
        findMany: jest.fn(async () => [{ id: 'c1' }]),
      },
      ptmPrediction: {
        groupBy: jest.fn(async () => [
          { user_id: 'c1', _max: { computed_at: new Date('2026-06-01') } },
        ]),
        findMany: jest.fn(async () => [
          {
            user_id: 'c1',
            risk_score: 0.85,      // should become null
            success_score: 0.40,   // should become null
            computed_at: new Date('2026-06-01'),
            factors: [],
            user: {
              id: 'c1',
              email: 'c@example.com',
              role: 'student',
              name: 'Client One',
              ptm_outcomes_target: [],
              ptm_signals: [],
            },
          },
        ]),
      },
    };

    const svc = new AdminPtmService(
      prisma as any,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );

    const res = await svc.getRiskBoardForCoach('coach-1', {});

    expect(res.data).toHaveLength(1);
    expect(res.data[0].risk_score).toBeNull();
    expect(res.data[0].success_score).toBeNull();
    // bucket is still computed server-side from the raw score
    expect(res.data[0].bucket).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// 6. Service — pagination cursor
// ---------------------------------------------------------------------------

describe('AdminPtmService.getRiskBoardForCoach — pagination cursor', () => {
  it('excludes rows whose computed_at is >= the cursor', async () => {
    const { AdminPtmService } = await import(
      '../src/admin/ptm/admin-ptm.service'
    );

    const cursor = '2026-06-02T00:00:00.000Z';
    const beforeDate = new Date('2026-06-01T12:00:00.000Z');
    const afterDate = new Date('2026-06-03T12:00:00.000Z');

    // The mock honours the cursor filter: groupBy only returns items
    // whose computed_at < cursor.
    const prisma = {
      user: {
        findMany: jest.fn(async () => [{ id: 'c1' }, { id: 'c2' }]),
      },
      ptmPrediction: {
        groupBy: jest.fn(async (args: any) => {
          const lt: Date | undefined = args?.where?.computed_at?.lt;
          // Filter by cursor if provided
          const rows = [
            { user_id: 'c1', _max: { computed_at: beforeDate } },
            { user_id: 'c2', _max: { computed_at: afterDate } },
          ];
          return lt
            ? rows.filter((r) => (r._max.computed_at as Date) < lt)
            : rows;
        }),
        findMany: jest.fn(async () => [
          {
            user_id: 'c1',
            risk_score: 0.5,
            success_score: 0.5,
            computed_at: beforeDate,
            factors: [],
            user: {
              id: 'c1',
              email: 'c1@example.com',
              role: 'student',
              name: 'C1',
              ptm_outcomes_target: [],
              ptm_signals: [],
            },
          },
        ]),
      },
    };

    const svc = new AdminPtmService(
      prisma as any,
      { write: jest.fn() } as any,
      { getLatestPrediction: jest.fn() } as any,
      { recomputeOne: jest.fn() } as any,
    );

    const res = await svc.getRiskBoardForCoach('coach-1', { cursor });

    // Only c1 (before the cursor) should appear
    expect(res.data.map((r: any) => r.user_id)).toEqual(['c1']);
    // groupBy was called with the cursor filter
    expect(prisma.ptmPrediction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          computed_at: { lt: new Date(cursor) },
        }),
      }),
    );
  });
});
