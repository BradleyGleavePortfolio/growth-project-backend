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
    const out = await svc.searchUsers('jay', 10);
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

  it('searchUsers calls /api/admin/federation/users/search with bearer + headers', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, []));
    const out = await svc.searchUsers('jay', 25);
    expect(out.kind).toBe('ok');
    const [url, init] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://finance.example.test/api/admin/federation/users/search?q=jay&limit=25',
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer svc-token-abc');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['X-Federation-Source']).toBe('fitness-backend');
    expect(init.signal).toBeDefined();
  });

  it('lookupClient hits /clients/by-email/:email with URL-encoded email', async () => {
    const svc = new TestFinanceClient();
    const summary = {
      id: 'u1',
      email: 'a+beta@b.test',
      name: 'A B',
      role: 'client',
      net_worth: 1000,
      asset_total: 2000,
      debt_total: 1000,
      cash_total: 500,
      streak_days: 7,
      last_eod_date: '2026-04-27',
      wealth_velocity_score: 0.42,
      activity_last_7d: { eod_submissions: 5, what_if_scenarios: 2, coach_notes: 1 },
      coach: null,
    };
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, summary));
    const out = await svc.lookupClient('a+beta@b.test');
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.data.email).toBe('a+beta@b.test');
    const [url] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://finance.example.test/api/admin/federation/clients/by-email/a%2Bbeta%40b.test',
    );
  });

  it('lookupCoach hits /coaches/by-email/:email', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'c1',
        email: 'c@coach.test',
        name: 'Coach',
        role: 'coach',
        invite_code: 'GP-XYZ',
        student_count: 4,
        active_students_7d: 3,
        eod_submissions_7d: 22,
        coach_notes_total: 100,
        program_templates_total: 6,
      }),
    );
    const out = await svc.lookupCoach('c@coach.test');
    expect(out.kind).toBe('ok');
    const [url] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://finance.example.test/api/admin/federation/coaches/by-email/c%40coach.test',
    );
  });

  it('getHealth hits /health', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        service: 'tgp-finance',
        identityMapping: 'email',
        surface: 'admin-federation',
      }),
    );
    const out = await svc.getHealth();
    expect(out.kind).toBe('ok');
    const [url] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe('https://finance.example.test/api/admin/federation/health');
  });

  it('getProductUsage hits /usage/product', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        users: { total: 10, by_role: { client: 7, coach: 3 }, onboarding_complete: 5 },
        engagement: { dau: 2, wau: 5, mau: 8 },
        product: {
          eod_submissions_last_7_days: 12,
          what_if_scenarios_last_30_days: 4,
          coach_notes_total: 200,
          milestones_unlocked_total: 9,
        },
      }),
    );
    const out = await svc.getProductUsage();
    expect(out.kind).toBe('ok');
    const [url] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe('https://finance.example.test/api/admin/federation/usage/product');
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

  it('retry recovers when second attempt succeeds (array endpoint)', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl
      .mockResolvedValueOnce(jsonResponse(502, { error: 'bad_gateway' }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    const out = await svc.searchUsers('q', 10);
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
    const out = await svc.searchUsers('q', 5);
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') expect(out.reason).toBe('malformed_response');
  });

  it('rejects non-array body for searchUsers (array endpoint contract)', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, { not: 'an array' }));
    const out = await svc.searchUsers('q', 5);
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') {
      expect(out.reason).toBe('malformed_response');
    }
  });

  it('rejects array body for object endpoints (lookupClient)', async () => {
    const svc = new TestFinanceClient();
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, []));
    const out = await svc.lookupClient('a@b.test');
    expect(out.kind).toBe('degraded');
    if (out.kind === 'degraded') {
      expect(out.reason).toBe('malformed_response');
    }
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
    svc.fetchImpl.mockResolvedValueOnce(jsonResponse(200, []));
    await svc.searchUsers('q', 1);
    const [url] = svc.fetchImpl.mock.calls[0];
    expect(url.startsWith('https://finance.example.test/api/admin/federation/')).toBe(true);
  });
});
