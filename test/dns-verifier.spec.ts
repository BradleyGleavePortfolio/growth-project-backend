/**
 * Unit tests for DnsVerifier (CNAME Phase 4).
 *
 * The single most important property: a slow resolver must NOT hang the
 * request beyond the configured timeout. We assert this by:
 *   1. Plugging in a fake resolver that returns a Promise that resolves
 *      well AFTER the timeout (or never).
 *   2. Driving the clock with jest fake timers.
 *   3. Asserting the call rejects with DnsTimeoutError (or surfaces
 *      `status: 'timeout'` via verifyCname()) in O(timeoutMs).
 */

import {
  DnsVerifier,
  DnsTimeoutError,
  DNS_LOOKUP_TIMEOUT_MS,
} from '../src/landing-pages/dns-verifier';

describe('DnsVerifier', () => {
  describe('DNS_LOOKUP_TIMEOUT_MS constant', () => {
    it('defaults to 3000 ms (3 second hard cap)', () => {
      expect(DNS_LOOKUP_TIMEOUT_MS).toBe(3_000);
    });
  });

  describe('resolveCnameWithTimeout', () => {
    it('returns CNAME targets when the resolver answers quickly', async () => {
      const fakeResolve = jest
        .fn()
        .mockResolvedValue(['cname.trygrowthproject.com.']);
      const v = new DnsVerifier({ resolveCname: fakeResolve, timeoutMs: 100 });

      const out = await v.resolveCnameWithTimeout('coaching.example.com');
      expect(out).toEqual(['cname.trygrowthproject.com.']);
      expect(fakeResolve).toHaveBeenCalledWith('coaching.example.com');
    });

    it('throws DnsTimeoutError when the resolver exceeds the timeout', async () => {
      jest.useFakeTimers();
      try {
        // Resolver that NEVER resolves — only the timeout can settle this race.
        const fakeResolve = jest.fn().mockImplementation(
          () => new Promise<string[]>(() => { /* never resolves */ }),
        );
        const v = new DnsVerifier({ resolveCname: fakeResolve, timeoutMs: 50 });

        const promise = v.resolveCnameWithTimeout('slow.example.com');
        // Attach a catch immediately so the rejection isn't unhandled
        // while we advance the timers.
        const settled = promise.catch((e) => e);

        jest.advanceTimersByTime(50);
        const result = await settled;

        expect(result).toBeInstanceOf(DnsTimeoutError);
        expect((result as DnsTimeoutError).hostname).toBe('slow.example.com');
        expect((result as DnsTimeoutError).timeoutMs).toBe(50);
      } finally {
        jest.useRealTimers();
      }
    });

    it('lets the DNS error propagate when the resolver fails before the timeout', async () => {
      const err: any = new Error('not found');
      err.code = 'ENOTFOUND';
      const fakeResolve = jest.fn().mockRejectedValue(err);
      const v = new DnsVerifier({ resolveCname: fakeResolve, timeoutMs: 100 });

      await expect(v.resolveCnameWithTimeout('nx.example.com')).rejects.toBe(err);
    });

    it('rejects empty hostname', async () => {
      const v = new DnsVerifier();
      await expect(v.resolveCnameWithTimeout('')).rejects.toThrow('hostname');
    });
  });

  describe('verifyCname', () => {
    it('returns status=ok when the CNAME points at our target (case-insensitive, trailing-dot)', async () => {
      const v = new DnsVerifier({
        resolveCname: async () => ['CNAME.TryGrowthProject.com.'],
        timeoutMs: 100,
      });
      const out = await v.verifyCname(
        'coaching.example.com',
        'cname.trygrowthproject.com',
      );
      expect(out.status).toBe('ok');
    });

    it('returns status=wrong_target when the CNAME points elsewhere', async () => {
      const v = new DnsVerifier({
        resolveCname: async () => ['someone-else.example.net'],
        timeoutMs: 100,
      });
      const out = await v.verifyCname(
        'coaching.example.com',
        'cname.trygrowthproject.com',
      );
      expect(out).toEqual({
        status: 'wrong_target',
        targets: ['someone-else.example.net'],
      });
    });

    it('returns status=nxdomain when the resolver reports ENOTFOUND', async () => {
      const err: any = new Error('not found');
      err.code = 'ENOTFOUND';
      const v = new DnsVerifier({
        resolveCname: jest.fn().mockRejectedValue(err),
        timeoutMs: 100,
      });
      const out = await v.verifyCname(
        'nx.example.com',
        'cname.trygrowthproject.com',
      );
      expect(out).toEqual({ status: 'nxdomain' });
    });

    it('returns status=nxdomain when the resolver reports ENODATA (no CNAME record)', async () => {
      const err: any = new Error('no data');
      err.code = 'ENODATA';
      const v = new DnsVerifier({
        resolveCname: jest.fn().mockRejectedValue(err),
        timeoutMs: 100,
      });
      const out = await v.verifyCname('a-only.example.com', 'cname.tgp.test');
      expect(out).toEqual({ status: 'nxdomain' });
    });

    it('returns status=timeout WITHOUT hanging when the resolver is slow', async () => {
      jest.useFakeTimers();
      try {
        const fakeResolve = jest.fn().mockImplementation(
          () => new Promise<string[]>(() => { /* never resolves */ }),
        );
        const v = new DnsVerifier({
          resolveCname: fakeResolve,
          timeoutMs: 25,
        });

        const promise = v.verifyCname(
          'slow.example.com',
          'cname.trygrowthproject.com',
        );

        // Drain timers. If the implementation forgets to race against the
        // timeout this test would hang and the suite times out.
        jest.advanceTimersByTime(25);

        const out = await promise;
        expect(out).toEqual({ status: 'timeout' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('returns status=error for unexpected DNS error codes', async () => {
      const err: any = new Error('refused');
      err.code = 'ECONNREFUSED';
      const v = new DnsVerifier({
        resolveCname: jest.fn().mockRejectedValue(err),
        timeoutMs: 100,
      });
      const out = await v.verifyCname('weird.example.com', 'cname.tgp.test');
      expect(out).toEqual({ status: 'error', code: 'ECONNREFUSED' });
    });
  });
});
