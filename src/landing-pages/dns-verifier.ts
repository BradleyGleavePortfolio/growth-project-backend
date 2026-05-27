/**
 * DNS verification for custom-domain CNAME claims (CNAME Phase 4).
 *
 * Hard requirement: every DNS lookup MUST honor a wall-clock timeout. A
 * malicious or misconfigured resolver can hang for minutes — that traffic
 * is initiated by an authenticated coach hitting `POST /:id/custom-domain/verify`,
 * but it still occupies a Node request slot. We bound each lookup at 3s
 * (DNS_LOOKUP_TIMEOUT_MS) and surface an explicit timeout signal to the caller
 * instead of letting the promise dangle.
 *
 * The verifier returns a structured result rather than throwing for the
 * common failure modes (NXDOMAIN, wrong target, timeout). That keeps the
 * controller free of try/catch noise and lets us return 200 + a reason
 * code the UI can render. Genuine programming errors (bad input) still
 * throw.
 */

import { promises as dnsPromises } from 'dns';

/** Hard wall-clock timeout for a single DNS lookup, in milliseconds. */
export const DNS_LOOKUP_TIMEOUT_MS = 3_000;

/** Sentinel error used to flag "the resolver did not answer in time". */
export class DnsTimeoutError extends Error {
  constructor(public readonly hostname: string, public readonly timeoutMs: number) {
    super(`DNS lookup for ${hostname} timed out after ${timeoutMs}ms`);
    this.name = 'DnsTimeoutError';
  }
}

/**
 * Minimal CNAME resolver shape — we depend on a function, not the full
 * Node `dns` module, so tests can inject a slow or controllable fake.
 */
export type CnameResolver = (hostname: string) => Promise<string[]>;

export interface DnsVerifierOptions {
  /** Override for testing. Default: `dns.promises.resolveCname`. */
  resolveCname?: CnameResolver;
  /** Override for testing. Default: DNS_LOOKUP_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type VerifyOutcome =
  | { status: 'ok'; targets: string[] }
  | { status: 'wrong_target'; targets: string[] }
  | { status: 'nxdomain' }
  | { status: 'timeout' }
  | { status: 'error'; code: string }
  /**
   * The bound `custom_domain` changed between the ownership read and the
   * post-DNS stamp UPDATE — we DNS-verified one host but the row now
   * points at another. Emitted by `CustomDomainService.verify()` only;
   * the DNS layer itself never produces this status. Surfacing it as a
   * `VerifyOutcome` variant lets the controller render it via the same
   * 200-with-reason path as every other non-`ok` state.
   */
  | { status: 'domain_changed' };

/**
 * DnsVerifier — wraps the Node DNS resolver with a hard timeout.
 *
 * Usage:
 *   const v = new DnsVerifier();
 *   const result = await v.verifyCname('foo.example.com', 'cname.trygrowthproject.com');
 *   // result.status ∈ {ok, wrong_target, nxdomain, timeout, error}
 *
 * Never hangs longer than `timeoutMs`. On timeout the inner DNS promise
 * is abandoned (Node has no first-class cancellation for dns.promises, so
 * the socket eventually closes itself) but the request is freed
 * immediately to return a 200 to the caller with `status: 'timeout'`.
 */
export class DnsVerifier {
  private readonly resolveCname: CnameResolver;
  private readonly timeoutMs: number;

  constructor(opts: DnsVerifierOptions = {}) {
    this.resolveCname = opts.resolveCname ?? ((h) => dnsPromises.resolveCname(h));
    this.timeoutMs = opts.timeoutMs ?? DNS_LOOKUP_TIMEOUT_MS;
  }

  /**
   * Resolve a CNAME with a hard timeout. Returns the list of CNAME targets
   * the resolver reported. Throws `DnsTimeoutError` after `timeoutMs`.
   * Re-throws any non-timeout DNS error so the caller can inspect `.code`.
   */
  async resolveCnameWithTimeout(hostname: string): Promise<string[]> {
    if (!hostname) throw new Error('hostname is required');

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DnsTimeoutError(hostname, this.timeoutMs)),
        this.timeoutMs,
      );
      // Don't keep the event loop alive for a tiny worker job.
      if (timer.unref) timer.unref();
    });

    try {
      // Promise.race resolves/rejects with whichever fires first. If DNS
      // wins, we cancel the timer. If timer wins, the inflight DNS promise
      // is orphaned but cannot affect this request's outcome.
      return await Promise.race([this.resolveCname(hostname), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * High-level verify: resolve the coach's domain CNAME and check the
   * target matches our expected apex (case-insensitive, trailing dot
   * normalised).  All paths return a structured `VerifyOutcome` — the
   * caller never has to try/catch ordinary failure modes.
   */
  async verifyCname(hostname: string, expectedTarget: string): Promise<VerifyOutcome> {
    const want = normaliseHost(expectedTarget);
    try {
      const targets = await this.resolveCnameWithTimeout(hostname);
      const norm = targets.map(normaliseHost);
      if (norm.length === 0) return { status: 'wrong_target', targets };
      if (norm.includes(want)) return { status: 'ok', targets };
      return { status: 'wrong_target', targets };
    } catch (err: any) {
      if (err instanceof DnsTimeoutError) return { status: 'timeout' };
      const code: string = err?.code ?? 'UNKNOWN';
      // Node DNS error codes are upper-snake-case; the most common
      // "domain doesn't exist" code is ENOTFOUND.  ENODATA means the
      // record exists but has no CNAME (coach pointed an A record).
      if (code === 'ENOTFOUND' || code === 'ENODATA') return { status: 'nxdomain' };
      return { status: 'error', code };
    }
  }
}

/** Lowercase + strip a single trailing dot, the canonical DNS form. */
function normaliseHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '');
}
