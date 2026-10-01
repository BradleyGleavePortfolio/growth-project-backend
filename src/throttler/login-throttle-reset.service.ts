import { Injectable, Optional, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerException } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { blockedCheckFor, resetFor, strictIncrementFor } from './throttler.config';

// Clinic C13 fix round (Grok B5) — per-IP ceiling on brand-new COACH accounts
// minted through /auth/google and /auth/apple. Those routes carry login
// throttles that a successful exchange used to reset, so coach minting was
// unbounded per IP. Default matches /auth/register's AUTH_SIGNUP (5/hour).
// Clamped to [1, 500]. Client creates are NOT counted here on purpose: clinic
// QR intake (C03) signs many clients up behind one NAT.
export const AUTH_OAUTH_COACH_SIGNUP_PER_HOUR_DEFAULT = 5;
export function resolveOAuthCoachSignupPerHour(): number {
  const raw = process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
  if (!raw) return AUTH_OAUTH_COACH_SIGNUP_PER_HOUR_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return AUTH_OAUTH_COACH_SIGNUP_PER_HOUR_DEFAULT;
  return Math.min(n, 500);
}
const OAUTH_COACH_SIGNUP_TTL_MS = 3_600_000;
/**
 * Sol SOL-C13-A2 — the ceiling must BLOCK, not reset. @nestjs/throttler's
 * adapters only hold a key over its limit for `blockDuration`; with 0 the
 * in-memory adapter resets the counter on the overflowing call (hits ran
 * 1..5,1..5,…) and the Redis adapter runs `SET … PX 0`, which errors. A
 * full-window block keeps every over-limit attempt rejected until the hour
 * elapses. Exported for the real-storage tests.
 */
export const OAUTH_COACH_SIGNUP_BLOCK_MS = OAUTH_COACH_SIGNUP_TTL_MS;
/**
 * Dedicated storage namespace. Not a guard-registered throttler on purpose:
 * the in-memory adapter keeps expiry timers per throttler NAME, and its
 * block-expiry path clears every timer for that name, so sharing
 * `auth-signup` would disturb the guard's /auth/register counters.
 */
export const OAUTH_COACH_SIGNUP_THROTTLER = 'oauth-coach-signup';
export function oauthCoachSignupKey(ip: string | null | undefined): string {
  const trimmed = (ip ?? '').trim();
  return `oauth-coach-signup:ip:${trimmed.length > 0 ? trimmed : 'unknown'}`;
}


// ---------------------------------------------------------------------------
// C14 fix round — per-ACCOUNT password-failure lock (Opus C14-A1, Sol C14-A2).
//
// Per-IP login limits are NEVER reset (a success by one identity must not
// clear anybody else's attack budget). Password guessing against one account
// is bounded by a failure counter keyed on that account alone, regardless of
// IP; only that account's own successful sign-in may clear it.
// ---------------------------------------------------------------------------
export const AUTH_LOGIN_ACCOUNT_FAILURES_DEFAULT = 10;
export const AUTH_LOGIN_ACCOUNT_WINDOW_MS = 15 * 60_000;
export const AUTH_LOGIN_ACCOUNT_LOCK_MS = 15 * 60_000;
export function resolveAccountFailureLimit(): number {
  const raw = process.env.AUTH_LOGIN_ACCOUNT_FAILURES;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 3) return AUTH_LOGIN_ACCOUNT_FAILURES_DEFAULT;
  return Math.min(n, 100);
}
/**
 * Storage key + throttler name for one account. The name is per account on
 * purpose: the in-memory adapter keeps expiry timers per NAME and its reset
 * clears every timer for that name, so a shared name would let one account's
 * reset disturb other accounts' counters.
 */
export function accountFailureBucket(email: string): { key: string; name: string } {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
  return { key: `auth-login-account:${digest}`, name: `auth-login-account:${digest}` };
}

/**
 * LoginThrottleResetService — auth-specific throttling that the route guard
 * cannot express: the OAuth coach-signup ceiling (C13) and the per-account
 * password-failure lock (C14). Every operation goes through the production
 * storage wrapper's STRICT operations, so a storage outage fails CLOSED
 * (503) instead of silently allowing or silently not resetting.
 */
@Injectable()
export class LoginThrottleResetService {
  private readonly logger = new Logger(LoginThrottleResetService.name);

  constructor(
    @Optional()
    @InjectThrottlerStorage()
    private readonly storage: ThrottlerStorage | undefined,
  ) {}

  /**
   * Consume one per-IP slot for an OAuth-minted coach account. Throws the
   * throttler's own 429 when the hourly ceiling is exceeded, and keeps
   * rejecting for the rest of the window (positive block duration). Never
   * reset by a successful login. FAILS CLOSED: a storage error (Redis down,
   * adapter error) refuses the coach creation with 503 instead of minting an
   * account — the production fail-open wrapper is bypassed via
   * `incrementStrict`. A missing IP shares one `unknown` bucket rather than
   * skipping the ceiling. No storage at all (throttler module absent in a
   * unit harness) means no limit, same as the guard itself.
   */
  async consumeOAuthCoachSignupSlot(ip: string | null | undefined): Promise<void> {
    if (!this.storage) return;
    const limit = resolveOAuthCoachSignupPerHour();
    const key = oauthCoachSignupKey(ip);
    let rec: { totalHits: number; isBlocked: boolean };
    try {
      rec = await strictIncrementFor(this.storage)(
        key,
        OAUTH_COACH_SIGNUP_TTL_MS,
        limit,
        OAUTH_COACH_SIGNUP_BLOCK_MS,
        OAUTH_COACH_SIGNUP_THROTTLER,
      );
    } catch (err) {
      this.logger.warn(
        `oauth coach signup ceiling unavailable for ${key} (fail closed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException({
        code: 'coach_signup_temporarily_unavailable',
        message: 'Coach sign-up is temporarily unavailable. Please try again shortly.',
      });
    }
    if (rec.isBlocked || rec.totalHits > limit) {
      this.logger.warn(
        `oauth coach signup ceiling hit for ${key} (${rec.totalHits}/${limit} per hour)`,
      );
      throw new ThrottlerException();
    }
  }

  private unavailable(op: string, err: unknown): ServiceUnavailableException {
    this.logger.warn(
      `login throttle ${op} unavailable (fail closed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return new ServiceUnavailableException({
      code: 'login_temporarily_unavailable',
      message: 'Sign-in is temporarily unavailable. Please try again shortly.',
    });
  }

  /** 429 when this account is locked by repeated password failures (checked BEFORE the password). */
  async assertAccountNotLocked(email: string): Promise<void> {
    if (!this.storage) return;
    const { key, name } = accountFailureBucket(email);
    let blocked: boolean;
    try {
      blocked = await blockedCheckFor(this.storage)(key, name);
    } catch (err) {
      throw this.unavailable('lock check', err);
    }
    if (blocked) throw new ThrottlerException();
  }

  /** Count one failed password attempt for this account; locks it at the limit. */
  async recordAccountFailure(email: string): Promise<void> {
    if (!this.storage) return;
    const { key, name } = accountFailureBucket(email);
    try {
      await strictIncrementFor(this.storage)(
        key,
        AUTH_LOGIN_ACCOUNT_WINDOW_MS,
        // Both adapters block when hits EXCEED the limit; limit-1 makes the
        // Nth failure the one that locks, so attempt N+1 is refused up front.
        resolveAccountFailureLimit() - 1,
        AUTH_LOGIN_ACCOUNT_LOCK_MS,
        name,
      );
    } catch (err) {
      throw this.unavailable('failure record', err);
    }
  }

  /**
   * After a SUCCESSFUL password sign-in: clear that account's own failure
   * counter — nothing else. Per-IP limits and other accounts are untouched.
   * A reset error is logged and swallowed (sign-in already succeeded; the
   * counter simply decays) — it never falls back to an increment.
   */
  async clearAccountFailures(email: string): Promise<void> {
    if (!this.storage) return;
    const { key, name } = accountFailureBucket(email);
    try {
      await resetFor(this.storage)(key, name);
    } catch (err) {
      this.logger.warn(
        `could not clear account failure counter (left to decay): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
