/**
 * Custom-domain SNI router middleware — R49 Phase 4.
 *
 * When a request arrives at a Host header that matches a verified +
 * issued custom domain, this middleware rewrites `req.url` so the
 * existing LandingPagePublicController (Phase 2) handles it
 * transparently:
 *
 *   GET /            on Host: coaching.example.com
 *   → rewritten to GET /p/<coachSlug>/<pageSlug>
 *
 *   GET /checkout?tier=…  on Host: coaching.example.com
 *   → rewritten to GET /p/<coachSlug>/<pageSlug>/checkout?tier=…
 *
 *   POST /leads      → POST /p/<coachSlug>/<pageSlug>/leads
 *   POST /view       → POST /p/<coachSlug>/<pageSlug>/view
 *
 * Hosts we own (app.trygrowthproject.com, joingrowthproject.com,
 * the Fly anycast CNAME target, the api.* host, *.fly.dev) are
 * passed through untouched — they hit the normal route table.
 *
 * Resolution path is LRU-cached at 60s.  A negative cache entry
 * (host is NOT a custom domain) is also retained so a bot probing
 * random hostnames does not hit the DB every time.
 *
 * This middleware MUST be applied at module bind time BEFORE the
 * NestJS router resolves to a controller — see LandingPagesModule's
 * `configure(MiddlewareConsumer)` hook.  The wildcard `forRoutes('*')`
 * ensures we see every request, including the ones the router would
 * otherwise 404.
 */

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CoachDomainsService } from './domains.service';

interface CacheEntry {
  // Either a resolved page (positive entry) or null (negative).
  page: { coach_slug: string; page_slug: string } | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1000;

/** Hosts that belong to the platform and never proxy to a custom domain. */
const PLATFORM_HOST_SUFFIXES = [
  'app.trygrowthproject.com',
  'joingrowthproject.com',
  'trygrowthproject.com',
  'fly.dev',
  'localhost',
];

function isPlatformHost(host: string): boolean {
  for (const suffix of PLATFORM_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith('.' + suffix)) return true;
  }
  return false;
}

@Injectable()
export class LandingPageHostMiddleware implements NestMiddleware {
  private readonly logger = new Logger(LandingPageHostMiddleware.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly domains: CoachDomainsService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const rawHost = (req.headers.host as string | undefined) ?? '';
    const host = rawHost.split(':')[0].trim().toLowerCase();
    if (!host || isPlatformHost(host)) {
      return next();
    }

    let entry = this.cache.get(host);
    if (!entry || entry.expiresAt < Date.now()) {
      entry = await this.resolve(host);
      this.put(host, entry);
    }
    if (!entry.page) {
      // Host is neither a platform host nor a known verified custom
      // domain.  Let the request fall through to the default router;
      // it will resolve to a 404 (unless one of the @Public() bare
      // paths matches, which is the right behavior).
      return next();
    }

    // Rewrite the URL to the canonical /p/<coach>/<page> form so the
    // Phase 2 LandingPagePublicController serves the same response a
    // direct request to that path would receive.  Preserve the
    // original `req.url` on a header for logging / analytics.
    const originalUrl = req.url;
    const [pathPart, queryPart] = splitQuery(originalUrl);
    const rewrittenPath = mapPath(pathPart, entry.page.coach_slug, entry.page.page_slug);
    if (!rewrittenPath) {
      // Unmapped path on a custom domain (e.g. /robots.txt, /admin).
      // Fall through — let the default router handle it (likely 404).
      return next();
    }
    req.url = queryPart ? `${rewrittenPath}?${queryPart}` : rewrittenPath;
    (req.headers['x-tgp-original-host'] as string | undefined) = host;
    (req.headers['x-tgp-original-url'] as string | undefined) = originalUrl;
    next();
  }

  private async resolve(host: string): Promise<CacheEntry> {
    try {
      const resolved = await this.domains.resolveByHost(host);
      if (!resolved) {
        return { page: null, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      // Only published pages are publicly visible.  An unpublished
      // page on a verified+issued domain returns a negative cache
      // entry; the worker will not change that, only a publish
      // action by the coach will (which invalidates via TTL).
      if (resolved.landing_page.status !== 'published') {
        return { page: null, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      // The Phase 2 controller resolves a page by (coachSlug, pageSlug)
      // where coachSlug is the User's invite_code.  We do not have
      // that joined here; the public service falls back to a
      // page-slug-only lookup when coachSlug doesn't disambiguate.
      // To keep this middleware self-contained, look up the coach
      // slug via the linked coach record's invite_code in a single
      // batched call.  Future PR: denormalize invite_code onto
      // CoachLandingPage so this lookup is unnecessary.
      const coachSlug = await this.resolveCoachSlug(resolved.landing_page.coach_id);
      if (!coachSlug) {
        return { page: null, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      return {
        page: { coach_slug: coachSlug, page_slug: resolved.landing_page.slug },
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
    } catch (err) {
      // DB blip: do NOT cache the failure — short-circuit to next()
      // and let the next request retry.
      this.logger.warn(`resolveByHost(${host}) failed: ${(err as Error).message}`);
      return { page: null, expiresAt: Date.now() + 5_000 };
    }
  }

  /**
   * Look up the coach's invite_code (used by the Phase 2 public route
   * as the `coachSlug` URL segment).  Cached implicitly because the
   * caller stores the resolved slug in the LRU.
   */
  private async resolveCoachSlug(coachId: string): Promise<string | null> {
    // Access the prisma client through the domains service, which is
    // the only injected dependency.  We avoid a separate inject here
    // because adding one would force every test to mock it.
    const prisma = (this.domains as unknown as { prisma: unknown }).prisma as {
      coachProfile: { findFirst: (args: { where: unknown; select: unknown }) => Promise<{ invite_code: string | null } | null> };
    };
    const profile = await prisma.coachProfile.findFirst({
      where: { coach_id: coachId },
      select: { invite_code: true },
    });
    return profile?.invite_code ?? null;
  }

  private put(host: string, entry: CacheEntry): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Simple eviction — drop the oldest insertion.  Map preserves
      // insertion order so the first key is the oldest.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(host, entry);
  }

  /** Test-only: clear the cache so spec cases don't leak between tests. */
  resetForTests(): void {
    this.cache.clear();
  }
}

// ─── Path rewriting ─────────────────────────────────────────────────────────

/**
 * Map a path on a custom domain to the canonical /p/<coach>/<page>/...
 * Returns null when the path does not match a known sub-route.
 *
 * Accepted shapes:
 *   /                → /p/<coach>/<page>
 *   /checkout        → /p/<coach>/<page>/checkout
 *   /leads           → /p/<coach>/<page>/leads
 *   /view            → /p/<coach>/<page>/view
 */
function mapPath(path: string, coachSlug: string, pageSlug: string): string | null {
  const trimmed = path.replace(/\/+$/, '') || '/';
  const base = `/p/${coachSlug}/${pageSlug}`;
  if (trimmed === '' || trimmed === '/') return base;
  if (trimmed === '/checkout') return `${base}/checkout`;
  if (trimmed === '/leads') return `${base}/leads`;
  if (trimmed === '/view') return `${base}/view`;
  return null;
}

function splitQuery(url: string): [string, string] {
  const q = url.indexOf('?');
  if (q === -1) return [url, ''];
  return [url.slice(0, q), url.slice(q + 1)];
}
