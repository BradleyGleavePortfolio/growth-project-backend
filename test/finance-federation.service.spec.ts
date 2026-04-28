import { FinanceFederationService } from '../src/admin/console/finance-federation.service';
import { FinanceAdminClient } from '../src/admin/federation/finance-admin.client';
import {
  FinanceCallOutcome,
  FinanceHealthContract,
  FinanceProductUsage,
} from '../src/admin/federation/finance-contracts';

class StubFinanceClient implements Partial<FinanceAdminClient> {
  configured = true;
  authed = true;
  nextHealth: FinanceCallOutcome<FinanceHealthContract> | null = null;
  nextUsage: FinanceCallOutcome<FinanceProductUsage> | null = null;
  healthCalls = 0;
  usageCalls = 0;

  isConfigured(): boolean {
    return this.configured;
  }
  hasAuth(): boolean {
    return this.authed;
  }
  async getHealth(): Promise<FinanceCallOutcome<FinanceHealthContract>> {
    this.healthCalls += 1;
    if (!this.nextHealth) {
      throw new Error('test did not stage a health outcome');
    }
    return this.nextHealth;
  }
  async getProductUsage(): Promise<FinanceCallOutcome<FinanceProductUsage>> {
    this.usageCalls += 1;
    if (!this.nextUsage) {
      throw new Error('test did not stage a usage outcome');
    }
    return this.nextUsage;
  }
}

describe('FinanceFederationService.getHealth', () => {
  it('reports not_configured without probing when base url missing', async () => {
    const stub = new StubFinanceClient();
    stub.configured = false;
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('not_configured');
    expect(out.configured).toBe(false);
    expect(out.base_url_present).toBe(false);
    expect(out.probe.attempted).toBe(false);
    expect(out.probe.outcome).toBe('skipped');
    expect(out.probe.reason).toBe('not_configured');
    expect(stub.healthCalls).toBe(0);
    expect(typeof out.checked_at).toBe('string');
  });

  it('reports auth_unconfigured without probing when token missing', async () => {
    const stub = new StubFinanceClient();
    stub.authed = false;
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('auth_unconfigured');
    expect(out.configured).toBe(true);
    expect(out.authenticated).toBe(false);
    expect(out.probe.attempted).toBe(false);
    expect(out.probe.reason).toBe('auth_unconfigured');
    expect(stub.healthCalls).toBe(0);
  });

  it('hits the real /health endpoint and surfaces identityMapping when ok', async () => {
    const stub = new StubFinanceClient();
    stub.nextHealth = {
      kind: 'ok',
      data: {
        ok: true,
        service: 'tgp-finance',
        identityMapping: 'email',
        surface: 'admin-federation',
      },
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('ok');
    expect(out.probe.attempted).toBe(true);
    expect(out.probe.outcome).toBe('ok');
    expect(out.probe.reason).toBeNull();
    expect(out.probe.identity_mapping).toBe('email');
    expect(out.probe.service).toBe('tgp-finance');
    expect(stub.healthCalls).toBe(1);
  });

  it('reports degraded with the underlying reason on timeout', async () => {
    const stub = new StubFinanceClient();
    stub.nextHealth = {
      kind: 'degraded',
      reason: 'timeout',
      detail: 'timed out after 2500ms',
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('degraded');
    expect(out.probe.outcome).toBe('degraded');
    expect(out.probe.reason).toBe('timeout');
    expect(out.probe.detail).toBe('timed out after 2500ms');
    expect(out.probe.identity_mapping).toBeNull();
  });

  it('reports degraded with reason=http_error on 5xx', async () => {
    const stub = new StubFinanceClient();
    stub.nextHealth = {
      kind: 'degraded',
      reason: 'http_error',
      detail: 'status=503',
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('degraded');
    expect(out.probe.reason).toBe('http_error');
  });

  it('treats an unexpected 404 from /health as not_found with explanatory detail', async () => {
    const stub = new StubFinanceClient();
    stub.nextHealth = { kind: 'not_found' };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('not_found');
    expect(out.probe.outcome).toBe('not_found');
    expect(out.probe.detail).toContain('unexpected');
  });
});

describe('FinanceFederationService.getIntegrationsStatus', () => {
  it('packages finance health into an integrations envelope', async () => {
    const stub = new StubFinanceClient();
    stub.configured = false;
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getIntegrationsStatus();
    expect(out.integrations.finance_federation.status).toBe('not_configured');
    expect(typeof out.checked_at).toBe('string');
    expect(out.checked_at).toBe(out.integrations.finance_federation.checked_at);
  });
});

describe('FinanceFederationService.getProductUsage', () => {
  it('returns ok payload when finance returns 2xx', async () => {
    const stub = new StubFinanceClient();
    stub.nextUsage = {
      kind: 'ok',
      data: {
        users: { total: 50, by_role: { client: 35, coach: 15 }, onboarding_complete: 30 },
        engagement: { dau: 5, wau: 12, mau: 25 },
        product: {
          eod_submissions_last_7_days: 80,
          what_if_scenarios_last_30_days: 14,
          coach_notes_total: 200,
          milestones_unlocked_total: 60,
        },
      },
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getProductUsage();
    expect(out.status).toBe('ok');
    expect(out.data?.users.total).toBe(50);
    expect(out.data?.engagement.dau).toBe(5);
    expect(out.reason).toBeNull();
  });

  it('returns degraded with reason when finance unconfigured', async () => {
    const stub = new StubFinanceClient();
    stub.nextUsage = {
      kind: 'degraded',
      reason: 'not_configured',
      detail: 'FINANCE_API_BASE_URL is not set',
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getProductUsage();
    expect(out.status).toBe('not_configured');
    expect(out.reason).toBe('not_configured');
    expect(out.data).toBeNull();
  });

  it('returns degraded for transient failures', async () => {
    const stub = new StubFinanceClient();
    stub.nextUsage = {
      kind: 'degraded',
      reason: 'http_error',
      detail: 'status=503',
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getProductUsage();
    expect(out.status).toBe('degraded');
    expect(out.reason).toBe('http_error');
    expect(out.data).toBeNull();
  });

  it('treats a 404 from /usage/product as a degraded not_found signal', async () => {
    const stub = new StubFinanceClient();
    stub.nextUsage = { kind: 'not_found' };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getProductUsage();
    expect(out.status).toBe('not_found');
    expect(out.detail).toContain('unexpected');
    expect(out.data).toBeNull();
  });
});
