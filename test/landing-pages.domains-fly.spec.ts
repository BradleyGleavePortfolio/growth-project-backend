/**
 * R49 FlyCertClient + DomainCertProcessor tests.
 *
 * Strategy:
 *   - FlyCertClient: mock axios at module level, assert URL/headers/body.
 *   - DomainCertProcessor: pass stubbed CoachDomainsService + DomainDnsService
 *     + FlyCertClient instances; assert state transitions.
 */

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as unknown as { post: jest.Mock };
mockedAxios.post = jest.fn();

import { FlyCertClient, FlyApiError } from '../src/landing-pages/domains/fly.client';
import { DomainCertProcessor } from '../src/landing-pages/domains/cert.processor';

beforeEach(() => {
  mockedAxios.post.mockReset();
  process.env.FLY_API_TOKEN = 'test-token';
  process.env.FLY_APP_ID = 'test-app';
});

afterEach(() => {
  delete process.env.FLY_API_TOKEN;
  delete process.env.FLY_APP_ID;
});

// ─── FlyCertClient ────────────────────────────────────────────────────────────

describe('FlyCertClient', () => {
  const client = new FlyCertClient();

  it('addCertificate POSTs the GraphQL mutation with correct variables', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        data: {
          addCertificate: {
            certificate: {
              id: 'fly-cert-1',
              hostname: 'coaching.example.com',
              clientStatus: 'Awaiting configuration',
              configured: false,
              acmeDnsConfigured: false,
              acmeAlpnConfigured: false,
              certificateAuthority: 'lets_encrypt',
              issued: { nodes: [] },
            },
          },
        },
      },
    });
    const out = await client.addCertificate('coaching.example.com');
    expect(out.id).toBe('fly-cert-1');
    expect(out.clientStatus).toBe('Awaiting configuration');
    const [url, body, opts] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://api.fly.io/graphql');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(opts.timeout).toBe(10_000);
    expect(opts.validateStatus()).toBe(true);
    expect(body.operationName).toBe('AddCert');
    expect(body.variables.appId).toBe('test-app');
    expect(body.variables.hostname).toBe('coaching.example.com');
  });

  it('parses issuedExpiresAt from the cert payload', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        data: {
          addCertificate: {
            certificate: {
              id: 'c-2',
              hostname: 'h',
              clientStatus: 'Ready',
              configured: true,
              acmeDnsConfigured: true,
              acmeAlpnConfigured: true,
              certificateAuthority: 'lets_encrypt',
              issued: { nodes: [{ expiresAt: '2026-12-25T00:00:00Z' }] },
            },
          },
        },
      },
    });
    const out = await client.addCertificate('h');
    expect(out.issuedExpiresAt?.toISOString()).toBe('2026-12-25T00:00:00.000Z');
  });

  it('getCertificate returns null when Fly says the cert does not exist', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { data: { app: { certificate: null } } },
    });
    const out = await client.getCertificate('missing.example.com');
    expect(out).toBeNull();
  });

  it('throws FlyApiError on 401', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 401, headers: {}, data: {} });
    await expect(client.addCertificate('h')).rejects.toBeInstanceOf(FlyApiError);
  });

  it('throws FlyApiError when GraphQL returns errors[]', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { errors: [{ message: 'rate limited' }] },
    });
    await expect(client.addCertificate('h')).rejects.toBeInstanceOf(FlyApiError);
  });

  it('throws FlyApiError on network error', async () => {
    const err = new Error('ECONNRESET');
    (err as any).code = 'ECONNRESET';
    mockedAxios.post.mockRejectedValueOnce(err);
    await expect(client.addCertificate('h')).rejects.toBeInstanceOf(FlyApiError);
  });

  it('isConfigured returns false when FLY_API_TOKEN is unset', () => {
    delete process.env.FLY_API_TOKEN;
    expect(client.isConfigured()).toBe(false);
    process.env.FLY_API_TOKEN = 'test-token';
    expect(client.isConfigured()).toBe(true);
  });

  it('removeCertificate posts the RemoveCert mutation', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { data: { removeCertificate: { certificate: { id: 'fly-1' } } } },
    });
    await client.removeCertificate('coaching.example.com');
    const body = mockedAxios.post.mock.calls[0][1];
    expect(body.operationName).toBe('RemoveCert');
  });
});

// ─── DomainCertProcessor ─────────────────────────────────────────────────────

function makeDomainsStub() {
  return {
    claimWorkerBatch: jest.fn().mockResolvedValue([]),
    recordCertResult: jest.fn().mockResolvedValue(undefined),
    recordRevokeComplete: jest.fn().mockResolvedValue(undefined),
    recordDnsVerified: jest.fn().mockResolvedValue(undefined),
    recordDnsCheckFailure: jest.fn().mockResolvedValue(undefined),
    recordCertIssuanceProgress: jest.fn().mockResolvedValue(undefined),
  };
}

function makeDnsStub() {
  return {
    verify: jest.fn(),
    cnameTarget: jest.fn().mockReturnValue('custom.joingrowthproject.com'),
    flyAnycastIps: jest.fn().mockReturnValue([]),
    checkTxt: jest.fn(),
    checkCnameOrA: jest.fn(),
  };
}

function makeFlyStub() {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    addCertificate: jest.fn(),
    getCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };
}

function pendingRow(overrides: Record<string, any> = {}) {
  return {
    id: 'd1',
    coach_id: 'c1',
    landing_page_id: 'p1',
    domain: 'coaching.example.com',
    verification_token: 'tok123',
    verification_status: 'pending',
    cert_status: 'none',
    cert_issued_at: null,
    cert_expires_at: null,
    fly_cert_id: null,
    last_check_at: null,
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('DomainCertProcessor', () => {
  let domains: ReturnType<typeof makeDomainsStub>;
  let dns: ReturnType<typeof makeDnsStub>;
  let fly: ReturnType<typeof makeFlyStub>;
  let proc: DomainCertProcessor;

  beforeEach(() => {
    domains = makeDomainsStub();
    dns = makeDnsStub();
    fly = makeFlyStub();
    proc = new DomainCertProcessor(domains as any, dns as any, fly as any);
  });

  it('flips DNS-verified rows to verified + cert_status=requested', async () => {
    domains.claimWorkerBatch.mockResolvedValueOnce([pendingRow()]);
    dns.verify.mockResolvedValueOnce({ verified: true });
    const processed = await proc.runOnce();
    expect(processed).toBe(1);
    expect(domains.recordDnsVerified).toHaveBeenCalledWith('d1');
    expect(domains.recordCertResult).not.toHaveBeenCalled();
  });

  it('records DNS failure with the reason tag without flipping status on first miss', async () => {
    domains.claimWorkerBatch.mockResolvedValueOnce([pendingRow()]);
    dns.verify.mockResolvedValueOnce({ verified: false, reason: 'txt_missing' });
    await proc.runOnce();
    expect(domains.recordDnsCheckFailure).toHaveBeenCalledWith('d1', {
      reason: 'txt_missing',
      markFailed: false,
    });
  });

  it('flips DNS to failed after 6 attempts', async () => {
    const row = pendingRow();
    for (let i = 0; i < 6; i += 1) {
      // Reset eligibility so the per-row backoff doesn't block successive ticks.
      (proc as any).nextEligibleAt.clear();
      domains.claimWorkerBatch.mockResolvedValueOnce([row]);
      dns.verify.mockResolvedValueOnce({ verified: false, reason: 'txt_missing' });
      await proc.runOnce();
    }
    // The 6th call's recordDnsCheckFailure should have markFailed=true.
    const calls = domains.recordDnsCheckFailure.mock.calls;
    const last = calls[calls.length - 1];
    expect(last?.[1]).toEqual({ reason: 'txt_missing', markFailed: true });
  });

  it('issues a cert when verification_status=verified + cert_status=requested', async () => {
    const row = pendingRow({ verification_status: 'verified', cert_status: 'requested' });
    domains.claimWorkerBatch.mockResolvedValueOnce([row]);
    fly.addCertificate.mockResolvedValueOnce({
      id: 'fly-cert-1',
      clientStatus: 'Ready',
      issuedExpiresAt: new Date('2026-12-25T00:00:00Z'),
    });
    await proc.runOnce();
    expect(domains.recordCertResult).toHaveBeenCalledWith('d1', expect.objectContaining({
      ok: true,
      fly_cert_id: 'fly-cert-1',
    }));
  });

  it('falls back to default 90-day expiry when Fly does not return one', async () => {
    const row = pendingRow({ verification_status: 'verified', cert_status: 'requested' });
    domains.claimWorkerBatch.mockResolvedValueOnce([row]);
    fly.addCertificate.mockResolvedValueOnce({
      id: 'fly-cert-1',
      clientStatus: 'Ready',
      issuedExpiresAt: null,
    });
    await proc.runOnce();
    const args = domains.recordCertResult.mock.calls[0][1];
    expect(args.ok).toBe(true);
    expect(args.expires_at).toBeInstanceOf(Date);
    const days = (args.expires_at.getTime() - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('skips cert issuance silently when Fly is unconfigured', async () => {
    fly.isConfigured.mockReturnValue(false);
    const row = pendingRow({ verification_status: 'verified', cert_status: 'requested' });
    domains.claimWorkerBatch.mockResolvedValueOnce([row]);
    await proc.runOnce();
    expect(fly.addCertificate).not.toHaveBeenCalled();
    expect(domains.recordCertResult).not.toHaveBeenCalled();
  });

  it('records cert failure with redacted Fly error after 3 attempts', async () => {
    const row = pendingRow({ verification_status: 'verified', cert_status: 'requested' });
    const flyErr = new FlyApiError('AddCert', 'auth status 401');
    for (let i = 0; i < 3; i += 1) {
      (proc as any).nextEligibleAt.clear();
      domains.claimWorkerBatch.mockResolvedValueOnce([row]);
      fly.addCertificate.mockRejectedValueOnce(flyErr);
      await proc.runOnce();
    }
    const failedCalls = domains.recordCertResult.mock.calls.filter(
      ([, p]) => p.ok === false,
    );
    expect(failedCalls.length).toBeGreaterThan(0);
    expect(failedCalls[0][1].reason).toMatch(/fly_AddCert/);
  });

  it('renews when issued cert is within the 14-day window AND still Ready', async () => {
    const row = pendingRow({
      verification_status: 'verified',
      cert_status: 'issued',
      cert_expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      fly_cert_id: 'fly-1',
    });
    domains.claimWorkerBatch.mockResolvedValueOnce([row]);
    fly.getCertificate.mockResolvedValueOnce({
      id: 'fly-1',
      clientStatus: 'Ready',
      issuedExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    });
    await proc.runOnce();
    expect(domains.recordCertResult).toHaveBeenCalledWith('d1', expect.objectContaining({
      ok: true,
      fly_cert_id: 'fly-1',
    }));
  });

  it('marks expired when renewal poll shows the cert is no longer Ready', async () => {
    const row = pendingRow({
      verification_status: 'verified',
      cert_status: 'issued',
      cert_expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      fly_cert_id: 'fly-1',
    });
    domains.claimWorkerBatch.mockResolvedValueOnce([row]);
    fly.getCertificate.mockResolvedValueOnce({
      id: 'fly-1',
      clientStatus: 'Awaiting validation',
      issuedExpiresAt: null,
    });
    await proc.runOnce();
    expect(domains.recordCertResult).toHaveBeenCalledWith('d1', expect.objectContaining({
      ok: false,
      markExpired: true,
    }));
  });

  it('tears down revoked rows via removeCertificate then drops the row', async () => {
    const row = pendingRow({
      verification_status: 'revoked',
      cert_status: 'issued',
      fly_cert_id: 'fly-1',
    });
    domains.claimWorkerBatch.mockResolvedValueOnce([row]);
    fly.removeCertificate.mockResolvedValueOnce(undefined);
    await proc.runOnce();
    expect(fly.removeCertificate).toHaveBeenCalledWith('coaching.example.com');
    expect(domains.recordRevokeComplete).toHaveBeenCalledWith('d1');
  });

  it('leaves the row revoked if Fly teardown throws (retried next tick)', async () => {
    const row = pendingRow({
      verification_status: 'revoked',
      cert_status: 'issued',
      fly_cert_id: 'fly-1',
    });
    domains.claimWorkerBatch.mockResolvedValueOnce([row]);
    fly.removeCertificate.mockRejectedValueOnce(new FlyApiError('RemoveCert', '500'));
    await proc.runOnce();
    expect(domains.recordRevokeComplete).not.toHaveBeenCalled();
  });
});
