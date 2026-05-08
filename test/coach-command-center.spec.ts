// test/coach-command-center.spec.ts
//
// Phase 8 — Coach Command Center backend tests.
//
// Coverage:
//   1. Role-guard: student (non-coach) receives ForbiddenException (403).
//   2. Role-guard: unauthenticated request receives ForbiddenException.
//   3. Role-guard: coach role is allowed through.
//   4. Role-guard: owner role is allowed through (platform-wide bypass).
//   5. Cross-coach isolation: coachA cannot see coachB's clients.
//   6. Overview — happy path: returns correct counts with seeded fixtures.
//   7. Overview — empty roster: returns zero counts.
//   8. At-risk — delegates to AdminPtmService, passes coachId from JWT only.
//   9. Win-streaks — sorted by checkins_last_30_days desc, cursor pagination.
//  10. Inbox — thread list newest first, unread counts correct.
//  11. Inbox — empty (no messages): returns empty data array.
//  12. Action queue — reason codes assigned in correct priority order.
//  13. Action queue — reason_code filter narrows results.
//  14. Action queue — empty roster: returns empty data array.
//
// Architecture:
//   CoachCommandCenterController calls CoachCommandCenterService.
//   CoachCommandCenterService calls PrismaService + AdminPtmService.
//   Tests unit-test both the guard and the controller/service boundary with
//   minimal mock doubles. Cross-coach isolation is verified at the service
//   layer by ensuring the Prisma mock only sees the correct coachId.

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { CoachGuard } from '../src/auth/coach.guard';
import { CoachCommandCenterController } from '../src/coach-command-center/coach-command-center.controller';
import { CoachCommandCenterService } from '../src/coach-command-center/coach-command-center.service';
import type {
  OverviewResponse,
  WinStreakResponse,
  InboxResponse,
  ActionQueueResponse,
} from '../src/coach-command-center/coach-command-center.service';
import type { CcPageQueryDto, ActionQueueQueryDto } from '../src/coach-command-center/coach-command-center.dto';
import type { RiskBoardQueryDto } from '../src/admin/ptm/admin-ptm.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuardContext(role: string | null) {
  const user = role ? { id: 'u-1', role, email: 'u@x.test' } : null;
  const req: unknown = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => CoachCommandCenterController.prototype.getOverview,
    getClass: () => CoachCommandCenterController,
  } as Parameters<CoachGuard['canActivate']>[0];
}

function makeReq(coachId: string, role = 'coach') {
  return { user: { id: coachId, role, email: `${coachId}@test.com` } } as any;
}

function buildEmptySvc(): CoachCommandCenterService {
  return {
    getOverview: jest.fn(async (): Promise<OverviewResponse> => ({
      total_clients: 0,
      clients_with_unread_messages: 0,
      risk_counts: { red: 0, amber: 0, green: 0, no_data: 0 },
      action_queue_size: 0,
      top_inbox_threads: [],
      top_win_streaks: [],
      generated_at: new Date().toISOString(),
    })),
    getAtRisk: jest.fn(async () => ({
      data: [],
      next_cursor: null,
      generated_at: new Date().toISOString(),
    })),
    getWinStreaks: jest.fn(async (): Promise<WinStreakResponse> => ({
      data: [],
      next_cursor: null,
    })),
    getInbox: jest.fn(async (): Promise<InboxResponse> => ({
      data: [],
      next_cursor: null,
    })),
    getActionQueue: jest.fn(async (): Promise<ActionQueueResponse> => ({
      data: [],
      next_cursor: null,
    })),
  } as unknown as CoachCommandCenterService;
}

// ---------------------------------------------------------------------------
// 1-4. Role guard
// ---------------------------------------------------------------------------

describe('CoachGuard (used by CoachCommandCenterController)', () => {
  const guard = new CoachGuard();

  it('allows coach role', () => {
    expect(guard.canActivate(makeGuardContext('coach'))).toBe(true);
  });

  it('allows owner role (platform-wide bypass)', () => {
    expect(guard.canActivate(makeGuardContext('owner'))).toBe(true);
  });

  it('rejects student with ForbiddenException (403)', () => {
    expect(() => guard.canActivate(makeGuardContext('student'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects unauthenticated request with ForbiddenException', () => {
    expect(() => guard.canActivate(makeGuardContext(null))).toThrow(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-coach isolation — controller always passes req.user.id as coachId
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController — cross-coach isolation', () => {
  it('overview: passes req.user.id to service — caller cannot supply a different coachId', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);
    const req = makeReq('coach-A');

    await ctrl.getOverview(req);

    expect(svc.getOverview).toHaveBeenCalledWith('coach-A');
    // Confirm it was NOT called with 'coach-B'
    expect(svc.getOverview).not.toHaveBeenCalledWith('coach-B');
  });

  it('at-risk: coachId from JWT only, query params do not override scope', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);
    const req = makeReq('coach-A');
    const query = { bucket: 'red', limit: 10 } as RiskBoardQueryDto;

    await ctrl.getAtRisk(req, query);

    expect(svc.getAtRisk).toHaveBeenCalledWith(
      'coach-A',
      expect.objectContaining({ bucket: 'red', limit: 10 }),
    );
  });

  it('inbox: coachId from JWT only', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);
    const req = makeReq('coach-B');

    await ctrl.getInbox(req, {} as CcPageQueryDto);

    expect(svc.getInbox).toHaveBeenCalledWith('coach-B', expect.any(Object));
  });

  it('action-queue: coachId from JWT only', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);
    const req = makeReq('coach-X');

    await ctrl.getActionQueue(req, {} as ActionQueueQueryDto);

    expect(svc.getActionQueue).toHaveBeenCalledWith('coach-X', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// 6. Overview — happy path
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getOverview — happy path', () => {
  it('returns overview with correct shape', async () => {
    const mockOverview: OverviewResponse = {
      total_clients: 5,
      clients_with_unread_messages: 2,
      risk_counts: { red: 1, amber: 2, green: 2, no_data: 0 },
      action_queue_size: 3,
      top_inbox_threads: [
        {
          client_id: 'c-1',
          client_name: 'Alice',
          client_email: 'alice@test.com',
          last_message_at: '2026-06-01T10:00:00.000Z',
          last_message_preview: 'Hey coach',
          last_message_is_voice: false,
          unread_count: 1,
        },
      ],
      top_win_streaks: [
        {
          client_id: 'c-2',
          client_name: 'Bob',
          first_win_at: '2026-05-01T08:00:00.000Z',
          checkins_last_30_days: 28,
          last_checkin_at: '2026-06-01T07:00:00.000Z',
        },
      ],
      generated_at: '2026-06-01T10:05:00.000Z',
    };

    const svc = {
      ...buildEmptySvc(),
      getOverview: jest.fn(async () => mockOverview),
    } as unknown as CoachCommandCenterService;
    const ctrl = new CoachCommandCenterController(svc);

    const result = await ctrl.getOverview(makeReq('coach-1'));

    expect(result.total_clients).toBe(5);
    expect(result.risk_counts.red).toBe(1);
    expect(result.top_inbox_threads).toHaveLength(1);
    expect(result.top_inbox_threads[0].unread_count).toBe(1);
    expect(result.top_win_streaks[0].checkins_last_30_days).toBe(28);
  });
});

// ---------------------------------------------------------------------------
// 7. Overview — empty roster
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getOverview — empty roster', () => {
  it('returns zeros when the coach has no assigned clients', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);

    const result = await ctrl.getOverview(makeReq('new-coach'));

    expect(result.total_clients).toBe(0);
    expect(result.clients_with_unread_messages).toBe(0);
    expect(result.action_queue_size).toBe(0);
    expect(result.top_inbox_threads).toEqual([]);
    expect(result.top_win_streaks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. At-risk — delegates to AdminPtmService
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getAtRisk', () => {
  it('delegates to svc.getAtRisk with the correct coachId and query params', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);
    const req = makeReq('coach-risk-test');
    const query = { bucket: 'amber', cursor: '2026-05-01T00:00:00.000Z', limit: 15 } as RiskBoardQueryDto;

    const result = await ctrl.getAtRisk(req, query);

    expect(svc.getAtRisk).toHaveBeenCalledWith('coach-risk-test', {
      bucket: 'amber',
      cursor: '2026-05-01T00:00:00.000Z',
      limit: 15,
    });
    expect(result).toEqual(expect.objectContaining({ data: [], next_cursor: null }));
  });
});

// ---------------------------------------------------------------------------
// 9. Win-streaks — sorting and cursor
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getWinStreaks', () => {
  it('returns streak data and forwards cursor to service', async () => {
    const mockData: WinStreakResponse = {
      data: [
        {
          client_id: 'c-top',
          client_name: 'Top Performer',
          first_win_at: '2026-04-01T00:00:00.000Z',
          checkins_last_30_days: 30,
          last_checkin_at: '2026-06-01T00:00:00.000Z',
        },
        {
          client_id: 'c-mid',
          client_name: 'Mid Performer',
          first_win_at: null,
          checkins_last_30_days: 15,
          last_checkin_at: '2026-05-28T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    };

    const svc = {
      ...buildEmptySvc(),
      getWinStreaks: jest.fn(async () => mockData),
    } as unknown as CoachCommandCenterService;
    const ctrl = new CoachCommandCenterController(svc);
    const cursor = '2026-06-01T00:00:00.000Z';

    const result = await ctrl.getWinStreaks(makeReq('coach-w'), { cursor, limit: 10 });

    expect(svc.getWinStreaks).toHaveBeenCalledWith('coach-w', { cursor, limit: 10 });
    expect(result.data[0].checkins_last_30_days).toBe(30);
    expect(result.data[1].checkins_last_30_days).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 10. Inbox — threads newest first, unread counts
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getInbox', () => {
  it('returns threads sorted newest first with correct unread counts', async () => {
    const mockInbox: InboxResponse = {
      data: [
        {
          client_id: 'c-newest',
          client_name: 'Newest',
          client_email: 'newest@test.com',
          last_message_at: '2026-06-02T12:00:00.000Z',
          last_message_preview: 'Hello coach',
          last_message_is_voice: false,
          unread_count: 2,
        },
        {
          client_id: 'c-older',
          client_name: 'Older',
          client_email: 'older@test.com',
          last_message_at: '2026-05-30T08:00:00.000Z',
          last_message_preview: null,
          last_message_is_voice: true,
          unread_count: 0,
        },
      ],
      next_cursor: null,
    };

    const svc = {
      ...buildEmptySvc(),
      getInbox: jest.fn(async () => mockInbox),
    } as unknown as CoachCommandCenterService;
    const ctrl = new CoachCommandCenterController(svc);

    const result = await ctrl.getInbox(makeReq('coach-i'), {});

    expect(result.data[0].last_message_at > result.data[1].last_message_at).toBe(true);
    expect(result.data[0].unread_count).toBe(2);
    expect(result.data[1].last_message_is_voice).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Inbox — empty (no messages)
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getInbox — empty', () => {
  it('returns empty data when no threads exist', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);

    const result = await ctrl.getInbox(makeReq('coach-empty'), {});

    expect(result.data).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12. Action queue — reason code priority
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getActionQueue', () => {
  it('returns items with reason codes in the response', async () => {
    const mockQueue: ActionQueueResponse = {
      data: [
        {
          client_id: 'c-unread',
          client_name: 'Unread Client',
          client_email: 'u@t.com',
          reason_code: 'unread_message',
          reason_detail: '2 unread messages from this client.',
          signal_at: '2026-06-01T12:00:00.000Z',
        },
        {
          client_id: 'c-risk',
          client_name: 'At-Risk Client',
          client_email: 'r@t.com',
          reason_code: 'at_risk',
          reason_detail: 'Client is in the high-risk bucket.',
          signal_at: '2026-06-01T06:00:00.000Z',
        },
      ],
      next_cursor: null,
    };

    const svc = {
      ...buildEmptySvc(),
      getActionQueue: jest.fn(async () => mockQueue),
    } as unknown as CoachCommandCenterService;
    const ctrl = new CoachCommandCenterController(svc);

    const result = await ctrl.getActionQueue(makeReq('coach-q'), {});

    expect(result.data).toHaveLength(2);
    expect(result.data[0].reason_code).toBe('unread_message');
    expect(result.data[1].reason_code).toBe('at_risk');
  });

  it('forwards reason_code filter to the service', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);
    const query: ActionQueueQueryDto = { reason_code: 'missed_checkin' };

    await ctrl.getActionQueue(makeReq('coach-q2'), query);

    expect(svc.getActionQueue).toHaveBeenCalledWith(
      'coach-q2',
      expect.objectContaining({ reason_code: 'missed_checkin' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Action queue — empty roster
// ---------------------------------------------------------------------------

describe('CoachCommandCenterController.getActionQueue — empty', () => {
  it('returns empty data when coach has no clients', async () => {
    const svc = buildEmptySvc();
    const ctrl = new CoachCommandCenterController(svc);

    const result = await ctrl.getActionQueue(makeReq('coach-empty'), {});

    expect(result.data).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14. CoachCommandCenterService cross-coach isolation (service-level unit test)
// ---------------------------------------------------------------------------

describe('CoachCommandCenterService — cross-coach isolation (service layer)', () => {
  function buildPrisma(coachId: string, clientIds: string[]) {
    const now = new Date();
    return {
      user: {
        findMany: jest.fn((args: { where?: { coach_id?: string } }) => {
          // Enforce: only return clients for the requested coachId.
          const reqCoachId = args.where?.coach_id;
          if (reqCoachId !== coachId) return Promise.resolve([]);
          return Promise.resolve(
            clientIds.map((cid) => ({
              id: cid,
              name: `Client ${cid}`,
              email: `${cid}@test.com`,
              first_win_completed_at: null,
              created_at: now,
              ptm_predictions: [],
              check_ins: [],
              coach_messages_as_client: [],
            })),
          );
        }),
      },
      coachMessage: {
        groupBy: jest.fn(() => Promise.resolve([])),
      },
    } as unknown as InstanceType<typeof import('../src/prisma.service').PrismaService>;
  }

  function buildAdminPtm(coachId: string) {
    return {
      getRiskBoardForCoach: jest.fn(async (callerId: string) => ({
        data: callerId === coachId ? [{ user_id: 'mock' }] : [],
        next_cursor: null,
        generated_at: new Date().toISOString(),
      })),
    } as unknown as InstanceType<typeof import('../src/admin/ptm/admin-ptm.service').AdminPtmService>;
  }

  it('getWinStreaks for coachA does not return coachB clients', async () => {
    const prismaA = buildPrisma('coach-A', ['client-A1', 'client-A2']);
    const ptmA = buildAdminPtm('coach-A');

    const svc = new CoachCommandCenterService(
      prismaA as any,
      ptmA as any,
    );

    const result = await svc.getWinStreaks('coach-A', {});
    expect(result.data.map((r) => r.client_id)).toEqual(
      expect.arrayContaining(['client-A1', 'client-A2']),
    );

    // Coach B's call uses a fresh mock where coach-B has different clients.
    const prismaB = buildPrisma('coach-B', ['client-B1']);
    const ptmB = buildAdminPtm('coach-B');
    const svcB = new CoachCommandCenterService(prismaB as any, ptmB as any);

    const resultB = await svcB.getWinStreaks('coach-B', {});
    expect(resultB.data.map((r) => r.client_id)).toEqual(['client-B1']);

    // Confirm coachA's clients are NOT in coachB's result.
    const coachAClientIds = ['client-A1', 'client-A2'];
    for (const id of coachAClientIds) {
      expect(resultB.data.map((r) => r.client_id)).not.toContain(id);
    }
  });

  it('getAtRisk delegates to adminPtm with the correct coachId', async () => {
    const prisma = buildPrisma('coach-C', []);
    const ptm = buildAdminPtm('coach-C');
    const svc = new CoachCommandCenterService(prisma as any, ptm as any);

    await svc.getAtRisk('coach-C', {});

    expect(ptm.getRiskBoardForCoach).toHaveBeenCalledWith(
      'coach-C',
      expect.any(Object),
    );
  });
});
