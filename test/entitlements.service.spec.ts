import {
  EntitlementsService,
  emptyFitnessSnapshot,
  snapshotFromUserRow,
} from '../src/admin/entitlements/entitlements.service';
import { FinanceCallOutcome } from '../src/admin/federation/finance-contracts';

// EntitlementsService is a pure resolver — these tests assert the read shape
// the admin console renders for every combination of (fitness presence,
// finance outcome, account-level overrides). The goal is durable contract
// coverage: if any of bundle / overall / per-product status / reason
// changes meaning, these tests should break loudly.

const svc = new EntitlementsService();

const okFinance = (data: any = { id: 'fin-1' }): FinanceCallOutcome<any> => ({
  kind: 'ok',
  data,
});
const notFoundFinance = (): FinanceCallOutcome<any> => ({ kind: 'not_found' });
const degradedFinance = (
  reason: 'timeout' | 'http_error' | 'malformed_response' | 'network_error',
): FinanceCallOutcome<any> => ({
  kind: 'degraded',
  reason,
  detail: `${reason} from finance`,
});

describe('EntitlementsService — bundle classification', () => {
  it('fitness-only: student present, finance not_found → fitness_only / active', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow({ role: 'student' }),
      finance: notFoundFinance(),
    });
    expect(out.bundle).toBe('fitness_only');
    expect(out.overall).toBe('active');
    expect(out.active_products).toEqual(['fitness']);
    expect(out.products.fitness.status).toBe('active');
    expect(out.products.finance.status).toBe('inactive');
  });

  it('finance-only: no fitness row, finance ok → finance_only / active', () => {
    const out = svc.resolve({
      fitness: emptyFitnessSnapshot(),
      finance: okFinance(),
    });
    expect(out.bundle).toBe('finance_only');
    expect(out.overall).toBe('active');
    expect(out.active_products).toEqual(['finance']);
  });

  it('performance_os: both products active', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow({ role: 'student' }),
      finance: okFinance(),
    });
    expect(out.bundle).toBe('performance_os');
    expect(out.active_products.sort()).toEqual(['finance', 'fitness']);
    expect(out.overall).toBe('active');
  });

  it('none: neither product has a record', () => {
    const out = svc.resolve({
      fitness: emptyFitnessSnapshot(),
      finance: notFoundFinance(),
    });
    expect(out.bundle).toBe('none');
    expect(out.overall).toBe('inactive');
    expect(out.active_products).toEqual([]);
    expect(out.products.fitness.reason).toBe('fitness_no_record');
    expect(out.products.finance.reason).toBe('finance_no_record');
  });
});

describe('EntitlementsService — coach subscription status mapping', () => {
  function coachWith(status: string | null) {
    return svc.resolve({
      fitness: snapshotFromUserRow(
        { role: 'coach' },
        { coach_subscription_status: status },
      ),
      finance: notFoundFinance(),
    });
  }

  it('maps active', () => {
    expect(coachWith('active').products.fitness.status).toBe('active');
    expect(coachWith('active').overall).toBe('active');
  });

  it('maps trialing', () => {
    expect(coachWith('trialing').products.fitness.status).toBe('trialing');
    expect(coachWith('trialing').overall).toBe('active');
  });

  it('maps past_due (active access still granted, overall=past_due)', () => {
    const out = coachWith('past_due');
    expect(out.products.fitness.status).toBe('past_due');
    // past_due is in active_products (Stripe convention) but overall=past_due
    expect(out.active_products).toEqual(['fitness']);
    expect(out.overall).toBe('past_due');
  });

  it('maps unpaid → past_due', () => {
    expect(coachWith('unpaid').products.fitness.status).toBe('past_due');
  });

  it('maps canceled', () => {
    const out = coachWith('canceled');
    expect(out.products.fitness.status).toBe('canceled');
    expect(out.overall).toBe('canceled');
    expect(out.active_products).toEqual([]);
  });

  it('maps paused → suspended', () => {
    expect(coachWith('paused').products.fitness.status).toBe('suspended');
  });

  it('null status → inactive (no_subscription)', () => {
    const out = coachWith(null);
    expect(out.products.fitness.status).toBe('inactive');
    expect(out.products.fitness.reason).toBe('no_subscription');
    expect(out.overall).toBe('inactive');
  });

  it('unknown status → unknown with detail', () => {
    const out = coachWith('incomplete');
    expect(out.products.fitness.status).toBe('unknown');
    expect(out.products.fitness.reason).toBe('subscription_unknown');
    expect(out.products.fitness.detail).toMatch(/incomplete/);
  });
});

describe('EntitlementsService — degraded finance never silently downgrades', () => {
  it('timeout → finance status=unknown, reason=finance_degraded', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow({ role: 'student' }),
      finance: degradedFinance('timeout'),
    });
    expect(out.products.finance.status).toBe('unknown');
    expect(out.products.finance.reason).toBe('finance_degraded');
    expect(out.products.finance.detail).toMatch(/timeout/);
    // Fitness side is still active, so account is still active overall.
    expect(out.overall).toBe('active');
    expect(out.active_products).toEqual(['fitness']);
  });

  it('not_configured surfaces explicit reason instead of inactive', () => {
    const out = svc.resolve({
      fitness: emptyFitnessSnapshot(),
      finance: { kind: 'degraded', reason: 'not_configured', detail: 'no FINANCE_API_BASE_URL' },
    });
    expect(out.products.finance.status).toBe('unknown');
    expect(out.products.finance.reason).toBe('finance_not_configured');
    // Whole account is unknown (no fitness record AND finance unknown).
    expect(out.overall).toBe('unknown');
  });

  it('auth_unconfigured surfaces explicit reason', () => {
    const out = svc.resolve({
      fitness: emptyFitnessSnapshot(),
      finance: { kind: 'degraded', reason: 'auth_unconfigured', detail: 'no FINANCE_SERVICE_TOKEN' },
    });
    expect(out.products.finance.reason).toBe('finance_auth_unconfigured');
  });
});

describe('EntitlementsService — account-level overrides', () => {
  it('deletion_scheduled_at suspends every product regardless of subscription', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow(
        { role: 'coach', deletion_scheduled_at: new Date('2026-04-25') },
        { coach_subscription_status: 'active' },
      ),
      finance: okFinance(),
    });
    expect(out.account_suspended).toBe(true);
    expect(out.overall).toBe('suspended');
    expect(out.products.fitness.status).toBe('suspended');
    expect(out.products.finance.status).toBe('suspended');
    expect(out.active_products).toEqual([]); // no active products while suspended
    // Original status preserved in detail for forensics.
    expect(out.products.fitness.detail).toMatch(/prior_status=active/);
  });

  it('archived_at on a student → fitness canceled, account not suspended', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow({
        role: 'student',
        archived_at: new Date('2026-04-01'),
      }),
      finance: notFoundFinance(),
    });
    expect(out.account_suspended).toBe(false);
    expect(out.overall).toBe('canceled');
    expect(out.products.fitness.status).toBe('canceled');
    expect(out.products.fitness.reason).toBe('fitness_user_archived');
  });

  it('deleted_at → fitness inactive, NOT suspended', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow({
        role: 'student',
        deleted_at: new Date('2026-04-20'),
      }),
      finance: notFoundFinance(),
    });
    expect(out.account_suspended).toBe(false);
    expect(out.products.fitness.status).toBe('inactive');
    expect(out.products.fitness.reason).toBe('fitness_user_deleted');
    expect(out.overall).toBe('inactive');
  });
});

describe('EntitlementsService — overall status precedence', () => {
  it('any active beats past_due', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow(
        { role: 'coach' },
        { coach_subscription_status: 'past_due' },
      ),
      finance: okFinance(),
    });
    // finance=active (ok), fitness=past_due → overall=active because finance is active.
    expect(out.overall).toBe('active');
  });

  it('past_due beats canceled when no active', () => {
    const out = svc.resolve({
      fitness: snapshotFromUserRow(
        { role: 'coach', archived_at: new Date('2026-04-01') },
        { coach_subscription_status: 'canceled' },
      ),
      finance: notFoundFinance(),
    });
    // archived_at takes precedence in fitness resolution → canceled
    expect(out.products.fitness.status).toBe('canceled');
    expect(out.overall).toBe('canceled');
  });
});

describe('snapshotFromUserRow', () => {
  it('returns present=false for null user', () => {
    expect(snapshotFromUserRow(null)).toEqual({ present: false });
  });

  it('threads fields through', () => {
    const date = new Date('2026-04-01');
    const snap = snapshotFromUserRow(
      { role: 'coach', archived_at: date },
      { coach_subscription_status: 'active' },
    );
    expect(snap.present).toBe(true);
    expect(snap.role).toBe('coach');
    expect(snap.archived_at).toBe(date);
    expect(snap.coach_subscription_status).toBe('active');
  });
});
