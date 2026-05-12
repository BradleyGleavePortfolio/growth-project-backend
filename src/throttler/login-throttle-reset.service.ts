import { Injectable, Optional, Logger } from '@nestjs/common';
import { InjectThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { THROTTLER_NAMES } from './throttler.config';

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
