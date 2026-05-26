/**
 * Coach custom-domain management service — R49 Phase 4.
 *
 * Owns CRUD, tier-gating, DNS verification, and Fly cert worker
 * handoff for `coach_landing_page_domain` rows.  The HTTP surface
 * lives in `domains.controller.ts`; the cert worker lives in
 * `cert.processor.ts`.  Keeping all DB writes in this one file is
 * deliberate — it is the only seam where DomainVerificationStatus
 * and DomainCertStatus may transition.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import type {
  CoachLandingPageDomain,
  DomainCertStatus,
  DomainVerificationStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { DomainDnsService } from './dns.service';
import { validateCustomDomain } from './domain-validation';

/** Tiers that may claim a custom domain (R45 — Pro+). */
const ALLOWED_TIERS = ['pro', 'enterprise'] as const;
type AllowedTier = (typeof ALLOWED_TIERS)[number];

/** Response shape for the coach UX — no DB internals leaked. */
export interface DomainSummary {
  id: string;
  domain: string;
  landing_page_id: string;
  verification_status: DomainVerificationStatus;
  cert_status: DomainCertStatus;
  cert_expires_at: Date | null;
  last_check_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

/** What the dashboard needs to show alongside the row. */
export interface DomainInstructions {
  domain: string;
  status: 'pending' | 'verified' | 'failed' | 'issuing' | 'live' | 'revoked';
  dns_records: Array<{ type: 'TXT' | 'CNAME'; host: string; value: string }>;
  estimated_time: string;
  next_check_at: Date;
}

function toSummary(row: CoachLandingPageDomain): DomainSummary {
  return {
    id: row.id,
    domain: row.domain,
    landing_page_id: row.landing_page_id,
    verification_status: row.verification_status,
    cert_status: row.cert_status,
    cert_expires_at: row.cert_expires_at,
    last_check_at: row.last_check_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

/**
 * Resolve a row's high-level status from the (verification_status,
 * cert_status) pair.  Surfaced to the coach so they see ONE state
 * label, not two state machines.
 */
export function rollupStatus(
  row: Pick<CoachLandingPageDomain, 'verification_status' | 'cert_status'>,
): DomainInstructions['status'] {
  if (row.verification_status === 'revoked') return 'revoked';
  if (row.verification_status === 'failed') return 'failed';
  if (row.verification_status === 'pending') return 'pending';
  // verification_status === 'verified' below
  if (row.cert_status === 'issued') return 'live';
  if (row.cert_status === 'failed' || row.cert_status === 'expired') return 'failed';
  return 'issuing';
}

@Injectable()
export class CoachDomainsService {
  private readonly logger = new Logger(CoachDomainsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dns: DomainDnsService,
  ) {}

  /**
   * POST /coach/landing-pages/:id/domains
   * Validates page ownership + Pro+ tier + hostname syntax, allocates
   * a 32-byte hex verification token, and returns the row + DNS
   * instructions so the coach can act on the response without a
   * second round-trip.
   */
  async create(
    coachId: string,
    landingPageId: string,
    rawDomain: unknown,
  ): Promise<{ summary: DomainSummary; instructions: DomainInstructions }> {
    await this.assertPageOwnership(coachId, landingPageId);
    await this.assertTierAllowed(coachId);

    const validation = validateCustomDomain(rawDomain);
    if (!validation.ok) {
      throw new BadRequestException({
        error: 'INVALID_DOMAIN',
        reason: validation.reason,
      });
    }
    const normalized = validation.domain;
    const verificationToken = randomBytes(32).toString('hex');

    try {
      const row = await this.prisma.coachLandingPageDomain.create({
        data: {
          coach_id: coachId,
          landing_page_id: landingPageId,
          domain: normalized,
          verification_token: verificationToken,
        },
      });
      return { summary: toSummary(row), instructions: this.buildInstructions(row) };
    } catch (err) {
      // P2002 = unique constraint on `domain` — someone already claimed
      // this hostname (could be a different coach OR a duplicate retry).
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          error: 'DOMAIN_ALREADY_CLAIMED',
          domain: normalized,
        });
      }
      throw err;
    }
  }

  /** GET /coach/landing-pages/:id/domains — list for one page. */
  async listForPage(coachId: string, landingPageId: string): Promise<DomainSummary[]> {
    await this.assertPageOwnership(coachId, landingPageId);
    const rows = await this.prisma.coachLandingPageDomain.findMany({
      where: { landing_page_id: landingPageId, coach_id: coachId },
      orderBy: { created_at: 'desc' },
    });
    return rows.map(toSummary);
  }

  /** GET /coach/landing-pages/:id/domains/:domain_id/instructions. */
  async getInstructions(
    coachId: string,
    landingPageId: string,
    domainId: string,
  ): Promise<DomainInstructions> {
    const row = await this.loadOwnedRow(coachId, landingPageId, domainId);
    return this.buildInstructions(row);
  }

  /**
   * POST /coach/landing-pages/:id/domains/:domain_id/verify
   * Coach-initiated immediate DNS check.  On success transitions
   * verification_status='verified' and cert_status='requested' so the
   * cert worker picks it up on the next tick.
   */
  async verifyNow(
    coachId: string,
    landingPageId: string,
    domainId: string,
  ): Promise<DomainSummary> {
    const row = await this.loadOwnedRow(coachId, landingPageId, domainId);
    if (row.verification_status === 'verified') {
      return toSummary(row);
    }
    const result = await this.dns.verify(row.domain, row.verification_token);
    const now = new Date();
    const updated = await this.prisma.coachLandingPageDomain.update({
      where: { id: row.id },
      data: {
        verification_status: result.verified ? 'verified' : row.verification_status,
        cert_status:
          result.verified && row.cert_status === 'none' ? 'requested' : row.cert_status,
        last_check_at: now,
        last_error: result.verified ? null : (result.reason ?? 'unknown'),
      },
    });
    return toSummary(updated);
  }

  /**
   * DELETE /coach/landing-pages/:id/domains/:domain_id
   * Mark revoked so the cert worker tears down the Fly cert on its
   * next tick, then hard-delete.  Coach POST never blocks on the Fly
   * API call — that's the worker's job.
   */
  async revoke(
    coachId: string,
    landingPageId: string,
    domainId: string,
  ): Promise<{ ok: true; flyTeardownPending: boolean }> {
    const row = await this.loadOwnedRow(coachId, landingPageId, domainId);
    const needsTeardown =
      !!row.fly_cert_id ||
      row.cert_status === 'issued' ||
      row.cert_status === 'requested';
    if (needsTeardown) {
      await this.prisma.coachLandingPageDomain.update({
        where: { id: row.id },
        data: { verification_status: 'revoked', last_error: null },
      });
    } else {
      await this.prisma.coachLandingPageDomain.delete({ where: { id: row.id } });
    }
    return { ok: true, flyTeardownPending: needsTeardown };
  }

  /**
   * Cert-worker callback: mark a row issued (or failed).  Lives on
   * this service so the worker does not need its own Prisma surface.
   */
  async recordCertResult(
    domainId: string,
    result:
      | { ok: true; fly_cert_id: string; expires_at: Date }
      | { ok: false; reason: string; markExpired?: boolean },
  ): Promise<void> {
    if (result.ok) {
      await this.prisma.coachLandingPageDomain.update({
        where: { id: domainId },
        data: {
          cert_status: 'issued',
          cert_issued_at: new Date(),
          cert_expires_at: result.expires_at,
          fly_cert_id: result.fly_cert_id,
          last_error: null,
        },
      });
    } else {
      await this.prisma.coachLandingPageDomain.update({
        where: { id: domainId },
        data: {
          cert_status: result.markExpired ? 'expired' : 'failed',
          last_error: result.reason.slice(0, 500),
        },
      });
    }
  }

  /** Cert-worker callback: Fly teardown done, drop the row. */
  async recordRevokeComplete(domainId: string): Promise<void> {
    await this.prisma.coachLandingPageDomain.delete({ where: { id: domainId } });
  }

  /**
   * Worker-only: flip pending → verified after a successful DNS check.
   * Bumps cert_status to 'requested' iff it was 'none' so the next
   * tick picks the row up for cert issuance.
   */
  async recordDnsVerified(domainId: string): Promise<void> {
    const row = await this.prisma.coachLandingPageDomain.findUnique({
      where: { id: domainId },
      select: { cert_status: true },
    });
    await this.prisma.coachLandingPageDomain.update({
      where: { id: domainId },
      data: {
        verification_status: 'verified',
        cert_status: row?.cert_status === 'none' ? 'requested' : row?.cert_status,
        last_check_at: new Date(),
        last_error: null,
      },
    });
  }

  /** Worker-only: record a DNS check failure (optionally mark failed). */
  async recordDnsCheckFailure(
    domainId: string,
    opts: { reason: string; markFailed?: boolean },
  ): Promise<void> {
    await this.prisma.coachLandingPageDomain.update({
      where: { id: domainId },
      data: {
        verification_status: opts.markFailed ? 'failed' : undefined,
        last_check_at: new Date(),
        last_error: opts.reason.slice(0, 500),
      },
    });
  }

  /** Worker-only: stamp progress during an in-progress cert poll. */
  async recordCertIssuanceProgress(domainId: string, reason: string): Promise<void> {
    await this.prisma.coachLandingPageDomain.update({
      where: { id: domainId },
      data: { last_check_at: new Date(), last_error: reason.slice(0, 500) },
    });
  }

  /**
   * Worker scan: claim rows that need attention (verify, issue,
   * renew, or teardown).  Ordered FIFO by created_at so older work
   * drains first.  The (verification_status, cert_status) index
   * declared in r49 serves all four branches.
   */
  async claimWorkerBatch(limit: number, now: Date): Promise<CoachLandingPageDomain[]> {
    const fourteenDaysFromNow = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
    return this.prisma.coachLandingPageDomain.findMany({
      where: {
        OR: [
          // Pending DNS verify.
          { verification_status: 'pending' },
          // Verified but no cert yet.
          { verification_status: 'verified', cert_status: 'requested' },
          { verification_status: 'verified', cert_status: 'none' },
          // Issued and near expiry — re-poll Fly.
          {
            verification_status: 'verified',
            cert_status: 'issued',
            cert_expires_at: { lte: fourteenDaysFromNow },
          },
          // Coach revoked + we still have a Fly cert to tear down.
          { verification_status: 'revoked', fly_cert_id: { not: null } },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
  }

  /**
   * SNI middleware fast-path resolver.  Returns the linked landing
   * page when verification AND cert are good, else null.  Used by
   * LandingPageHostMiddleware behind an LRU cache.
   */
  async resolveByHost(hostname: string): Promise<
    | {
        domain: CoachLandingPageDomain;
        landing_page: { id: string; coach_id: string; slug: string; status: string };
      }
    | null
  > {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return null;
    const row = await this.prisma.coachLandingPageDomain.findUnique({
      where: { domain: normalized },
      include: {
        landing_page: {
          select: { id: true, coach_id: true, slug: true, status: true },
        },
      },
    });
    if (!row) return null;
    if (row.verification_status !== 'verified') return null;
    if (row.cert_status !== 'issued') return null;
    return { domain: row, landing_page: row.landing_page };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async assertPageOwnership(coachId: string, pageId: string): Promise<void> {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
      select: { id: true },
    });
    if (!page) {
      throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });
    }
  }

  private async assertTierAllowed(coachId: string): Promise<void> {
    const sub = await this.prisma.coachSubscription.findFirst({
      where: { coach_id: coachId },
      select: { tier: true, status: true },
    });
    const tier = (sub?.tier ?? 'free') as AllowedTier | 'free';
    if (!ALLOWED_TIERS.includes(tier as AllowedTier)) {
      throw new ForbiddenException({
        error: 'tier_required',
        upgrade_to: 'pro',
        message: 'Custom domains are available on the Pro tier and above.',
      });
    }
  }

  private async loadOwnedRow(
    coachId: string,
    landingPageId: string,
    domainId: string,
  ): Promise<CoachLandingPageDomain> {
    const row = await this.prisma.coachLandingPageDomain.findFirst({
      where: { id: domainId, coach_id: coachId, landing_page_id: landingPageId },
    });
    if (!row) {
      throw new NotFoundException({ error: 'DOMAIN_NOT_FOUND' });
    }
    return row;
  }

  private buildInstructions(row: CoachLandingPageDomain): DomainInstructions {
    const target = this.dns.cnameTarget();
    return {
      domain: row.domain,
      status: rollupStatus(row),
      dns_records: [
        {
          type: 'TXT',
          host: `_tgp-verify.${row.domain}`,
          value: `tgp-verify=${row.verification_token}`,
        },
        { type: 'CNAME', host: row.domain, value: target },
      ],
      estimated_time:
        'Most domains verify within 15 minutes after DNS changes propagate.',
      // Cert worker runs every 5 minutes for pending rows; surface as
      // "in ~5 min" for the dashboard.
      next_check_at: new Date(Date.now() + 5 * 60_000),
    };
  }
}
