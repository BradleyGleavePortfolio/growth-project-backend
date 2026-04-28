import { FederationService } from '../src/admin/federation/federation.service';
import {
  FinanceCallOutcome,
  FinanceClientSummary,
  FinanceCoachSummary,
  FinanceSearchResponse,
} from '../src/admin/federation/finance-contracts';

// In-memory finance client stub. Tests configure `next` directly to model
// each outcome (ok/not_found/degraded) without touching HTTP.
class StubFinanceClient {
  searchClients = jest.fn<Promise<FinanceCallOutcome<FinanceSearchResponse>>, [string, number]>();
  lookupClient = jest.fn<Promise<FinanceCallOutcome<FinanceClientSummary>>, [string]>();
  lookupCoach = jest.fn<Promise<FinanceCallOutcome<FinanceCoachSummary>>, [string]>();
}

function buildPrismaStub() {
  const users: Array<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    coach_id: string | null;
    archived_at: Date | null;
    created_at: Date;
  }> = [];
  const coachProfiles: Array<{
    user_id: string;
    business_name: string | null;
    invite_code: string | null;
  }> = [];
  const subscriptions: Array<{
    coach_id: string;
    status: string;
    current_period_end: Date | null;
  }> = [];

  const prisma: any = {
    _users: users,
    _coachProfiles: coachProfiles,
    _subscriptions: subscriptions,
    user: {
      findMany: jest.fn(async (args: any) => {
        const where = args?.where ?? {};
        let rows = users.slice();
        if (where.role) rows = rows.filter((u) => u.role === where.role);
        if (where.OR) {
          const term = where.OR[0]?.email?.contains?.toLowerCase?.() ?? '';
          rows = rows.filter(
            (u) =>
              (u.email?.toLowerCase().includes(term) ?? false) ||
              (u.name?.toLowerCase().includes(term) ?? false),
          );
        }
        if (where.email?.equals) {
          const want = where.email.equals.toLowerCase();
          rows = rows.filter((u) => u.email.toLowerCase() === want);
        }
        if (args?.include?.coach_profile) {
          rows = rows.map((u) => ({
            ...u,
            coach_profile:
              coachProfiles.find((cp) => cp.user_id === u.id) ?? null,
          })) as any;
        }
        if (args?.take) rows = rows.slice(0, args.take);
        return rows;
      }),
      count: jest.fn(async (args: any) => {
        const where = args?.where ?? {};
        let rows = users.slice();
        if (where.coach_id) rows = rows.filter((u) => u.coach_id === where.coach_id);
        if (where.archived_at === null) rows = rows.filter((u) => u.archived_at === null);
        return rows.length;
      }),
    },
    loggedFoodEntry: {
      count: jest.fn(async () => 3),
    },
    workoutSession: {
      count: jest.fn(async () => 2),
    },
    coachMessage: {
      count: jest.fn(async () => 1),
    },
    coachSubscription: {
      findFirst: jest.fn(async ({ where }: any) => {
        return subscriptions.find((s) => s.coach_id === where.coach_id) ?? null;
      }),
    },
  };

  return prisma;
}

describe('FederationService.unifiedSearch', () => {
  it('returns empty result for empty query without calling finance', async () => {
    const prisma = buildPrismaStub();
    const finance = new StubFinanceClient();
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedSearch('', 25);
    expect(out.results).toEqual([]);
    expect(out.finance.status).toBe('ok');
    expect(finance.searchClients).not.toHaveBeenCalled();
  });

  it('merges fitness + finance results by lowercased email', async () => {
    const prisma = buildPrismaStub();
    prisma._users.push(
      {
        id: 'u1',
        email: 'Jay@example.test',
        name: 'Jay',
        role: 'student',
        coach_id: 'c1',
        archived_at: null,
        created_at: new Date('2026-04-01'),
      },
      {
        id: 'u2',
        email: 'kate@example.test',
        name: 'Kate',
        role: 'student',
        coach_id: 'c1',
        archived_at: null,
        created_at: new Date('2026-04-02'),
      },
    );
    const finance = new StubFinanceClient();
    finance.searchClients.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        clients: [
          {
            email: 'jay@example.test',
            name: 'Jay',
            account_id: 'fin-acct-1',
            subscription_status: 'active',
            current_period_end: null,
            last_active_at: null,
            usage_last_7d: { transactions: 4, sessions: 2 },
          },
          {
            email: 'leon@example.test',
            name: 'Leon',
            account_id: 'fin-acct-2',
            subscription_status: 'trialing',
            current_period_end: null,
            last_active_at: null,
            usage_last_7d: { transactions: 0, sessions: 0 },
          },
        ],
      },
    });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedSearch('exa', 25);
    expect(out.finance.status).toBe('ok');
    const byEmail = new Map(out.results.map((r) => [r.email.toLowerCase(), r]));
    expect(byEmail.get('jay@example.test')?.products.sort()).toEqual([
      'finance',
      'fitness',
    ]);
    expect(byEmail.get('kate@example.test')?.products).toEqual(['fitness']);
    expect(byEmail.get('leon@example.test')?.products).toEqual(['finance']);
    expect(byEmail.get('jay@example.test')?.finance?.account_id).toBe('fin-acct-1');
  });

  it('surfaces finance.status when finance is degraded but still returns fitness rows', async () => {
    const prisma = buildPrismaStub();
    prisma._users.push({
      id: 'u1',
      email: 'jay@example.test',
      name: 'Jay',
      role: 'student',
      coach_id: 'c1',
      archived_at: null,
      created_at: new Date(),
    });
    const finance = new StubFinanceClient();
    finance.searchClients.mockResolvedValueOnce({
      kind: 'degraded',
      reason: 'timeout',
      detail: 'timed out after 2500ms',
    });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedSearch('jay', 25);
    expect(out.finance.status).toBe('timeout');
    expect(out.results).toHaveLength(1);
    expect(out.results[0].products).toEqual(['fitness']);
  });

  it('clamps limit to 1..50', async () => {
    const prisma = buildPrismaStub();
    const finance = new StubFinanceClient();
    finance.searchClients.mockResolvedValue({ kind: 'ok', data: { clients: [] } });
    const svc = new FederationService(prisma, finance as any);
    await svc.unifiedSearch('q', 9999);
    expect(finance.searchClients).toHaveBeenCalledWith('q', 50);
    await svc.unifiedSearch('q', 0);
    expect(finance.searchClients).toHaveBeenCalledWith('q', 1);
  });
});

describe('FederationService.unifiedClient', () => {
  it('returns fitness block + finance not_configured when finance unconfigured', async () => {
    const prisma = buildPrismaStub();
    prisma._users.push({
      id: 'u1',
      email: 'jay@example.test',
      name: 'Jay',
      role: 'student',
      coach_id: 'c1',
      archived_at: null,
      created_at: new Date(),
    });
    const finance = new StubFinanceClient();
    finance.lookupClient.mockResolvedValueOnce({
      kind: 'degraded',
      reason: 'not_configured',
      detail: 'FINANCE_API_BASE_URL is not set',
    });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedClient('jay@example.test');
    expect(out.fitness).not.toBeNull();
    expect(out.fitness?.activity_last_7d).toEqual({
      food_logs: 3,
      workouts: 2,
      coach_messages: 1,
    });
    expect(out.finance.status).toBe('not_configured');
    expect(out.finance.data).toBeNull();
    expect(out.products.fitness.active).toBe(true);
    expect(out.products.finance.active).toBe(false);
    expect(out.products.finance.reason).toBe('not_configured');
  });

  it('marks finance.active=true when finance returns ok', async () => {
    const prisma = buildPrismaStub();
    prisma._users.push({
      id: 'u1',
      email: 'jay@example.test',
      name: 'Jay',
      role: 'student',
      coach_id: null,
      archived_at: null,
      created_at: new Date(),
    });
    const finance = new StubFinanceClient();
    finance.lookupClient.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        email: 'jay@example.test',
        name: 'Jay',
        subscription_status: 'active',
        current_period_end: '2026-05-01T00:00:00Z',
        last_active_at: null,
        usage_last_7d: { transactions: 7, sessions: 3 },
      },
    });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedClient('jay@example.test');
    expect(out.finance.status).toBe('ok');
    expect(out.finance.data?.subscription_status).toBe('active');
    expect(out.products.fitness.active).toBe(true);
    expect(out.products.finance.active).toBe(true);
  });

  it('returns fitness=null + finance not_found when neither product has the email', async () => {
    const prisma = buildPrismaStub();
    const finance = new StubFinanceClient();
    finance.lookupClient.mockResolvedValueOnce({ kind: 'not_found' });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedClient('ghost@example.test');
    expect(out.fitness).toBeNull();
    expect(out.finance.status).toBe('not_found');
    expect(out.products.fitness.active).toBe(false);
    expect(out.products.finance.active).toBe(false);
    expect(out.products.finance.reason).toBe('not_found');
  });

  it('marks fitness.active=false when archived_at is set', async () => {
    const prisma = buildPrismaStub();
    prisma._users.push({
      id: 'u1',
      email: 'old@example.test',
      name: 'Old',
      role: 'student',
      coach_id: null,
      archived_at: new Date('2026-01-01'),
      created_at: new Date('2025-01-01'),
    });
    const finance = new StubFinanceClient();
    finance.lookupClient.mockResolvedValueOnce({ kind: 'not_found' });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedClient('old@example.test');
    expect(out.fitness).not.toBeNull();
    expect(out.products.fitness.active).toBe(false);
    expect(out.products.fitness.reason).toBe('not_found');
  });

  it('returns empty-email payload without calling finance', async () => {
    const prisma = buildPrismaStub();
    const finance = new StubFinanceClient();
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedClient('   ');
    expect(out.fitness).toBeNull();
    expect(out.products.fitness.reason).toBe('empty_email');
    expect(out.products.finance.reason).toBe('empty_email');
    expect(finance.lookupClient).not.toHaveBeenCalled();
  });
});

describe('FederationService.unifiedCoach', () => {
  it('aggregates fitness coach roster + subscription with finance ok', async () => {
    const prisma = buildPrismaStub();
    prisma._users.push(
      {
        id: 'coach-1',
        email: 'c@coach.test',
        name: 'Coach C',
        role: 'coach',
        coach_id: null,
        archived_at: null,
        created_at: new Date(),
      },
      {
        id: 's1',
        email: 's1@x.test',
        name: 'S1',
        role: 'student',
        coach_id: 'coach-1',
        archived_at: null,
        created_at: new Date(),
      },
      {
        id: 's2',
        email: 's2@x.test',
        name: 'S2',
        role: 'student',
        coach_id: 'coach-1',
        archived_at: new Date(),
        created_at: new Date(),
      },
    );
    prisma._coachProfiles.push({
      user_id: 'coach-1',
      business_name: 'C Fitness',
      invite_code: 'GP-AAAAAA',
    });
    prisma._subscriptions.push({
      coach_id: 'coach-1',
      status: 'active',
      current_period_end: new Date('2026-06-01'),
    });
    const finance = new StubFinanceClient();
    finance.lookupCoach.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        email: 'c@coach.test',
        name: 'Coach C',
        subscription_status: 'active',
        current_period_end: '2026-06-01T00:00:00Z',
        client_count: 12,
        active_client_count: 9,
      },
    });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedCoach('c@coach.test');
    expect(out.fitness?.client_count).toBe(2);
    expect(out.fitness?.active_client_count).toBe(1);
    expect(out.fitness?.subscription_status).toBe('active');
    expect(out.fitness?.business_name).toBe('C Fitness');
    expect(out.fitness?.invite_code).toBe('GP-AAAAAA');
    expect(out.finance.status).toBe('ok');
    expect(out.finance.data?.client_count).toBe(12);
    expect(out.products).toEqual({
      fitness: { active: true },
      finance: { active: true },
    });
  });

  it('returns fitness=null + finance.status=http_error when only finance has the coach and it errored', async () => {
    const prisma = buildPrismaStub();
    const finance = new StubFinanceClient();
    finance.lookupCoach.mockResolvedValueOnce({
      kind: 'degraded',
      reason: 'http_error',
      detail: 'status=502',
    });
    const svc = new FederationService(prisma, finance as any);
    const out = await svc.unifiedCoach('absent@coach.test');
    expect(out.fitness).toBeNull();
    expect(out.finance.status).toBe('http_error');
    expect(out.products.fitness.active).toBe(false);
    expect(out.products.finance.active).toBe(false);
    expect(out.products.finance.reason).toBe('http_error');
  });
});
