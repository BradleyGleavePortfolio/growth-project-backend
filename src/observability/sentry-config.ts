import * as Sentry from '@sentry/node';

/**
 * sentry-config — single source of truth for the Sentry initialisation
 * options, factored out of `src/instrument.ts` so the release/environment/tags
 * logic is unit-testable without invoking Sentry's global side effects.
 *
 * Release tagging (H3):
 *   - `SENTRY_RELEASE` (CI-injected, preferred) takes priority. CI sets it to
 *     `growth-project-backend@<commit-sha>-<environment>`.
 *   - Falls back to the legacy `GIT_SHA` then `RELEASE_VERSION` for backwards
 *     compatibility with the existing source-map upload pipeline.
 *   - When none are set the release is left undefined so Sentry buckets events
 *     under "no release" rather than a misleading default.
 *
 * A `tags` block stamps every event with the service name, runtime, and
 * resolved environment so events can be filtered in the Sentry UI without a
 * search expression.
 */

/** Service identifier used in the release name and the `service` tag. */
export const SENTRY_SERVICE_NAME = 'growth-project-backend';

/** Resolve the effective environment string. */
export function resolveEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV || 'production';
}

/**
 * Resolve the release identifier. Prefers the CI-injected `SENTRY_RELEASE`;
 * otherwise composes `growth-project-backend@<sha>-<env>` from `GIT_SHA` /
 * `RELEASE_VERSION` when one is present; otherwise undefined.
 */
export function resolveRelease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SENTRY_RELEASE && env.SENTRY_RELEASE.length > 0) {
    return env.SENTRY_RELEASE;
  }
  const sha = env.GIT_SHA || env.RELEASE_VERSION;
  if (sha && sha.length > 0) {
    return `${SENTRY_SERVICE_NAME}@${sha}-${resolveEnvironment(env)}`;
  }
  return undefined;
}

/** Clamp the traces sample rate into [0,1], defaulting to 0.1. */
export function resolveTracesSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseFloat(env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1');
  if (Number.isNaN(parsed)) {
    return 0.1;
  }
  return Math.min(1, Math.max(0, parsed));
}

/** Strip PII headers from an outbound Sentry event in place. */
export function stripSensitiveHeaders(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const headers = event.request?.headers as Record<string, unknown> | undefined;
  if (headers) {
    delete headers.authorization;
    delete headers.Authorization;
    delete headers.cookie;
    delete headers.Cookie;
  }
  return event;
}

/**
 * Build the full Sentry init options object from the environment. Pure — no
 * side effects — so it can be asserted directly in unit tests.
 */
export function buildSentryOptions(
  dsn: string,
  env: NodeJS.ProcessEnv = process.env,
): Sentry.NodeOptions {
  const environment = resolveEnvironment(env);
  const release = resolveRelease(env);
  return {
    dsn,
    environment,
    release,
    tracesSampleRate: resolveTracesSampleRate(env),
    initialScope: {
      tags: {
        service: SENTRY_SERVICE_NAME,
        runtime: 'node',
        environment,
        ...(release ? { release } : {}),
      },
    },
    beforeSend(event) {
      return stripSensitiveHeaders(event);
    },
  };
}

/**
 * Initialise Sentry. No-op when `SENTRY_DSN` is unset so local/dev boots and
 * the test suite do not require a DSN. Returns true when Sentry was actually
 * initialised, false when skipped.
 */
export function initSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN;
  if (!dsn || dsn.length === 0) {
    return false;
  }
  Sentry.init(buildSentryOptions(dsn, env));
  return true;
}
