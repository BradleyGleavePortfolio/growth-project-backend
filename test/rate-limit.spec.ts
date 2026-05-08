import 'reflect-metadata';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import {
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
  buildThrottlerOptions,
} from '../src/throttler/throttler.config';
import { AuthController } from '../src/auth/auth.controller';
import { CoachMessagingController } from '../src/messaging/coach-messaging.controller';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { ThrottlerExceptionFilter } from '../src/filters/throttler-exception.filter';
import { ThrottlerException } from '@nestjs/throttler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the @Throttle metadata stored on a controller handler method by
 * @nestjs/throttler v6. v6 stores each named throttler as two Reflect keys:
 *   `THROTTLER:TTL<name>` and `THROTTLER:LIMIT<name>`
 * Returns a flat map of { [throttlerName]: { ttl, limit } }.
 */
function readThrottleMetadata(
  handler: object,
): Record<string, { ttl: number; limit: number }> {
  const out: Record<string, { ttl: number; limit: number }> = {};
  for (const t of THROTTLER_LIMITS) {
    const ttl = Reflect.getMetadata(`THROTTLER:TTL${t.name}`, handler) as number | undefined;
    const limit = Reflect.getMetadata(`THROTTLER:LIMIT${t.name}`, handler) as number | undefined;
    if (ttl !== undefined || limit !== undefined) {
      out[t.name] = { ttl: ttl as number, limit: limit as number };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Named throttler table -- limits must match spec
// ---------------------------------------------------------------------------

describe('throttler.config -- named limit table', () => {
  const byName = Object.fromEntries(THROTTLER_LIMITS.map((t) => [t.name, t]));

  it('has auth-login-per-min: 5/min default', () => {
    expect(byName[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]).toMatchObject({
      ttl: 60_000,
      limit: 5,
    });
  });

  it('has auth-login-per-hour: 30/hour default', () => {
    expect(byName[THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]).toMatchObject({
      ttl: 3_600_000,
      limit: 30,
    });
  });

  it('has auth-password-reset: 3/hour default', () => {
    expect(byName[THROTTLER_NAMES.AUTH_PASSWORD_RESET]).toMatchObject({
      ttl: 3_600_000,
      limit: 3,
    });
  });

  it('has auth-signup: 5/hour', () => {
    expect(byName[THROTTLER_NAMES.AUTH_SIGNUP]).toMatchObject({
      ttl: 3_600_000,
      limit: 5,
    });
  });

  it('has coach-messages: 30/min default', () => {
    expect(byName[THROTTLER_NAMES.COACH_MESSAGES]).toMatchObject({
      ttl: 60_000,
      limit: 30,
    });
  });

  it('has notifications-prefs: 30/min default', () => {
    expect(byName[THROTTLER_NAMES.NOTIFICATIONS_PREFS]).toMatchObject({
      ttl: 60_000,
      limit: 30,
    });
  });

  it('has bloodwork-write: 30/min default', () => {
    expect(byName[THROTTLER_NAMES.BLOODWORK_WRITE]).toMatchObject({
      ttl: 60_000,
      limit: 30,
    });
  });

  it('has coach-command-center: 60/min default', () => {
    expect(byName[THROTTLER_NAMES.COACH_COMMAND_CENTER]).toMatchObject({
      ttl: 60_000,
      limit: 60,
    });
  });

  it('has diagnostic-submit: 5/hour default', () => {
    expect(byName[THROTTLER_NAMES.DIAGNOSTIC_SUBMIT]).toMatchObject({
      ttl: 3_600_000,
      limit: 5,
    });
  });

  it('has a default catch-all throttler with limit >= 100', () => {
    expect(byName[THROTTLER_NAMES.DEFAULT]).toBeDefined();
    expect(byName[THROTTLER_NAMES.DEFAULT].ttl).toBe(60_000);
    expect(byName[THROTTLER_NAMES.DEFAULT].limit).toBeGreaterThanOrEqual(100);
  });

  it('auth-login-per-hour is tighter on a rate-per-second basis than auth-login-per-min', () => {
    const perMin  = byName[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN];
    const perHour = byName[THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR];
    const rpsMin  = perMin.limit  / (perMin.ttl  / 1000);
    const rpsHour = perHour.limit / (perHour.ttl / 1000);
    expect(rpsHour).toBeLessThan(rpsMin);
  });
});

// ---------------------------------------------------------------------------
// 2. Auth controller -- @Throttle metadata on each handler
// ---------------------------------------------------------------------------

describe('AuthController @Throttle metadata', () => {
  it('POST /auth/login uses auth-login-per-min (5/min)', () => {
    const meta = readThrottleMetadata(AuthController.prototype.login);
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]).toEqual({ ttl: 60_000, limit: 5 });
  });

  it('POST /auth/login uses auth-login-per-hour (30/hr)', () => {
    const meta = readThrottleMetadata(AuthController.prototype.login);
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]).toEqual({ ttl: 3_600_000, limit: 30 });
  });

  it('POST /auth/apple uses auth-login-per-min AND auth-login-per-hour', () => {
    const meta = readThrottleMetadata(AuthController.prototype.appleAuth);
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]).toEqual({ ttl: 60_000, limit: 5 });
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]).toEqual({ ttl: 3_600_000, limit: 30 });
  });

  it('POST /auth/google uses auth-login-per-min AND auth-login-per-hour', () => {
    const meta = readThrottleMetadata(AuthController.prototype.googleAuth);
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN]).toEqual({ ttl: 60_000, limit: 5 });
    expect(meta[THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR]).toEqual({ ttl: 3_600_000, limit: 30 });
  });

  it('POST /auth/forgot-password uses auth-password-reset (3/hr)', () => {
    const meta = readThrottleMetadata(AuthController.prototype.forgotPassword);
    expect(meta[THROTTLER_NAMES.AUTH_PASSWORD_RESET]).toEqual({
      ttl: 3_600_000,
      limit: 3,
    });
  });

  it('POST /auth/register uses auth-signup (5/hr)', () => {
    const meta = readThrottleMetadata(AuthController.prototype.register);
    expect(meta[THROTTLER_NAMES.AUTH_SIGNUP]).toEqual({ ttl: 3_600_000, limit: 5 });
  });

  it('POST /auth/signup-with-code uses auth-signup (5/hr)', () => {
    const meta = readThrottleMetadata(AuthController.prototype.signupWithCode);
    expect(meta[THROTTLER_NAMES.AUTH_SIGNUP]).toEqual({ ttl: 3_600_000, limit: 5 });
  });

  it('auth-login-per-min is tighter than the default bucket', () => {
    const loginMeta   = readThrottleMetadata(AuthController.prototype.login);
    const loginLimit  = loginMeta[THROTTLER_NAMES.AUTH_LOGIN_PER_MIN];
    const defaultBucket = THROTTLER_LIMITS.find((t) => t.name === THROTTLER_NAMES.DEFAULT)!;
    const loginRps   = loginLimit.limit / (loginLimit.ttl / 1000);
    const defaultRps = defaultBucket.limit / (defaultBucket.ttl / 1000);
    expect(loginRps).toBeLessThan(defaultRps);
  });
});

// ---------------------------------------------------------------------------
// 3. Coach messaging -- @Throttle metadata
// ---------------------------------------------------------------------------

describe('CoachMessagingController @Throttle metadata', () => {
  it('POST /coach/clients/:id/messages uses coach-messages (30/min)', () => {
    const meta = readThrottleMetadata(CoachMessagingController.prototype.send);
    expect(meta[THROTTLER_NAMES.COACH_MESSAGES]).toEqual({ ttl: 60_000, limit: 30 });
  });
});

// ---------------------------------------------------------------------------
// 4. Notifications -- @Throttle metadata
// ---------------------------------------------------------------------------

describe('NotificationsController @Throttle metadata', () => {
  it('PUT /notifications/preferences uses notifications-prefs (30/min)', () => {
    const meta = readThrottleMetadata(NotificationsController.prototype.updatePreferences);
    expect(meta[THROTTLER_NAMES.NOTIFICATIONS_PREFS]).toEqual({ ttl: 60_000, limit: 30 });
  });

  it('GET /notifications/preferences carries no explicit throttle (falls through to default)', () => {
    const meta = readThrottleMetadata(NotificationsController.prototype.getPreferences);
    expect(Object.keys(meta).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. UserThrottlerGuard -- tracker key resolution
// ---------------------------------------------------------------------------

describe('UserThrottlerGuard.getTracker', () => {
  const buildGuard = (): UserThrottlerGuard =>
    Object.create(UserThrottlerGuard.prototype) as UserThrottlerGuard;
  const callTracker = (g: UserThrottlerGuard, req: object) =>
    (g as any).getTracker(req) as Promise<string>;

  it('keys on user.id when an authenticated user is on the request', async () => {
    expect(await callTracker(buildGuard(), { user: { id: 'user_abc' }, ip: '1.2.3.4', headers: {} }))
      .toBe('user:user_abc');
  });

  it('falls back to Fly-Client-IP when no user', async () => {
    expect(await callTracker(buildGuard(), {
      ip: '10.0.0.1',
      headers: { 'fly-client-ip': '203.0.113.7' },
    })).toBe('ip:203.0.113.7');
  });

  it('falls back to first hop of X-Forwarded-For when no Fly-Client-IP', async () => {
    expect(await callTracker(buildGuard(), {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    })).toBe('ip:198.51.100.9');
  });

  it('falls back to req.ip when no proxy headers', async () => {
    expect(await callTracker(buildGuard(), { ip: '203.0.113.42', headers: {} }))
      .toBe('ip:203.0.113.42');
  });

  it('returns ip:unknown when no address is available', async () => {
    expect(await callTracker(buildGuard(), { headers: {} }))
      .toBe('ip:unknown');
  });

  it('treats user.id="" as unauthenticated and falls back to IP', async () => {
    expect(await callTracker(buildGuard(), {
      user: { id: '' },
      ip: '203.0.113.42',
      headers: {},
    })).toBe('ip:203.0.113.42');
  });

  it('prefers Fly-Client-IP over X-Forwarded-For', async () => {
    expect(await callTracker(buildGuard(), {
      ip: '10.0.0.1',
      headers: {
        'fly-client-ip': '203.0.113.1',
        'x-forwarded-for': '198.51.100.9, 10.0.0.1',
      },
    })).toBe('ip:203.0.113.1');
  });
});

// ---------------------------------------------------------------------------
// 6. ThrottlerExceptionFilter -- 429 response shape + Retry-After
// ---------------------------------------------------------------------------

describe('ThrottlerExceptionFilter -- 429 response shape', () => {
  it('returns statusCode 429 with Retry-After header and retryAfter body field', () => {
    const filter = new ThrottlerExceptionFilter();
    const responseObj: Record<string, unknown> = {};
    let statusCode = 0;
    const setHeader: Record<string, string> = {};

    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (code: number) => {
            statusCode = code;
            return {
              set: (key: string, value: string) => {
                setHeader[key] = value;
                return {
                  json: (body: unknown) => {
                    Object.assign(responseObj, body as object);
                  },
                };
              },
            };
          },
        }),
      }),
    };

    filter.catch(new ThrottlerException(), mockHost as any);

    expect(statusCode).toBe(429);
    expect(setHeader['Retry-After']).toBeDefined();
    const retryAfterSeconds = parseInt(setHeader['Retry-After'], 10);
    expect(Number.isFinite(retryAfterSeconds)).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(0);

    expect(responseObj).toMatchObject({
      statusCode: 429,
      error: 'Too Many Requests',
      message: expect.any(String),
      retryAfter: expect.any(Number),
    });

    expect(responseObj['retryAfter']).toBe(retryAfterSeconds);
  });

  it('does not expose internal limit details in the body', () => {
    const filter = new ThrottlerExceptionFilter();
    let capturedBody: unknown;

    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({
          status: () => ({
            set: () => ({
              json: (b: unknown) => {
                capturedBody = b;
              },
            }),
          }),
        }),
      }),
    };

    filter.catch(new ThrottlerException(), mockHost as any);

    const body = capturedBody as Record<string, unknown>;
    const bodyStr = JSON.stringify(body).toLowerCase();
    expect(bodyStr).not.toContain('auth-login');
    expect(bodyStr).not.toContain('throttler_name');
    expect(bodyStr).not.toContain('"limit"');
  });
});

// ---------------------------------------------------------------------------
// 7. APP_GUARD wiring -- UserThrottlerGuard is registered globally
// ---------------------------------------------------------------------------

describe('AppModule -- UserThrottlerGuard is registered as APP_GUARD', () => {
  it('registers UserThrottlerGuard as APP_GUARD (global throttling)', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    const guardProvider = providers.find(
      (p) =>
        p &&
        typeof p === 'object' &&
        p.provide === APP_GUARD &&
        p.useClass === UserThrottlerGuard,
    );
    expect(guardProvider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. buildThrottlerOptions -- Redis / in-memory fallback
// ---------------------------------------------------------------------------

describe('buildThrottlerOptions -- storage fallback', () => {
  it('returns in-memory options (no storage key) when REDIS_URL is unset', async () => {
    const opts = await buildThrottlerOptions(undefined);
    expect(opts).toHaveProperty('throttlers');
    expect((opts as any).storage).toBeUndefined();
  });

  it('returns in-memory options for whitespace-only REDIS_URL', async () => {
    const opts = await buildThrottlerOptions('   ');
    expect((opts as any).storage).toBeUndefined();
  });

  it('all named throttlers are present in the returned options', async () => {
    const opts = await buildThrottlerOptions(undefined);
    const names = ((opts as any).throttlers as { name: string }[]).map((t) => t.name);
    for (const name of Object.values(THROTTLER_NAMES)) {
      expect(names).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. THROTTLER_NAMES completeness
// ---------------------------------------------------------------------------

describe('THROTTLER_NAMES constant completeness', () => {
  it('all constant values are unique (no duplicate throttler names)', () => {
    const names = Object.values(THROTTLER_NAMES);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('THROTTLER_LIMITS has an entry for every THROTTLER_NAMES value', () => {
    const limitNames = new Set(THROTTLER_LIMITS.map((t) => t.name));
    for (const name of Object.values(THROTTLER_NAMES)) {
      expect(limitNames.has(name)).toBe(true);
    }
  });
});
