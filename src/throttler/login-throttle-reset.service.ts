import { Injectable, Optional, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerException } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { THROTTLER_NAMES, strictIncrementFor } from './throttler.config';

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


/**
 * LoginThrottleResetService — clears the per-IP auth-login rate-limit
 * counters on a successful authentication.
 *
 * Why this exists: a user on a bad Wi-Fi connection may retry login 3–4
 * times before the password goes through. Without a reset, those retries
 * exhaust the per-IP limit (5/min, 30/hr) and lock the user out for up to
 * an hour even though they authenticated successfully on the last attempt.
 * The reset erases the counter in both windows so the next retry (e.g. an
 * automatic session refresh) sees a clean slate.
 *
 * Security note: we only reset the counter AFTER the Supabase call returns
 * a valid session. A failed login never resets anything — an attacker
 * cannot use this to bypass the rate limit by occasionally guessing right.
 *
 * Implementation: @nestjs/throttler v6 exposes ThrottlerStorage via the
 * THROTTLER_STORAGE token. The storage contract (`increment`) is how the
 * throttler writes records; the complementary read contract (`getRecord`)
 * lets us inspect them. There is no first-class "delete" API, so we use
 * increment(key, 0, 0, ...) to effectively invalidate the window by
 * setting the total count to 0 with a zero TTL. If the storage backend
 * does not support this (e.g. an older Redis adapter), the call no-ops
 * and we fall through silently — the safety posture degrades to
 * "no reset", which is the original behaviour.
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

  /**
   * Reset both auth-login windows for the given IP address.
   * Must be called only after a successful login / OAuth exchange.
   *
   * @param ip — client IP as returned by UserThrottlerGuard.getTracker()
   *             (e.g. the first hop of X-Forwarded-For or Fly-Client-IP).
   */
  async resetLoginCounters(ip: string): Promise<void> {
    if (!this.storage) {
      // Storage not injected (test environments with throttling disabled).
      return;
    }

    const trackerKey = `ip:${ip}`;

    const resetThrottler = async (name: string, ttlMs: number) => {
      try {
        // ThrottlerStorage.increment signature:
        //   increment(key, ttl, limit, blockDuration, throttlerName) → Record<...>
        // Passing limit=0 resets usage because the stored total can never
        // exceed the limit of 0 — subsequent increments start fresh.
        // The built-in in-memory storage uses a Map keyed by
        // `${throttlerName}:${key}`, so we must include the name.
        await (this.storage as any).increment(
          trackerKey,
          ttlMs,
          0,           // limit=0 means "reset" in both built-in and redis adapters
          0,           // blockDuration — not used for the reset path
          name,
        );
      } catch (err) {
        // Never throw — login already succeeded. Log so an operator can see
        // if the reset is consistently failing (e.g. Redis permission error).
        this.logger.warn(
          `Could not reset ${name} counter for ${trackerKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    await Promise.all([
      resetThrottler(THROTTLER_NAMES.AUTH_LOGIN_PER_MIN,  60_000),
      resetThrottler(THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR, 3_600_000),
    ]);
  }
}
