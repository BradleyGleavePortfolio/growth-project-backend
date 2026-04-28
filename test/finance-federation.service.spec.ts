import { FinanceFederationService } from '../src/admin/console/finance-federation.service';
import { FinanceAdminClient } from '../src/admin/federation/finance-admin.client';
import { FinanceCallOutcome, FinanceClientSummary } from '../src/admin/federation/finance-contracts';

class StubFinanceClient implements Partial<FinanceAdminClient> {
  configured = true;
  authed = true;
  nextLookup: FinanceCallOutcome<FinanceClientSummary> | null = null;
  lookupCalls: string[] = [];

  isConfigured(): boolean {
    return this.configured;
  }
  hasAuth(): boolean {
    return this.authed;
  }
  async lookupClient(email: string): Promise<FinanceCallOutcome<FinanceClientSummary>> {
    this.lookupCalls.push(email);
    if (!this.nextLookup) {
      throw new Error('test did not stage a lookup outcome');
    }
    return this.nextLookup;
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
    expect(stub.lookupCalls).toEqual([]);
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
    expect(stub.lookupCalls).toEqual([]);
  });

  it('reports ok and records the probe when finance returns 2xx', async () => {
    const stub = new StubFinanceClient();
    stub.nextLookup = {
      kind: 'ok',
      data: {
        email: 'admin-console-health-probe@trygrowthproject.com',
        name: null,
        subscription_status: null,
        current_period_end: null,
        last_active_at: null,
        usage_last_7d: { transactions: 0, sessions: 0 },
      },
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('ok');
    expect(out.probe.attempted).toBe(true);
    expect(out.probe.outcome).toBe('ok');
    expect(out.probe.reason).toBeNull();
    expect(stub.lookupCalls).toEqual([
      'admin-console-health-probe@trygrowthproject.com',
    ]);
  });

  it('treats 404 as a healthy reachable backend', async () => {
    const stub = new StubFinanceClient();
    stub.nextLookup = { kind: 'not_found' };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('not_found');
    expect(out.probe.outcome).toBe('not_found');
    expect(out.probe.reason).toBeNull();
  });

  it('reports degraded with the underlying reason on timeout', async () => {
    const stub = new StubFinanceClient();
    stub.nextLookup = {
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
  });

  it('reports degraded with reason=http_error on 5xx', async () => {
    const stub = new StubFinanceClient();
    stub.nextLookup = {
      kind: 'degraded',
      reason: 'http_error',
      detail: 'status=503',
    };
    const svc = new FinanceFederationService(stub as any);
    const out = await svc.getHealth();
    expect(out.status).toBe('degraded');
    expect(out.probe.reason).toBe('http_error');
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
