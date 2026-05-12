import 'reflect-metadata';
import { AuthController } from '../src/auth/auth.controller';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import {
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
  buildThrottlerOptions,
} from '../src/throttler/throttler.config';

// Tests for the Redis-backed throttler and named-throttler config.
// Three things must hold:
//
//   1. The named throttlers carry the documented limits, and the @Throttle
//      metadata on the auth controller routes reaches the runtime under
//      those names.
//   2. UserThrottlerGuard's getTracker returns `user:<id>` for
//      authenticated requests and `ip:<addr>` for unauthenticated ones.
//   3. buildThrottlerOptions falls back to in-memory tracking when
//      REDIS_URL is unset (no `storage` key on the returned options).

describe('throttler.config -- named limits', () => {
  it('exposes the documented named throttlers with the correct ttl/limit', () => {
    const byName = Object.fromEntries(THROTTLER_LIMITS.map((t) => [t.name, t]));
    expect(byName[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]).toMatchObject({
      ttl: 60_000,
      limit: 5,
    });
    expect(byName[THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]).toMatchObject({
      ttl: 3_600_000,
      limit: 30,
    });
    expect(byName[THROTTLER_NAMES.AUTH_SIGNUP]).toMatchObject({
      ttl: 3_600_000,
      limit: 5,
    });
    expect(byName[THROTTLER_NAMES.AUTH_PASSWORD_RESET]).toMatchObject({
      ttl: 3_600_000,
      limit: 3,
    });
    expect(byName[THROTTLER_NAMES.DEFAULT]).toMatchObject({
      ttl: 60_000,
    });
  });
});

describe('AuthController @Throttle metadata routes through named throttlers', () => {
  // @nestjs/throttler v6 stores @Throttle metadata as one Reflect key per
  // (name, field) pair: `THROTTLER:TTL<name>` and `THROTTLER:LIMIT<name>`.
  const KNOWN_NAMES = [
    THROTTLER_NAMES.AUTH_LOGIN_PER_MIN,
    THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR,
    THROTTLER_NAMES.AUTH_SIGNUP,
    THROTTLER_NAMES.AUTH_PASSWORD_RESET,
    THROTTLER_NAMES.DEFAULT,
  ];

  const readThrottle = (
    handler: object,
  ): Record<string, { ttl: number; limit: number }> => {
    const out: Record<string, { ttl: number; limit: number }> = {};
    for (const name of KNOWN_NAMES) {
      const ttl = Reflect.getMetadata(`THROTTLER:TTL${name}`, handler) as number | undefined;
      const limit = Reflect.getMetadata(`THROTTLER:LIMIT${name}`, handler) as number | undefined;
      if (ttl !== undefined || limit !== undefined) {
        out[name] = { ttl: ttl as number, limit: limit as number };
      }
    }
    return out;
  };

  it('uses auth-login-per-min (5/min) on POST /auth/login', () => {
    const meta = readThrottle(AuthController.prototype.login);
    expect(meta).toHaveProperty(THROTTLER_NAMES.AUTH_LOGIN_PER_MIN);
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]).toEqual({ ttl: 60_000, limit: 5 });
  });

  it('uses auth-login-per-hour (30/hr) on POST /auth/login', () => {
    const meta = readThrottle(AuthController.prototype.login);
    expect(meta).toHaveProperty(THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR);
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]).toEqual({ ttl: 3_600_000, limit: 30 });
  });

  it('uses auth-signup (5/hour) on POST /auth/register', () => {
    const meta = readThrottle(AuthController.prototype.register);
    expect(meta).toHaveProperty(THROTTLER_NAMES.AUTH_SIGNUP);
    expect(meta[THROTTLER_NAMES.AUTH_SIGNUP]).toEqual({ ttl: 3_600_000, limit: 5 });
  });

  it('uses auth-signup (5/hour) on POST /auth/signup-with-code', () => {
    const meta = readThrottle(AuthController.prototype.signupWithCode);
    expect(meta).toHaveProperty(THROTTLER_NAMES.AUTH_SIGNUP);
    expect(meta[THROTTLER_NAMES.AUTH_SIGNUP]).toEqual({ ttl: 3_600_000, limit: 5 });
  });

  it('uses auth-password-reset (3/hr) on POST /auth/forgot-password', () => {
    const meta = readThrottle(AuthController.prototype.forgotPassword);
    expect(meta).toHaveProperty(THROTTLER_NAMES.AUTH_PASSWORD_RESET);
    expect(meta[THROTTLER_NAMES.AUTH_PASSWORD_RESET]).toEqual({
      ttl: 3_600_000,
      limit: 3,
    });
  });
});

describe('UserThrottlerGuard.getTracker', () => {
  const buildGuard = (): UserThrottlerGuard => {
    const guard = Object.create(UserThrottlerGuard.prototype) as UserThrottlerGuard;
    return guard;
  };

  const callTracker = async (g: UserThrottlerGuard, req: object) =>
    (g as any).getTracker(req);

  it('keys on user.id when an authenticated user is on the request', async () => {
    const tracker = await callTracker(buildGuard(), {
      user: { id: 'user_abc123' },
      ip: '203.0.113.4',
      headers: {},
    });
    expect(tracker).toBe('user:user_abc123');
  });

  it('falls back to Fly-Client-IP when no user', async () => {
    const tracker = await callTracker(buildGuard(), {
      ip: '10.0.0.1',
      headers: { 'fly-client-ip': '203.0.113.7' },
    });
    expect(tracker).toBe('ip:203.0.113.7');
  });

  it('falls back to x-forwarded-for first hop when no Fly-Client-IP', async () => {
    const tracker = await callTracker(buildGuard(), {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    });
    expect(tracker).toBe('ip:198.51.100.9');
  });

  it('returns ip:unknown when neither user nor any address is available', async () => {
    const tracker = await callTracker(buildGuard(), { headers: {} });
    expect(tracker).toBe('ip:unknown');
  });

  it('treats user.id="" as unauthenticated and falls back to IP', async () => {
    const tracker = await callTracker(buildGuard(), {
      user: { id: '' },
      ip: '203.0.113.42',
      headers: {},
    });
    expect(tracker).toBe('ip:203.0.113.42');
  });
});

describe('buildThrottlerOptions REDIS_URL fallback', () => {
  it('returns in-memory options (no storage key) when REDIS_URL is unset', async () => {
    const opts = await buildThrottlerOptions(undefined);
    expect(opts).toHaveProperty('throttlers');
    expect((opts as any).storage).toBeUndefined();
    const names = ((opts as any).throttlers as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        THROTTLER_NAMES.AUTH_LOGIN_PER_MIN,
        THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR,
        THROTTLER_NAMES.AUTH_SIGNUP,
        THROTTLER_NAMES.AUTH_PASSWORD_RESET,
        THROTTLER_NAMES.DEFAULT,
      ]),
    );
  });

  it('returns in-memory options for whitespace-only REDIS_URL (treated as unset)', async () => {
    const opts = await buildThrottlerOptions('   ');
    expect((opts as any).storage).toBeUndefined();
  });
});
