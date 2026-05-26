/**
 * Custom-domain cert + DNS worker — R49 Phase 4.
 *
 * One @nestjs/schedule ticker, four claim shapes:
 *
 *   1. Pending DNS verify — `verification_status='pending'`.
 *      Poll DNS (TXT + CNAME).  Success → 'verified' + cert_status='requested'.
 *      6 attempts with 1/5/15-min backoff before flipping to 'failed'.
 *
 *   2. Cert issuance — `verification_status='verified'` AND
 *      `cert_status IN ('requested','none')`.  Call addCertificate,
 *      then poll getCertificate until clientStatus='Ready' (10-min ceiling
 *      per tick).  3 attempts with backoff before flipping to 'failed'.
 *
 *   3. Renewal sweep — `verification_status='verified'` AND
 *      `cert_status='issued'` AND `cert_expires_at < now+14d`.  Re-query
 *      Fly; if Ready, bump expires_at; if not, mark 'expired'.
 *
 *   4. Revoke teardown — `verification_status='revoked'` AND
 *      `fly_cert_id IS NOT NULL`.  removeCertificate then drop the row.
 *
 * Why a single cron + claim batch instead of BullMQ: the repo does
 * not ship BullMQ (confirmed via grep at write time); the schema's
 * `(verification_status, cert_status)` composite index IS the queue.
 * @nestjs/schedule is already wired in app.module.  A process restart
 * loses zero work because the row IS the durable state.
 *
 * In-process retry state lives in two Maps keyed by `(row.id, kind)`.
 * They survive a single process; on restart attempts reset to 0
 * (acceptable since Fly mutations and DNS resolution are both
 * side-effect-free until the row flips to 'failed').
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CoachLandingPageDomain } from '@prisma/client';
import { CoachDomainsService } from './domains.service';
import { DomainDnsService } from './dns.service';
import { FlyCertClient, FlyApiError } from './fly.client';

const BATCH_SIZE = 25;
const POLL_INTERVAL_MS = 30_000;       // 30s between getCertificate polls
const POLL_MAX_DURATION_MS = 10 * 60_000; // 10 min ceiling per call
const DNS_MAX_ATTEMPTS = 6;
const CERT_MAX_ATTEMPTS = 3;
const DEFAULT_CERT_TTL_DAYS = 90;
const RENEWAL_WINDOW_DAYS = 14;

type AttemptKind = 'dns' | 'cert';

@Injectable()
export class DomainCertProcessor {
  private readonly logger = new Logger(DomainCertProcessor.name);

  private readonly attempts = new Map<string, number>();
  private readonly nextEligibleAt = new Map<string, number>();

  constructor(
    private readonly domains: CoachDomainsService,
    private readonly dns: DomainDnsService,
    private readonly fly: FlyCertClient,
  ) {}

  /**
   * Cron: every 5 minutes.  DNS propagation + ACME both take minutes
   * anyway — polling at 1/min would just hammer Fly without speeding
   * anything up.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'landing-domain-certs',
    timeZone: 'UTC',
  })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.LANDING_DOMAIN_CERTS_DISABLED === 'true') return;
    try {
      const processed = await this.runOnce();
      if (processed > 0) {
        this.logger.log(`landing-domain-certs tick: processed ${processed}`);
      }
    } catch (err) {
      this.logger.error(`landing-domain-certs tick failed: ${(err as Error).message}`);
    }
  }

  /**
   * Daily renewal sweep.  Independent of the 5-min ticker so a busy
   * queue does not starve the renewal check.  Reuses the same handler.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, {
    name: 'landing-domain-cert-check',
    timeZone: 'UTC',
  })
  async renewalSweep(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.LANDING_DOMAIN_CERTS_DISABLED === 'true') return;
    try {
      const processed = await this.runOnce();
      if (processed > 0) {
        this.logger.log(`landing-domain-cert-check sweep: processed ${processed}`);
      }
    } catch (err) {
      this.logger.error(
        `landing-domain-cert-check sweep failed: ${(err as Error).message}`,
      );
    }
  }

  /** Exposed for tests + ad-hoc operator drains. */
  async runOnce(): Promise<number> {
    const now = new Date();
    const rows = await this.domains.claimWorkerBatch(BATCH_SIZE, now);
    let processed = 0;
    for (const row of rows) {
      const eligibleAt = this.nextEligibleAt.get(row.id) ?? 0;
      if (eligibleAt > Date.now()) continue;
      try {
        await this.processRow(row, now);
        processed += 1;
      } catch (err) {
        this.logger.error(
          `processRow ${row.id} (${row.domain}) threw: ${(err as Error).message}`,
        );
      }
    }
    return processed;
  }

  // ─── Per-row dispatch ───────────────────────────────────────────────────

  private async processRow(row: CoachLandingPageDomain, now: Date): Promise<void> {
    // Revoke teardown takes precedence even if the row was partway
    // through another state — the coach asked us to remove it.
    if (row.verification_status === 'revoked' && row.fly_cert_id) {
      await this.handleRevoke(row);
      return;
    }
    if (row.verification_status === 'pending') {
      await this.handleDnsVerify(row);
      return;
    }
    if (row.verification_status === 'verified') {
      if (row.cert_status === 'requested' || row.cert_status === 'none') {
        await this.handleCertIssue(row);
        return;
      }
      if (row.cert_status === 'issued') {
        await this.handleRenewalCheck(row, now);
        return;
      }
    }
  }

  // ─── DNS verify branch ──────────────────────────────────────────────────

  private async handleDnsVerify(row: CoachLandingPageDomain): Promise<void> {
    const result = await this.dns.verify(row.domain, row.verification_token);
    if (result.verified) {
      await this.domains.recordDnsVerified(row.id);
      this.attempts.delete(this.attemptKey(row.id, 'dns'));
      this.nextEligibleAt.delete(row.id);
      return;
    }
    this.recordFailure(row.id, 'dns');
    const attempts = this.attempts.get(this.attemptKey(row.id, 'dns')) ?? 0;
    const giveUp = attempts >= DNS_MAX_ATTEMPTS;
    await this.domains.recordDnsCheckFailure(row.id, {
      reason: result.reason ?? 'dns_unknown',
      markFailed: giveUp,
    });
    if (giveUp) {
      this.attempts.delete(this.attemptKey(row.id, 'dns'));
      this.nextEligibleAt.delete(row.id);
    }
  }

  // ─── Cert issue branch ──────────────────────────────────────────────────

  private async handleCertIssue(row: CoachLandingPageDomain): Promise<void> {
    if (!this.fly.isConfigured()) {
      // Dev / test boot without FLY_API_TOKEN — skip silently.  Row
      // will be re-claimed on the next tick when the token is set.
      return;
    }
    try {
      const initial = await this.fly.addCertificate(row.domain);
      if (initial.clientStatus === 'Ready') {
        await this.markCertIssued(row, initial);
        return;
      }
      const polled = await this.pollUntilReady(row.domain);
      if (polled.clientStatus === 'Ready') {
        await this.markCertIssued(row, polled);
        return;
      }
      // Still Awaiting after the budget — next tick re-polls.
      await this.domains.recordCertIssuanceProgress(
        row.id,
        `awaiting_cert:${polled.clientStatus}`,
      );
    } catch (err) {
      const reason =
        err instanceof FlyApiError
          ? `fly_${err.operation}:${err.message.slice(0, 200)}`
          : (err as Error).message.slice(0, 200);
      this.recordFailure(row.id, 'cert');
      const attempts = this.attempts.get(this.attemptKey(row.id, 'cert')) ?? 0;
      if (attempts >= CERT_MAX_ATTEMPTS) {
        await this.domains.recordCertResult(row.id, { ok: false, reason });
        this.attempts.delete(this.attemptKey(row.id, 'cert'));
        this.nextEligibleAt.delete(row.id);
      } else {
        await this.domains.recordCertIssuanceProgress(row.id, reason);
      }
    }
  }

  private async pollUntilReady(hostname: string): Promise<{
    clientStatus: string;
    id: string;
    issuedExpiresAt: Date | null;
  }> {
    const deadline = Date.now() + POLL_MAX_DURATION_MS;
    let last: Awaited<ReturnType<FlyCertClient['getCertificate']>> = null;
    while (Date.now() < deadline) {
      last = await this.fly.getCertificate(hostname);
      if (!last) {
        // Cert disappeared (admin-side delete?). Treat as Awaiting.
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (last.clientStatus === 'Ready') return last;
      await sleep(POLL_INTERVAL_MS);
    }
    return last
      ? {
          clientStatus: last.clientStatus,
          id: last.id,
          issuedExpiresAt: last.issuedExpiresAt,
        }
      : { clientStatus: 'Unknown', id: '', issuedExpiresAt: null };
  }

  private async markCertIssued(
    row: CoachLandingPageDomain,
    cert: { id: string; issuedExpiresAt: Date | null },
  ): Promise<void> {
    const expiresAt =
      cert.issuedExpiresAt ??
      new Date(Date.now() + DEFAULT_CERT_TTL_DAYS * 24 * 3600 * 1000);
    await this.domains.recordCertResult(row.id, {
      ok: true,
      fly_cert_id: cert.id,
      expires_at: expiresAt,
    });
    this.attempts.delete(this.attemptKey(row.id, 'cert'));
    this.nextEligibleAt.delete(row.id);
  }

  // ─── Renewal branch ─────────────────────────────────────────────────────

  private async handleRenewalCheck(
    row: CoachLandingPageDomain,
    now: Date,
  ): Promise<void> {
    if (!row.cert_expires_at) return;
    const daysUntilExpiry =
      (row.cert_expires_at.getTime() - now.getTime()) / (24 * 3600 * 1000);
    if (daysUntilExpiry > RENEWAL_WINDOW_DAYS) return;
    if (!this.fly.isConfigured()) return;
    try {
      const current = await this.fly.getCertificate(row.domain);
      if (current && current.clientStatus === 'Ready') {
        const newExpiry =
          current.issuedExpiresAt ??
          new Date(Date.now() + DEFAULT_CERT_TTL_DAYS * 24 * 3600 * 1000);
        await this.domains.recordCertResult(row.id, {
          ok: true,
          fly_cert_id: current.id,
          expires_at: newExpiry,
        });
        return;
      }
      await this.domains.recordCertResult(row.id, {
        ok: false,
        reason: current ? `expired_state:${current.clientStatus}` : 'cert_missing',
        markExpired: true,
      });
    } catch (err) {
      this.logger.warn(
        `renewal check ${row.domain} threw: ${(err as Error).message}`,
      );
    }
  }

  // ─── Revoke branch ──────────────────────────────────────────────────────

  private async handleRevoke(row: CoachLandingPageDomain): Promise<void> {
    if (!this.fly.isConfigured()) return;
    try {
      await this.fly.removeCertificate(row.domain);
    } catch (err) {
      // On failure: log + leave the row in revoked state.  Next tick
      // re-tries.  We do NOT hard-delete until Fly confirms teardown
      // because a stale Fly cert wastes a slot.
      this.logger.warn(
        `removeCertificate(${row.domain}) failed: ${(err as Error).message}`,
      );
      return;
    }
    await this.domains.recordRevokeComplete(row.id);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private attemptKey(id: string, kind: AttemptKind): string {
    return `${id}::${kind}`;
  }

  private recordFailure(id: string, kind: AttemptKind): void {
    const key = this.attemptKey(id, kind);
    const next = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, next);
    // 1m → 5m → 15m → 15m (cap).
    const backoffMs =
      next === 1 ? 60_000 : next === 2 ? 5 * 60_000 : 15 * 60_000;
    this.nextEligibleAt.set(id, Date.now() + backoffMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
