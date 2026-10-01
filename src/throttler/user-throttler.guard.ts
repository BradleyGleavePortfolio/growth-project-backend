import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { THROTTLER_NAMES } from './throttler.config';

// Paths that must NEVER be rate-limited regardless of traffic. Health check
// endpoints are hit by the platform (Fly.io) every few seconds; counting them
// would exhaust the per-IP bucket during normal operation and trigger false
// 429s for subsequent real requests on the same machine IP.
const HEALTH_PATHS = new Set(['/health', '/healthz', '/readyz']);

/**
 * UserThrottlerGuard -- extends the built-in ThrottlerGuard with two
 * behaviours:
 *
 * 1. Tracker key: authenticated requests bucket by user-id (`user:<id>`);
 *    unauthenticated requests bucket by client IP (`ip:<addr>`).
 *    IP extraction respects the Fly.io trusted-proxy chain:
 *      a. `Fly-Client-IP` -- set by Fly's edge with the true client IP.
 *         The most reliable source on Fly deployments.
 *      b. First hop of `X-Forwarded-For` -- standard reverse-proxy header.
 *      c. `req.ip` / socket address -- fallback for direct connections (dev).
 *
 * 2. Health check skip: `/health`, `/healthz`, and `/readyz` are whitelisted
 *    and never counted toward any throttler bucket. The guard returns `true`
 *    immediately for these paths so Fly's liveness probes cannot exhaust the
 *    per-IP limit and lock out subsequent real requests from the same machine.
 *
 * Why user-id keying matters: IP-keyed limits are too coarse for offices,
 * campus Wi-Fi, and mobile CGNAT where hundreds of real users share one
 * address. User-keyed limits track the actual subject being protected and
 * reserve IP-keyed limits for pre-auth surfaces (login, signup, forgot-
 * password) where there is no user identity yet.
 *
 * Security model for bucket-key selection:
 *   - Public endpoints that lack a Bearer token use IP-based limits (correct).
 *   - Authenticated endpoints bucket by decoded Supabase subject (consistent
 *     per-user bucketing; full JWT verification is JwtAuthGuard's job).
 *   - The attack surface for sub-forgery is low because forge-sub just yields
 *     a new per-sub bucket that is still limit-enforced. Sensitive public
 *     routes (register, login, forgot-password) use explicit @Throttle
 *     decorators with low caps, so the per-IP fallback on those routes is
 *     the more important control anyway.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  // Override the canActivate to skip health check endpoints entirely.
  // We check the path before the parent's throttle logic so no counter
  // is incremented for health-probe traffic.
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, any>>();
    const path: string = (request?.route?.path as string) || (request?.url as string) || '';
    // Strip query string for path comparison.
    const cleanPath = path.split('?')[0];
    if (HEALTH_PATHS.has(cleanPath)) {
      return true;
    }
    return super.canActivate(context);
  }

  // C14 — THROTTLER ISOLATION. The parent guard runs every named throttler on
  // every route at its module-level baseline unless the route carries
  // @SkipThrottle({ [name]: true }). That made low baselines meant for one
  // route (auth-password-reset 3/h, auth-login-per-min 5/min, …) reject
  // unrelated public reads after 3 anonymous hits from one IP. Rule: a named
  // throttler other than `default` applies ONLY to routes that declare it via
  // @Throttle({ [name]: {...} }) on the handler or controller. `default`
  // keeps applying to every route (route-level override or global baseline).
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps;
    if (!this.routeDeclaresThrottler(context, throttler.name)) {
      return true;
    }
    return super.handleRequest(requestProps);
  }

  /** `default` always applies; any other name only when the route opted in. */
  routeDeclaresThrottler(context: ExecutionContext, name: string | undefined): boolean {
    if (!name || name === THROTTLER_NAMES.DEFAULT) return true;
    const targets = [context.getHandler(), context.getClass()];
    const limit = this.reflector.getAllAndOverride<unknown>(THROTTLER_LIMIT + name, targets);
    const ttl = this.reflector.getAllAndOverride<unknown>(THROTTLER_TTL + name, targets);
    return limit !== undefined || ttl !== undefined;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Priority 1: req.user already populated by JwtAuthGuard (route-local guard
    // or because this guard runs after auth in the middleware chain for this route).
    // This is the authoritative user-id bucket for authenticated requests.
    const userId = req?.user?.id;
    if (typeof userId === 'string' && userId.length > 0) {
      return `user:${userId}`;
    }

    // C14 fix round (Sol SOL-C14-A1): NO unverified Bearer decoding. The
    // previous "priority 2" read `sub` from an UNVERIFIED Authorization
    // header, so on public auth routes (where JwtAuthGuard returns early) a
    // forged token with a fresh `sub` picked a fresh rate bucket per request.
    // Only `req.user`, set by JwtAuthGuard after signature verification (it
    // runs before this guard as an APP_GUARD), may select a user bucket;
    // everything else is keyed by the trusted client IP.

    // Priority 2: IP-based for every request without a verified user.
    // Audit #5 P1-5 — for the public storefront routes mounted at
    // /v1/packages/public/join/:token/* the IP-only bucket is leaky under
    // CGNAT / carrier-grade NAT: hundreds of mobile customers behind one
    // IPv4 share a single 20/min bucket and legitimate users get
    // collateral-throttled when one user retries. Compose the IP bucket
    // with the share token from the URL so the cap is enforced per-link
    // rather than per-IP. The share token is unguessable (21 random
    // base64 chars = ~126 bits of entropy) so this does NOT make abuse
    // easier — an attacker still has to know the token to consume any
    // bucket at all, and once they do, IP-keying caught only one of N
    // legitimate users behind the same NAT anyway.
    //
    // We restrict the token-composite path to a known prefix so unrelated
    // routes that happen to carry a `:token` param (e.g. webhooks) are
    // not affected.
    const path: string = (req?.route?.path as string) || (req?.url as string) || '';
    const tokenParam = (req?.params?.token as string | undefined)?.trim();
    const isStorefrontJoinPath =
      tokenParam &&
      tokenParam.length > 0 &&
      (path.startsWith('/v1/packages/public/join/') ||
        path.includes('/packages/public/join/'));

    const flyClientIp = (req?.headers?.['fly-client-ip'] || '') as string;
    if (flyClientIp.trim().length > 0) {
      const ipBucket = flyClientIp.trim();
      return isStorefrontJoinPath
        ? `storefront-join:${tokenParam}:${ipBucket}`
        : `ip:${ipBucket}`;
    }

    const xff = (req?.headers?.['x-forwarded-for'] || '') as string;
    const fwdIp = xff.split(',')[0]?.trim();
    if (fwdIp && fwdIp.length > 0) {
      return isStorefrontJoinPath
        ? `storefront-join:${tokenParam}:${fwdIp}`
        : `ip:${fwdIp}`;
    }

    const ip =
      req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress;
    const ipBucket = ip || 'unknown';
    return isStorefrontJoinPath
      ? `storefront-join:${tokenParam}:${ipBucket}`
      : `ip:${ipBucket}`;
  }
}
