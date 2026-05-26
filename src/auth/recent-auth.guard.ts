import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

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
 * - Single-use: nonce stored for TTL window; second presentation rejected.
 *   The nonce is persisted in the `recent_auth_nonce` table (see migration
 *   20260525180000_recent_auth_nonce). A second presentation of the same
 *   token within TTL returns 403 RECENT_AUTH_TOKEN_ALREADY_USED.
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

/** Minimum acceptable HMAC secret length, in characters. */
export const RECENT_AUTH_SECRET_MIN_LENGTH = 32;

/** Minimum acceptable token TTL: 1 minute. Anything shorter is unusable. */
export const RECENT_AUTH_TTL_MIN_MS = 60_000;

/** Maximum acceptable token TTL: 1 hour. Anything longer defeats the point. */
export const RECENT_AUTH_TTL_MAX_MS = 60 * 60_000;

/** Header name expected on requests to guarded endpoints. */
export const RECENT_AUTH_HEADER = 'x-recent-auth-token';

/** Client-facing message used for every guard-failure that originates in
 *  server-side misconfiguration. Never expose env-var names or internal
 *  reasons to clients (R17). The real reason is logged server-side. */
const GENERIC_CONFIG_ERROR_MESSAGE = 'Sensitive action temporarily unavailable';

/** Clock skew tolerance: allow tokens issued up to 30s in the future. */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

@Injectable()
export class RecentAuthGuard implements CanActivate {
  private readonly logger = new Logger(RecentAuthGuard.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const secret = this.config.get<string>('RECENT_AUTH_SECRET');
    if (!secret || secret.length < RECENT_AUTH_SECRET_MIN_LENGTH) {
      // Fail closed: a missing or too-short secret means this guard cannot
      // verify tokens. Block the request rather than silently passing it
      // through. Never leak the env var name to the client.
      this.logger.error(
        `RECENT_AUTH_SECRET is not configured or is shorter than ${RECENT_AUTH_SECRET_MIN_LENGTH} characters — sensitive action blocked`,
      );
      throw new ForbiddenException(GENERIC_CONFIG_ERROR_MESSAGE);
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
    const rawTtl = this.config.get<number | string>('RECENT_AUTH_TTL_MS');
    const ttl = parseTtlMs(rawTtl);

    if (ttl === null) {
      // NaN/string/zero/negative TTL would either fail-open on expiry checks
      // (NaN comparisons return false) or wedge the guard. Fail closed and
      // log the misconfiguration server-side without naming the env var to
      // the client.
      this.logger.error(
        `RECENT_AUTH_TTL_MS is not a finite positive integer in the safe range [${RECENT_AUTH_TTL_MIN_MS}, ${RECENT_AUTH_TTL_MAX_MS}] — sensitive action blocked. Got: ${typeof rawTtl}=${String(rawTtl)}`,
      );
      throw new ForbiddenException(GENERIC_CONFIG_ERROR_MESSAGE);
    }

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

    // Single-use enforcement (A1-C5-P1-3): persist a nonce keyed by the first
    // 16 hex chars of the HMAC. A second presentation within TTL produces a
    // P2002 unique-constraint violation → 403 RECENT_AUTH_TOKEN_ALREADY_USED.
    const hmacSuffix = tokenHmac.slice(0, 16);
    const expiresAt = new Date(issuedAt + ttl);
    try {
      await this.prisma.recentAuthNonce.create({
        data: {
          id: `${authedUserId}-${issuedAtStr}`,
          hmac_suffix: hmacSuffix,
          user_id: authedUserId,
          expires_at: expiresAt,
        },
      });
    } catch (e: unknown) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.warn(
          `RecentAuthGuard: replay detected for user=${authedUserId} hmac_suffix=${hmacSuffix}`,
        );
        throw new ForbiddenException({
          error: 'RECENT_AUTH_TOKEN_ALREADY_USED',
          message: 'This authentication token has already been used. Request a new one.',
        });
      }
      // Unexpected DB error — fail closed
      this.logger.error(
        `RecentAuthGuard: nonce write failed for user=${authedUserId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new ForbiddenException(GENERIC_CONFIG_ERROR_MESSAGE);
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
 * Throws an Error if the secret is missing or shorter than the documented
 * minimum length. Callers must catch and convert to an internal-only error;
 * do NOT propagate the message to clients (R17).
 *
 * @param userId   The authenticated user's database id.
 * @param secret   RECENT_AUTH_SECRET from environment.
 * @returns        `<userId>.<issuedAtMs>.<hmacHex>`
 */
export function issueRecentAuthToken(userId: string, secret: string): string {
  if (!secret || secret.length < RECENT_AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `RECENT_AUTH_SECRET must be at least ${RECENT_AUTH_SECRET_MIN_LENGTH} characters`,
    );
  }
  const issuedAt = Date.now().toString();
  const hmac = createHmac('sha256', secret)
    .update(`${userId}:${issuedAt}`)
    .digest('hex');
  return `${userId}.${issuedAt}.${hmac}`;
}

/**
 * Parse RECENT_AUTH_TTL_MS as a finite integer in the safe range.
 *
 * Accepts a number or a numeric string (ConfigService can return either
 * depending on how the value was provided). Returns null when the value is
 * missing, non-numeric, non-finite, fractional, or outside the safe range.
 *
 * Callers MUST fail closed on null — using NaN/Infinity directly in TTL
 * arithmetic would make `now - issuedAt > NaN` always false, so old tokens
 * would never expire (silent fail-open).
 */
export function parseTtlMs(raw: unknown): number | null {
  if (raw === undefined || raw === null) {
    // Default is in the safe range — a missing value falls back to the
    // documented default, not a failure.
    return RECENT_AUTH_TTL_MS;
  }
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    n = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < RECENT_AUTH_TTL_MIN_MS || n > RECENT_AUTH_TTL_MAX_MS) return null;
  return n;
}
