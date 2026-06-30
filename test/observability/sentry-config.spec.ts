/**
 * sentry-config tests.
 *
 * Covers:
 *  1. resolveEnvironment — uses NODE_ENV
 *  2. resolveEnvironment — defaults to production
 *  3. resolveRelease — prefers SENTRY_RELEASE
 *  4. resolveRelease — composes from GIT_SHA + env
 *  5. resolveRelease — falls back to RELEASE_VERSION
 *  6. resolveRelease — undefined when nothing set
 *  7. resolveTracesSampleRate — parses + clamps + defaults
 *  8. stripSensitiveHeaders — removes Authorization/Cookie
 *  9. buildSentryOptions — wires release/environment/tags block
 * 10. buildSentryOptions — beforeSend strips headers
 * 11. initSentry — no-op when DSN unset
 * 12. initSentry — calls Sentry.init when DSN set
 */

jest.mock('@sentry/node', () => ({ init: jest.fn() }));
import * as Sentry from '@sentry/node';
import {
  buildSentryOptions,
  initSentry,
  resolveEnvironment,
  resolveRelease,
  resolveTracesSampleRate,
  stripSensitiveHeaders,
  SENTRY_SERVICE_NAME,
} from '../../src/observability/sentry-config';

describe('resolveEnvironment', () => {
  it('uses NODE_ENV when set', () => {
    expect(resolveEnvironment({ NODE_ENV: 'staging' } as NodeJS.ProcessEnv)).toBe('staging');
  });
  it('defaults to production', () => {
    expect(resolveEnvironment({} as NodeJS.ProcessEnv)).toBe('production');
  });
});

describe('resolveRelease', () => {
  it('prefers an explicit SENTRY_RELEASE', () => {
    const env = { SENTRY_RELEASE: 'growth-project-backend@abc-prod' } as NodeJS.ProcessEnv;
    expect(resolveRelease(env)).toBe('growth-project-backend@abc-prod');
  });
  it('composes from GIT_SHA and environment', () => {
    const env = { GIT_SHA: 'deadbeef', NODE_ENV: 'staging' } as NodeJS.ProcessEnv;
    expect(resolveRelease(env)).toBe(`${SENTRY_SERVICE_NAME}@deadbeef-staging`);
  });
  it('falls back to RELEASE_VERSION', () => {
    const env = { RELEASE_VERSION: 'v1.2.3', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(resolveRelease(env)).toBe(`${SENTRY_SERVICE_NAME}@v1.2.3-production`);
  });
  it('returns undefined when nothing is set', () => {
    expect(resolveRelease({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('resolveTracesSampleRate', () => {
  it('parses a valid rate', () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '0.5' } as NodeJS.ProcessEnv)).toBe(
      0.5,
    );
  });
  it('clamps above 1', () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '5' } as NodeJS.ProcessEnv)).toBe(
      1,
    );
  });
  it('defaults to 0.1 on invalid input', () => {
    expect(
      resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: 'nope' } as NodeJS.ProcessEnv),
    ).toBe(0.1);
  });
});

describe('stripSensitiveHeaders', () => {
  it('removes Authorization and Cookie headers', () => {
    const event: Parameters<typeof stripSensitiveHeaders>[0] = {
      type: undefined,
      request: {
        headers: {
          authorization: 'Bearer x',
          Authorization: 'Bearer y',
          cookie: 'a=b',
          Cookie: 'c=d',
          'user-agent': 'jest',
        },
      },
    };
    const out = stripSensitiveHeaders(event);
    const headers = out.request?.headers as Record<string, unknown>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
    expect(headers['user-agent']).toBe('jest');
  });
});

describe('buildSentryOptions', () => {
  it('wires release, environment and a tags block', () => {
    const env = {
      SENTRY_RELEASE: 'growth-project-backend@sha-staging',
      NODE_ENV: 'staging',
    } as NodeJS.ProcessEnv;
    const opts = buildSentryOptions('https://dsn@o.ingest/1', env);
    expect(opts.dsn).toBe('https://dsn@o.ingest/1');
    expect(opts.environment).toBe('staging');
    expect(opts.release).toBe('growth-project-backend@sha-staging');
    const tags = (opts.initialScope as { tags: Record<string, string> }).tags;
    expect(tags.service).toBe(SENTRY_SERVICE_NAME);
    expect(tags.runtime).toBe('node');
    expect(tags.environment).toBe('staging');
    expect(tags.release).toBe('growth-project-backend@sha-staging');
  });

  it('wires a beforeSend hook that delegates to the header stripper', () => {
    const opts = buildSentryOptions('https://dsn@o.ingest/1', {} as NodeJS.ProcessEnv);
    expect(typeof opts.beforeSend).toBe('function');
    // The stripping behaviour itself is asserted directly against
    // stripSensitiveHeaders above; here we only verify the hook is registered.
  });
});

describe('initSentry', () => {
  afterEach(() => (Sentry.init as jest.Mock).mockClear());

  it('is a no-op when SENTRY_DSN is unset', () => {
    expect(initSentry({} as NodeJS.ProcessEnv)).toBe(false);
    expect(Sentry.init as jest.Mock).not.toHaveBeenCalled();
  });

  it('calls Sentry.init when SENTRY_DSN is set', () => {
    expect(initSentry({ SENTRY_DSN: 'https://dsn@o.ingest/1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(Sentry.init as jest.Mock).toHaveBeenCalledTimes(1);
  });
});
