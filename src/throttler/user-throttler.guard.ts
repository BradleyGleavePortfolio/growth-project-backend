import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

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

  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Priority 1: req.user already populated (guard order may vary in future).
    const userId = req?.user?.id;
    if (typeof userId === 'string' && userId.length > 0) {
      return `user:${userId}`;
    }

    // Priority 2: Decode Bearer token to get user id WITHOUT full verification.
    // Full JWT verification happens in JwtAuthGuard — here we only need a
    // stable bucket key for rate limiting. Forgery just means the forger gets
    // their own bucket, which is acceptable (they still hit the per-bucket limit).
    const auth = (req?.headers?.authorization ?? '') as string;
    if (auth.startsWith('Bearer ')) {
      try {
        const token = auth.slice(7);
        const parts = token.split('.');
        if (parts.length === 3) {
          const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
          const payload = JSON.parse(payloadJson) as Record<string, unknown>;
          const sub = (payload.sub ?? payload.id) as string | undefined;
          if (typeof sub === 'string' && sub.length > 0) {
            return `user:${sub}`;
          }
        }
      } catch {
        // Malformed token — fall through to IP
      }
    }

    // Priority 3: IP-based for unauthenticated requests.
    const flyClientIp = (req?.headers?.['fly-client-ip'] || '') as string;
    if (flyClientIp.trim().length > 0) {
      return `ip:${flyClientIp.trim()}`;
    }

    const xff = (req?.headers?.['x-forwarded-for'] || '') as string;
    const fwdIp = xff.split(',')[0]?.trim();
    if (fwdIp && fwdIp.length > 0) {
      return `ip:${fwdIp}`;
    }

    const ip =
      req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress;
    return `ip:${ip || 'unknown'}`;
  }
}
