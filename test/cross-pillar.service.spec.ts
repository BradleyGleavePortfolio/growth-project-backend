// Stage 3 — cross-pillar coach orchestrator tests.
//
// The service composes (a) the local coach roster (Prisma) and (b)
// per-row finance lookups via FinanceAdminClient, then aggregates the
// outcome into a single response with row-level + payload-level finance
// status. Tests pin three cases:
//
//   1. Happy path — finance reachable, every client matched.
//   2. Partial — finance reachable, some clients missing on the
//      finance side. Row-level `not_found` does not poison the response.
//   3. Degraded — finance unavailable for every row. Top-level status
//      collapses to `unavailable`.

import { CrossPillarService } from '../src/coach/cross-pillar/cross-pillar.service';
import type {
  FinanceCallOutcome,
  FinanceClientSummary,
} from '../src/admin/federation/finance-contracts';

function makePrisma(rows: Array<{ id: string; email: string; name: string; created_at: Date }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValue(0);
  return {
    findMany,
    count,
    prisma: {
      user: { findMany, count },
    } as any,
  };
}

function fakeFederation(): any {
  return {
    unifiedSearch: jest.fn(),
    unifiedClient: jest.fn(),
    unifiedCoach: jest.fn(),
  };
}

function fakeFinanceClient(
  clientOutcomeForEmail: Record<string, FinanceCallOutcome<FinanceClientSummary>>,
  productUsageOutcome: FinanceCallOutcome<unknown> = { kind: 'ok', data: { stub: true } as unknown } as FinanceCallOutcome<unknown>,
): any {
  return {
    lookupClient: jest.fn(async (email: string) => {
      return (
        clientOutcomeForEmail[email.toLowerCase()] ??
        ({ kind: 'not_found' } as FinanceCallOutcome<FinanceClientSummary>)
      );
    }),
    getProductUsage: jest.fn(async () => productUsageOutcome),
  };
}

const FINANCE_OK_SUMMARY = {
  id: 'fin-1',
  email: 'sarah@example.com',
  name: 'Sarah K.',
  role: 'student',
  account_id: null,
  net_worth: 12345,
  asset_total: 20000,
  debt_total: 7655,
  cash_total: 5000,
  streak_days: null,
  last_eod_date: null,
  wealth_velocity_score: null,
  activity_last_7d: { eod_submissions: 1, what_if_scenarios: 0, coach_notes: 0 },
} as unknown as FinanceClientSummary;

describe('CrossPillarService.getClients', () => {
  it('tags rows that match on both products with [fitness, finance]', async () => {
    const { prisma } = makePrisma([
      { id: 'u-1', email: 'sarah@example.com', name: 'Sarah K.', created_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    const finance = fakeFinanceClient({
      'sarah@example.com': { kind: 'ok', data: FINANCE_OK_SUMMARY },
    });
    const svc = new CrossPillarService(prisma, fakeFederation(), finance);

    const result = await svc.getClients('coach-1', 'coach');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].pillars).toEqual(['fitness', 'finance']);
    expect(result.results[0].finance.status).toBe('ok');
    expect(result.finance.status).toBe('ok');
  });

  it('flags rows missing on the finance side as fitness-only without poisoning the page status', async () => {
    const { prisma } = makePrisma([
      { id: 'u-1', email: 'sarah@example.com', name: 'Sarah K.', created_at: new Date() },
      { id: 'u-2', email: 'unknown@example.com', name: 'Unknown', created_at: new Date() },
    ]);
    const finance = fakeFinanceClient({
      'sarah@example.com': { kind: 'ok', data: FINANCE_OK_SUMMARY },
      // 'unknown@example.com' falls through to default not_found
    });
    const svc = new CrossPillarService(prisma, fakeFederation(), finance);

    const result = await svc.getClients('coach-1', 'coach');
    const sarah = result.results.find((r) => r.email === 'sarah@example.com');
    const unknown = result.results.find((r) => r.email === 'unknown@example.com');
    expect(sarah?.pillars).toEqual(['fitness', 'finance']);
    expect(unknown?.pillars).toEqual(['fitness']);
    expect(unknown?.finance.status).toBe('not_found');
    // Page-level status: ok, since the only "miss" is a real not-found
    // (clients who legitimately don't exist on finance side).
    expect(result.finance.status).toBe('ok');
    expect(result.finance.not_found_count).toBe(1);
  });

  it('collapses to unavailable when every finance call degrades', async () => {
    const { prisma } = makePrisma([
      { id: 'u-1', email: 'a@example.com', name: 'A', created_at: new Date() },
      { id: 'u-2', email: 'b@example.com', name: 'B', created_at: new Date() },
    ]);
    const degraded: FinanceCallOutcome<FinanceClientSummary> = {
      kind: 'degraded',
      reason: 'timeout',
      detail: 'mock timeout',
    };
    const finance = fakeFinanceClient({
      'a@example.com': degraded,
      'b@example.com': degraded,
    });
    const svc = new CrossPillarService(prisma, fakeFederation(), finance);

    const result = await svc.getClients('coach-1', 'coach');
    expect(result.finance.status).toBe('unavailable');
    expect(result.finance.error_count).toBe(2);
    expect(result.results.every((r) => r.pillars.length === 1)).toBe(true);
  });
});

describe('CrossPillarService.search', () => {
  it('delegates to FederationService.unifiedSearch', async () => {
    const { prisma } = makePrisma([]);
    const federation = fakeFederation();
    federation.unifiedSearch.mockResolvedValue({ query: 'k', results: [] });
    const svc = new CrossPillarService(prisma, federation, fakeFinanceClient({}));

    await svc.search('k', 25);
    expect(federation.unifiedSearch).toHaveBeenCalledWith('k', 25);
  });
});
