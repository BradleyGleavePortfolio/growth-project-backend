import { FinanceAdminClient } from '../src/admin/federation/finance-admin.client';

// Test subclass — overrides the protected fetchImpl member rather than
// monkey-patching globalThis.fetch. Mirrors the StripeApiService test pattern.
class TestFinanceClient extends FinanceAdminClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override fetchImpl: any = jest.fn();
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null || body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

const SAVED_BASE = process.env.FINANCE_API_BASE_URL;
const SAVED_TOKEN = process.env.FINANCE_SERVICE_TOKEN;
const SAVED_TIMEOUT = process.env.FINANCE_FEDERATION_TIMEOUT_MS;

function restoreEnv() {
  if (SAVED_BASE === undefined) delete process.env.FINANCE_API_BASE_URL;
  else process.env.FINANCE_API_BASE_URL = SAVED_BASE;
  if (SAVED_TOKEN === undefined) delete process.env.FINANCE_SERVICE_TOKEN;
  else process.env.FINANCE_SERVICE_TOKEN = SAVED_TOKEN;
  if (SAVED_TIMEOUT === undefined) delete process.env.FINANCE_FEDERATION_TIMEOUT_MS;
  else process.env.FINANCE_FEDERATION_TIMEOUT_MS = SAVED_TIMEOUT;
}

describe('FinanceAdminClient', () => {
  beforeEach(() => {
    process.env.FINANCE_API_BASE_URL = 'https://finance.example.test';
    process.env.FINANCE_SERVICE_TOKEN = 'svc-token-abc';
    delete process.env.FINANCE_FEDERATION_TIMEOUT_MS;
  });
  afterEach(restoreEnv);

  it('isConfigured + hasAuth track env vars', () => {
    const svc = new TestFinanceClient();
    expect(svc.isConfigured()).toBe(true);
    expect(svc.hasAuth()).toBe(true);
    delete process.env.FINANCE_API_BASE_URL;
    expect(svc.isConfigured()).toBe(false);
    delete process.env.FINANCE_SERVICE_TOKEN;
    expect(svc.hasAuth()).toBe(false);
  });

  it('returns degraded(not_configured) when FINANCE_API_BASE_URL is unset', async () => {
    delete process.env.FINANCE_API_BASE_URL;
    const svc = new TestFinanceClient();
    const out = await svc.searchClients('jay', 10);
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') {
      expect(out.reason).toBe('not_configured');
    }
    expect(svc.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns degraded(auth_unconfigured) when FINANCE_SERVICE_TOKEN is unset', async () => {
    delete process.env.FINANCE_SERVICE_TOKEN;
    const svc = new TestFinanceClient();
    const out = await svc.lookupClient('a@b.test');
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') {
      expect(out.reason).toBe('auth_unconfigured');
    }
    expect(svc.fetchImpl).not.toHaveBeenCalled();
  });

  it('searchClients sends bearer auth + accept header to /admin/federation/clients/search', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, { clients: [] }));
    const out = await svc.searchClients('jay', 25);
    expect(out.kind).toBe('ok');
    const [url, init] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://finance.example.test/admin/federation/clients/search?q=jay&limit=25',
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer svc-token-abc');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['X-Federation-Source']).toBe('fitness-backend');
    expect(init.signal).toBeDefined();
  });

  it('lookupClient returns ok with parsed body', async () => {
    const svc = new TestFinanceClient();
    const summary = {
      email: 'a@b.test',
      name: 'A B',
      subscription_status: 'active',
      current_period_end: '2026-05-01T00:00:00Z',
      last_active_at: null,
      usage_last_7d: { transactions: 4, sessions: 2 },
    };
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, summary));
    const out = await svc.lookupClient('a@b.test');
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.data.email).toBe('a@b.test');
  });

  it('returns not_found on 404 (no retry)', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(404, null));
    const out = await svc.lookupClient('absent@b.test');
    expect(out.kind).toBe('not_found');
    expect(svc.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once on 5xx then surfaces degraded(http_error)', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }));
    const out = await svc.lookupClient('a@b.test');
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') expect(out.reason).toBe('http_error');
    expect(svc.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retry recovers when second attempt succeeds', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl
      .mockResolvedValueOnce(jsonResponse(502, { error: 'bad_gateway' }))
      .mockResolvedValueOnce(jsonResponse(200, { clients: [] }));
    const out = await svc.searchClients('q', 10);
    expect(out.kind).toBe('ok');
    expect(svc.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('handles AbortError as degraded(timeout)', async () => {
    const svc = new TestFinanceClient();
    const abortErr: Error & { name: string } = new Error('aborted');
    abortErr.name = 'AbortError';
    svc.fetchImpl.mockRejectedValue(abortErr);
    const out = await svc.lookupClient('a@b.test');
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') expect(out.reason).toBe('timeout');
    // timeout is retryable, so two attempts
    expect(svc.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('handles malformed (non-JSON) 2xx body as degraded(malformed_response)', async () => {
    const svc = new TestFinanceClient();
    const badResponse = {
      ok: true,
      status: 200,
      text: async () => 'not json',
    } as unknown as Response;
    svc.fetchImpl.mockResolvedValueOnce(badResponse);
    const out = await svc.searchClients('q', 5);
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') expect(out.reason).toBe('malformed_response');
  });

  it('clamps timeout to range and uses default when env unset', () => {
    const svc = new TestFinanceClient();
    const resolve = (svc as unknown as { resolveTimeoutMs: () => number }).resolveTimeoutMs.bind(svc);
    delete process.env.FINANCE_FEDERATION_TIMEOUT_MS;
    expect(resolve()).toBe(2500);
    process.env.FINANCE_FEDERATION_TIMEOUT_MS = '50';
    expect(resolve()).toBe(250);
    process.env.FINANCE_FEDERATION_TIMEOUT_MS = '99999';
    expect(resolve()).toBe(15000);
    process.env.FINANCE_FEDERATION_TIMEOUT_MS = '5000';
    expect(resolve()).toBe(5000);
  });

  it('strips trailing slash from base URL', async () => {
    process.env.FINANCE_API_BASE_URL = 'https://finance.example.test///';
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, { clients: [] }));
    await svc.searchClients('q', 1);
    const [url] = svc.fetchImpl.mock.calls[0];
    expect(url.startsWith('https://finance.example.test/admin/federation/')).toBe(true);
  });
});
