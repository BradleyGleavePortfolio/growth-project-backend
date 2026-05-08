import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * RecentAuthGuard — Phase 10 Role-Gating Hardening.
 *
 * Requires a short-lived HMAC token on sensitive admin actions (account
 * deletion confirm, admin force-delete, role changes, secrets-related
 * endpoints). The token is issued at POST /auth/recent-auth-token and must be
 * fresh (within RECENT_AUTH_TTL_MS, default 5 min).
 *
 * ## Token format
 *
 *   X-Recent-Auth-Token: <user_id>.<issued_at_ms>.<hmac_hex>
 *
 * HMAC-SHA256(RECENT_AUTH_SECRET, "<user_id>:<issued_at_ms>")
 *
 * The secret MUST be set in the environment. The guard fails closed (403) if
 * the secret is absent — misconfiguration must never silently skip the check.
 *
 * ## Apply to sensitive routes
 *
 *   @UseGuards(JwtAuthGuard, RecentAuthGuard)
 *   @Delete('me/account/confirm-delete')
 *   confirmDeleteAccount() { ... }
 *
 * ## Token lifecycle
 *
 * - Valid for 5 minutes (configurable via RECENT_AUTH_TTL_MS).
 * - Bound to the authenticated user's id — cannot be used cross-user.
 * - Stateless: not server-stored. The short window limits blast radius.
 *
 * ## Env vars
 *
 * | Var                  | Required | Default | Purpose                             |
 * |----------------------|----------|---------|-------------------------------------|
 * | RECENT_AUTH_SECRET   | yes      | —       | HMAC signing secret (≥32 chars)     |
 * | RECENT_AUTH_TTL_MS   | no       | 300000  | Token validity window in ms (5 min) |
 */

/** Default validity window: 5 minutes. */
export const RECENT_AUTH_TTL_MS = 5 * 60 * 1000;

/** Header name expected on requests to guarded endpoints. */
export const RECENT_AUTH_HEADER = 'x-recent-auth-token';

/** Clock skew tolerance: allow tokens issued up to 30s in the future. */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

@Injectable()
export class RecentAuthGuard implements CanActivate {
  constructor(private config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>('RECENT_AUTH_SECRET');
    if (!secret) {
      // Fail closed: a missing secret means this guard cannot verify tokens.
      // Block the request rather than silently passing it through.
      throw new ForbiddenException(
        'RECENT_AUTH_SECRET not configured; sensitive action blocked. ' +
          'Set RECENT_AUTH_SECRET in the environment.',
      );
    }

    const req = context.switchToHttp().getRequest();
    const rawHeader: string | undefined = req.headers?.[RECENT_AUTH_HEADER];
    if (!rawHeader) {
      throw new UnauthorizedException(
        `${RECENT_AUTH_HEADER} header is required for this action. ` +
          'Call POST /auth/recent-auth-token to obtain a token.',
      );
    }

    const parts = rawHeader.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Recent-auth token format invalid (expected user_id.issued_at.hmac)');
    }

    const [tokenUserId, issuedAtStr, tokenHmac] = parts;
    const issuedAt = parseInt(issuedAtStr, 10);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
      throw new UnauthorizedException('Recent-auth token issued_at is not a valid timestamp');
    }

    const now = Date.now();
    const ttl = this.config.get<number>('RECENT_AUTH_TTL_MS') ?? RECENT_AUTH_TTL_MS;

    // Reject expired tokens.
    if (now - issuedAt > ttl) {
      throw new UnauthorizedException(
        'Recent-auth token has expired. Re-authenticate and retry.',
      );
    }

    // Reject tokens from the future (beyond clock-skew tolerance).
    if (issuedAt - now > CLOCK_SKEW_TOLERANCE_MS) {
      throw new UnauthorizedException('Recent-auth token issued_at is in the future');
    }

    // Token must be bound to the authenticated user.
    const authedUserId: string | undefined = req.user?.id;
    if (!authedUserId) {
      // JwtAuthGuard must run before this guard.
      throw new UnauthorizedException('Authenticated user required');
    }
    if (tokenUserId !== authedUserId) {
      throw new ForbiddenException(
        'Recent-auth token was issued for a different user',
      );
    }

    // Validate HMAC using constant-time comparison to prevent timing attacks.
    const expectedHmac = createHmac('sha256', secret)
      .update(`${tokenUserId}:${issuedAtStr}`)
      .digest('hex');

    let match: boolean;
    try {
      const expectedBuf = Buffer.from(expectedHmac, 'hex');
      const actualBuf = Buffer.from(tokenHmac, 'hex');
      match =
        expectedBuf.length === actualBuf.length &&
        timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      match = false;
    }

    if (!match) {
      throw new UnauthorizedException('Recent-auth token HMAC invalid');
    }

    return true;
  }
}

/**
 * Issue a recent-auth token for a user.
 *
 * Exported as a pure function so AuthService can call it without
 * injecting the guard (guards are request-scoped; services are not).
 *
 * @param userId   The authenticated user's database id.
 * @param secret   RECENT_AUTH_SECRET from environment.
 * @returns        `<userId>.<issuedAtMs>.<hmacHex>`
 */
export function issueRecentAuthToken(userId: string, secret: string): string {
  const issuedAt = Date.now().toString();
  const hmac = createHmac('sha256', secret)
    .update(`${userId}:${issuedAt}`)
    .digest('hex');
  return `${userId}.${issuedAt}.${hmac}`;
}
