/**
 * Extended sentry-config tests — exercises release precedence permutations,
 * sample-rate clamping boundaries, header stripping idempotency, and the
 * tags block under the no-release path. Complements sentry-config.spec.ts.
 */

jest.mock('@sentry/node', () => ({ init: jest.fn() }));

import {
  buildSentryOptions,
  resolveRelease,
  resolveTracesSampleRate,
  stripSensitiveHeaders,
  SENTRY_SERVICE_NAME,
} from '../../src/observability/sentry-config';

describe('resolveRelease precedence', () => {
  it('SENTRY_RELEASE beats GIT_SHA and RELEASE_VERSION', () => {
    const env = {
      SENTRY_RELEASE: 'explicit-release',
      GIT_SHA: 'sha',
      RELEASE_VERSION: 'v1',
    } as NodeJS.ProcessEnv;
    expect(resolveRelease(env)).toBe('explicit-release');
  });

  it('GIT_SHA beats RELEASE_VERSION', () => {
    const env = { GIT_SHA: 'sha', RELEASE_VERSION: 'v1', NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(resolveRelease(env)).toBe(`${SENTRY_SERVICE_NAME}@sha-production`);
  });

  it('ignores empty-string SENTRY_RELEASE and falls through', () => {
    const env = { SENTRY_RELEASE: '', GIT_SHA: 'sha', NODE_ENV: 'staging' } as NodeJS.ProcessEnv;
    expect(resolveRelease(env)).toBe(`${SENTRY_SERVICE_NAME}@sha-staging`);
  });

  it('defaults the environment portion to production when NODE_ENV unset', () => {
    const env = { GIT_SHA: 'sha' } as NodeJS.ProcessEnv;
    expect(resolveRelease(env)).toBe(`${SENTRY_SERVICE_NAME}@sha-production`);
  });
});

describe('resolveTracesSampleRate boundaries', () => {
  it('clamps a negative rate to 0', () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '-1' } as NodeJS.ProcessEnv)).toBe(0);
  });
  it('accepts exactly 0', () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '0' } as NodeJS.ProcessEnv)).toBe(0);
  });
  it('accepts exactly 1', () => {
    expect(resolveTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: '1' } as NodeJS.ProcessEnv)).toBe(1);
  });
  it('defaults to 0.1 when unset', () => {
    expect(resolveTracesSampleRate({} as NodeJS.ProcessEnv)).toBe(0.1);
  });
});

describe('stripSensitiveHeaders', () => {
  it('is a no-op when there is no request on the event', () => {
    const event = {} as Parameters<typeof stripSensitiveHeaders>[0];
    expect(() => stripSensitiveHeaders(event)).not.toThrow();
  });

  it('is idempotent when run twice', () => {
    const event = {
      request: { headers: { authorization: 'Bearer x', 'x-keep': '1' } },
    } as unknown as Parameters<typeof stripSensitiveHeaders>[0];
    stripSensitiveHeaders(event);
    stripSensitiveHeaders(event);
    const headers = event.request?.headers as Record<string, unknown>;
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-keep']).toBe('1');
  });
});

describe('buildSentryOptions tags block', () => {
  it('omits the release tag when no release is resolvable', () => {
    const opts = buildSentryOptions('https://dsn@o/1', { NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const tags = (opts.initialScope as { tags: Record<string, string> }).tags;
    expect(tags.release).toBeUndefined();
    expect(tags.service).toBe(SENTRY_SERVICE_NAME);
    expect(tags.runtime).toBe('node');
    expect(tags.environment).toBe('test');
    expect(opts.release).toBeUndefined();
  });

  it('carries the resolved traces sample rate', () => {
    const opts = buildSentryOptions('https://dsn@o/1', {
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
    } as NodeJS.ProcessEnv);
    expect(opts.tracesSampleRate).toBe(0.25);
  });
});
