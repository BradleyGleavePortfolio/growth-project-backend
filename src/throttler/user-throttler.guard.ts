import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * UserThrottlerGuard — extends the built-in ThrottlerGuard so that the
 * tracker key is the authenticated user id when the JWT guard has
 * attached `req.user`, falling back to client IP for unauthenticated
 * requests.
 *
 * Why: IP-keyed limits are too coarse for shared NAT (offices, campus
 * Wi-Fi, mobile carrier CGNAT) — one bad actor can lock out an entire
 * building, and a determined attacker behind residential proxies sees a
 * fresh quota per address. User-keyed limits track the actual subject
 * being protected. We keep IP as the fallback for genuinely public
 * endpoints (login, signup, forgot-password) where the request hasn't
 * authenticated yet.
 *
 * Implementation note: we override `getTracker` (the documented
 * extension point in @nestjs/throttler v6) rather than reimplementing
 * canActivate. Storage backend, named-throttler routing, and the
 * APP_GUARD wiring all stay in the base class.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req?.user?.id;
    if (typeof userId === 'string' && userId.length > 0) {
      return `user:${userId}`;
    }
    const xff = (req?.headers?.['x-forwarded-for'] || '') as string;
    const fwdIp = xff.split(',')[0]?.trim();
    const ip =
      fwdIp || req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress;
    return `ip:${ip || 'unknown'}`;
  }
}
