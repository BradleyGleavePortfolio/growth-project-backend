/**
 * CustomDomainService — Pro+ custom-domain claim + DNS verification.
 *
 * Phase 4 of the landing-pages module. Two responsibilities:
 *
 *  1. CLAIM:   coach asserts "I own coaching.example.com" and binds it to
 *              a specific landing page. Two coaches racing for the same
 *              domain must produce exactly one winner — we rely on the
 *              Postgres unique index `CoachLandingPage_custom_domain_key`
 *              and translate Prisma's P2002 into a 409 ConflictException.
 *              No application-layer mutex, no SELECT-then-UPDATE.
 *
 *  2. VERIFY:  coach hits "verify" after pointing their CNAME at
 *              `cname.trygrowthproject.com`. We resolve the CNAME with a
 *              hard 3s timeout (see DnsVerifier). Slow/silent resolvers
 *              return `status: 'timeout'` and never hang the request.
 *
 * Out of scope for Phase 4 (deferred to a later PR): Fly cert issuance,
 * background verification cron, SNI wiring. This service surfaces the
 * claim + verify API and stamps `custom_domain_verified_at` on success;
 * cert plumbing reads from that timestamp later.
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DnsVerifier, type VerifyOutcome } from './dns-verifier';

/**
 * The DNS target a coach must CNAME their custom domain to. This is the
 * Fly edge that terminates TLS for storefront pages.  Externalised via
 * env so staging/prod can differ.
 */
function cnameTarget(): string {
  return process.env.LANDING_CNAME_TARGET || 'cname.trygrowthproject.com';
}

/** Lowercase FQDN, 1-253 chars, no scheme, no path, no port, no underscores. */
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

@Injectable()
export class CustomDomainService {
  private readonly logger = new Logger(CustomDomainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dns: DnsVerifier = new DnsVerifier(),
  ) {}

  /**
   * Claim `domain` for `pageId` owned by `coachId`.
   *
   * Race-safety: the only correctness-critical operation is the final
   * `update()`. The unique index on `CoachLandingPage.custom_domain`
   * guarantees that if two coaches issue concurrent claims, exactly one
   * `UPDATE` succeeds and the other receives Prisma error code P2002
   * which we translate into `409 domain_already_claimed`. We do NOT
   * pre-check availability with a SELECT — that would be a TOCTOU bug.
   */
  async claim(coachId: string, pageId: string, rawDomain: string): Promise<{
    page_id: string;
    custom_domain: string;
    cname_target: string;
    verified: false;
  }> {
    const domain = normaliseDomain(rawDomain);
    if (!DOMAIN_RE.test(domain)) {
      throw new BadRequestException({
        error: 'invalid_domain',
        message:
          'Domain must be a valid lowercase FQDN with no scheme, path, or port.',
      });
    }

    // Pro+ tier gate. Free coaches get 402 (PaymentRequired) so the UI
    // can prompt an upgrade rather than mask it as a generic permission
    // error.  Tier resolves from CoachSubscription; if no row exists the
    // coach is treated as free.
    await this.assertProTier(coachId);

    // Load the page inside a transaction so the ownership check and the
    // claim write share one snapshot.  The unique-index check still runs
    // at COMMIT time, so this is race-safe regardless of isolation level.
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const page = await tx.coachLandingPage.findFirst({
          where: { id: pageId, coach_id: coachId },
          select: { id: true, custom_domain: true },
        });
        if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

        // (Re)claim resets verified_at so the next verify call re-runs
        // DNS against the new (or same) domain. Idempotent on the same
        // domain — we still null out verified_at to force a re-verify.
        return tx.coachLandingPage.update({
          where: { id: pageId },
          data: {
            custom_domain: domain,
            custom_domain_verified_at: null,
          },
          select: { id: true, custom_domain: true },
        });
      });

      return {
        page_id: updated.id,
        custom_domain: updated.custom_domain!,
        cname_target: cnameTarget(),
        verified: false,
      };
    } catch (err: any) {
      // Re-throw HTTP exceptions untouched.
      if (err instanceof HttpException) throw err;
      // Prisma unique-violation: another coach (or another page of the
      // same coach) already owns this domain. The DB rejected our UPDATE
      // — exactly the race-condition outcome we designed for.
      if (err?.code === 'P2002') {
        throw new ConflictException({
          error: 'domain_already_claimed',
          message: 'This domain is already bound to another landing page.',
        });
      }
      throw err;
    }
  }

  /**
   * Release the current custom-domain binding for `pageId`. Idempotent.
   */
  async release(coachId: string, pageId: string): Promise<{ ok: true }> {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
      select: { id: true },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

    await this.prisma.coachLandingPage.update({
      where: { id: pageId },
      data: { custom_domain: null, custom_domain_verified_at: null },
    });
    return { ok: true };
  }

  /**
   * Resolve the bound domain's CNAME and check it matches our edge
   * target. Honors a 3s hard timeout — we never hang the request.
   *
   * Returns a structured outcome; the controller forwards it as 200 so
   * the UI can render an actionable message per `status`.
   */
  async verify(coachId: string, pageId: string): Promise<{
    page_id: string;
    custom_domain: string;
    cname_target: string;
    outcome: VerifyOutcome;
    verified_at: Date | null;
  }> {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
      select: { id: true, custom_domain: true, custom_domain_verified_at: true },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });
    if (!page.custom_domain) {
      throw new BadRequestException({
        error: 'no_domain_bound',
        message: 'No custom domain has been claimed for this page yet.',
      });
    }

    const target = cnameTarget();
    // Snapshot the domain we are about to DNS-verify. The row could be
    // re-claimed and swapped to a different value during the up-to-3s
    // DNS window; we must re-assert it on the stamp UPDATE so we never
    // stamp `verified_at` on a domain we did not actually verify.
    const verifyingDomain = page.custom_domain;
    const outcome: VerifyOutcome = await this.dns.verifyCname(
      verifyingDomain,
      target,
    );

    let verifiedAt: Date | null = page.custom_domain_verified_at ?? null;
    let effectiveOutcome: VerifyOutcome = outcome;
    if (outcome.status === 'ok') {
      // P2-1 fix: re-assert `custom_domain` in the where clause to close
      // the TOCTOU window between the ownership read and the stamp UPDATE.
      // If the coach (or any other actor) swapped the bound domain during
      // the DNS lookup, this matches 0 rows and we report `domain_changed`
      // — we MUST NOT stamp `verified_at` on the new (unverified) host.
      // `updateMany` is used (rather than `update`) so the non-match case
      // returns `{ count: 0 }` instead of throwing P2025.
      const stamped = await this.prisma.coachLandingPage.updateMany({
        where: { id: pageId, custom_domain: verifyingDomain },
        data: { custom_domain_verified_at: new Date() },
      });

      if (stamped.count === 0) {
        // The bound domain changed mid-verify; treat as benign no-op.
        // The caller can re-issue verify against the new binding.
        this.logger.warn(
          `verify(): custom_domain swapped during DNS window for page ${pageId} ` +
            `(verified=${verifyingDomain}); refusing to stamp verified_at.`,
        );
        effectiveOutcome = { status: 'domain_changed' };
        verifiedAt = null;
      } else {
        // Read back the stamp so the response surfaces the authoritative
        // server timestamp.
        const fresh = await this.prisma.coachLandingPage.findUnique({
          where: { id: pageId },
          select: { custom_domain_verified_at: true },
        });
        verifiedAt = fresh?.custom_domain_verified_at ?? null;
      }
    }

    return {
      page_id: page.id,
      custom_domain: verifyingDomain,
      cname_target: target,
      outcome: effectiveOutcome,
      verified_at: verifiedAt,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async assertProTier(coachId: string): Promise<void> {
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
      select: { tier: true },
    });
    const tier = sub?.tier ?? 'free';
    if (tier === 'free') {
      throw new HttpException(
        {
          error: 'pro_tier_required',
          message: 'Custom domains require a Pro or Enterprise plan.',
          action: 'OPEN_PLANS',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }
}

/**
 * Normalise user-supplied domain input.  Strip scheme, port, path, and
 * any leading/trailing whitespace before validation.  We don't try to be
 * clever — anything that doesn't fit the DOMAIN_RE after this is rejected.
 */
function normaliseDomain(input: string): string {
  if (!input) return '';
  let s = input.trim().toLowerCase();
  // strip protocol
  s = s.replace(/^https?:\/\//, '');
  // strip path / query
  s = s.split('/')[0]!;
  // strip port
  s = s.split(':')[0]!;
  // strip single trailing dot
  s = s.replace(/\.$/, '');
  return s;
}

// Exported for unit-test access without exposing private state.
export const __test__ = { normaliseDomain, DOMAIN_RE };
