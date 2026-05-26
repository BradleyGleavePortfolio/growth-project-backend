/**
 * R49 DomainDnsService unit tests.
 *
 * Strategy: mock `dns/promises` at the module level so every spec
 * controls what `resolveTxt`, `resolveCname`, and `resolve4` return.
 */

jest.mock('dns', () => ({
  promises: {
    resolveTxt: jest.fn(),
    resolveCname: jest.fn(),
    resolve4: jest.fn(),
  },
}));

import { promises as dns } from 'dns';
import { DomainDnsService } from '../src/landing-pages/domains/dns.service';

const mockedTxt = dns.resolveTxt as unknown as jest.Mock;
const mockedCname = dns.resolveCname as unknown as jest.Mock;
const mockedA = dns.resolve4 as unknown as jest.Mock;

beforeEach(() => {
  mockedTxt.mockReset();
  mockedCname.mockReset();
  mockedA.mockReset();
  delete process.env.CUSTOM_DOMAIN_CNAME_TARGET;
  delete process.env.FLY_ANYCAST_IPS;
});

const svc = new DomainDnsService();

// ─── TXT ──────────────────────────────────────────────────────────────────────

describe('DomainDnsService.checkTxt', () => {
  it('returns verified when the TXT record exists with the expected value', async () => {
    mockedTxt.mockResolvedValueOnce([['tgp-verify=abc123']]);
    const out = await svc.checkTxt('coaching.example.com', 'abc123');
    expect(out.verified).toBe(true);
    expect(mockedTxt).toHaveBeenCalledWith('_tgp-verify.coaching.example.com');
  });

  it('joins multi-chunk TXT strings (Cloudflare ≥255-char split)', async () => {
    mockedTxt.mockResolvedValueOnce([['tgp-verify=', 'abc123']]);
    const out = await svc.checkTxt('coaching.example.com', 'abc123');
    expect(out.verified).toBe(true);
  });

  it('reports txt_missing when ENOTFOUND', async () => {
    const err = new Error('not found') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    mockedTxt.mockRejectedValueOnce(err);
    const out = await svc.checkTxt('coaching.example.com', 'abc123');
    expect(out).toEqual({ verified: false, reason: 'txt_missing' });
  });

  it('reports txt_missing when ENODATA', async () => {
    const err = new Error('no data') as NodeJS.ErrnoException;
    err.code = 'ENODATA';
    mockedTxt.mockRejectedValueOnce(err);
    const out = await svc.checkTxt('coaching.example.com', 'abc123');
    expect(out).toEqual({ verified: false, reason: 'txt_missing' });
  });

  it('reports txt_mismatch when the record exists but value differs', async () => {
    mockedTxt.mockResolvedValueOnce([['tgp-verify=wrong-token']]);
    const out = await svc.checkTxt('coaching.example.com', 'abc123');
    expect(out).toEqual({ verified: false, reason: 'txt_mismatch' });
  });

  it('classifies unexpected DNS errors with a generic tag', async () => {
    const err = new Error('refused') as NodeJS.ErrnoException;
    err.code = 'ESERVFAIL';
    mockedTxt.mockRejectedValueOnce(err);
    const out = await svc.checkTxt('coaching.example.com', 'abc123');
    expect(out.verified).toBe(false);
    expect(out.reason).toBe('txt_dns_error:ESERVFAIL');
  });
});

// ─── CNAME / A ────────────────────────────────────────────────────────────────

describe('DomainDnsService.checkCnameOrA', () => {
  it('verifies when CNAME points at the configured target', async () => {
    mockedCname.mockResolvedValueOnce(['custom.joingrowthproject.com']);
    const out = await svc.checkCnameOrA('coaching.example.com');
    expect(out.verified).toBe(true);
  });

  it('tolerates trailing dot from the resolver', async () => {
    mockedCname.mockResolvedValueOnce(['custom.joingrowthproject.com.']);
    const out = await svc.checkCnameOrA('coaching.example.com');
    expect(out.verified).toBe(true);
  });

  it('reports cname_mismatch when CNAME exists but points elsewhere', async () => {
    mockedCname.mockResolvedValueOnce(['some-other.cdn.example.com']);
    const out = await svc.checkCnameOrA('coaching.example.com');
    expect(out).toEqual({ verified: false, reason: 'cname_mismatch' });
  });

  it('falls back to A record check when no CNAME exists and matches Fly anycast', async () => {
    const enotfound = new Error('not found') as NodeJS.ErrnoException;
    enotfound.code = 'ENOTFOUND';
    mockedCname.mockRejectedValueOnce(enotfound);
    mockedA.mockResolvedValueOnce(['66.241.124.0']);
    const out = await svc.checkCnameOrA('apex.example.com');
    expect(out.verified).toBe(true);
  });

  it('reports a_record_mismatch when A exists but is not a Fly anycast IP', async () => {
    const enotfound = new Error('not found') as NodeJS.ErrnoException;
    enotfound.code = 'ENOTFOUND';
    mockedCname.mockRejectedValueOnce(enotfound);
    mockedA.mockResolvedValueOnce(['1.2.3.4']);
    const out = await svc.checkCnameOrA('apex.example.com');
    expect(out).toEqual({ verified: false, reason: 'a_record_mismatch' });
  });

  it('reports cname_missing when neither CNAME nor A resolves', async () => {
    const enotfound = new Error('not found') as NodeJS.ErrnoException;
    enotfound.code = 'ENOTFOUND';
    mockedCname.mockRejectedValueOnce(enotfound);
    mockedA.mockRejectedValueOnce(enotfound);
    const out = await svc.checkCnameOrA('apex.example.com');
    expect(out).toEqual({ verified: false, reason: 'cname_missing' });
  });

  it('honors CUSTOM_DOMAIN_CNAME_TARGET env override', async () => {
    process.env.CUSTOM_DOMAIN_CNAME_TARGET = 'edge.example.tgp';
    mockedCname.mockResolvedValueOnce(['edge.example.tgp']);
    const out = await svc.checkCnameOrA('apex.example.com');
    expect(out.verified).toBe(true);
  });

  it('honors FLY_ANYCAST_IPS env override', async () => {
    process.env.FLY_ANYCAST_IPS = '10.0.0.1,10.0.0.2';
    const enotfound = new Error('not found') as NodeJS.ErrnoException;
    enotfound.code = 'ENOTFOUND';
    mockedCname.mockRejectedValueOnce(enotfound);
    mockedA.mockResolvedValueOnce(['10.0.0.2']);
    const out = await svc.checkCnameOrA('apex.example.com');
    expect(out.verified).toBe(true);
  });
});

// ─── verify (both records) ────────────────────────────────────────────────────

describe('DomainDnsService.verify', () => {
  it('returns verified only when BOTH TXT and CNAME pass', async () => {
    mockedTxt.mockResolvedValueOnce([['tgp-verify=tok123']]);
    mockedCname.mockResolvedValueOnce(['custom.joingrowthproject.com']);
    const out = await svc.verify('coaching.example.com', 'tok123');
    expect(out.verified).toBe(true);
  });

  it('short-circuits at TXT — does not query CNAME on TXT failure', async () => {
    const err = new Error('not found') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    mockedTxt.mockRejectedValueOnce(err);
    const out = await svc.verify('coaching.example.com', 'tok123');
    expect(out.verified).toBe(false);
    expect(out.reason).toBe('txt_missing');
    expect(mockedCname).not.toHaveBeenCalled();
  });

  it('rejects empty domain', async () => {
    const out = await svc.verify('   ', 'tok');
    expect(out).toEqual({ verified: false, reason: 'invalid_domain' });
  });
});
