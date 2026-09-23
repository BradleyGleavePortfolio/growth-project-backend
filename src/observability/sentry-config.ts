import { ORM_ERROR_NAME, safeDiagnostic } from './orm-diagnostics';
import * as Sentry from '@sentry/node';

/**
 * sentry-config — Sentry init options factored out of `src/instrument.ts` so
 * release/environment/tags logic is unit-testable without global side effects.
 * Release precedence: SENTRY_RELEASE → GIT_SHA → RELEASE_VERSION → unset.
 */

/** Service identifier used in the release name and the `service` tag. */
export const SENTRY_SERVICE_NAME = 'growth-project-backend';

/** Resolve the effective environment string. */
export function resolveEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV || 'production';
}

/** Resolve the release id: SENTRY_RELEASE, else `<service>@<sha>-<env>` from
 * GIT_SHA/RELEASE_VERSION, else undefined. */
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

/** Build the Sentry init options from the environment. Pure (no side effects). */
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
    beforeSend(event, hint) {
      const original = hint.originalException;
      if (
        safeDiagnostic(original) !== original ||
        event.exception?.values?.some((item) => ORM_ERROR_NAME.test(item.type ?? ''))
      ) {
        // Allowlist the diagnostic envelope; never forward request bodies,
        // breadcrumbs, frame locals, contexts or extras from an ORM failure.
        return {
          type: undefined,
          event_id: event.event_id,
          timestamp: event.timestamp,
          environment: event.environment,
          release: event.release,
          level: event.level,
          tags: { request_id: event.tags?.request_id },
          exception: {
            values: [{ type: 'DatabaseRequestError', value: 'Database request failed' }],
          },
        };
      }
      // Default SDK integrations add concrete URLs, queries and headers after
      // the HTTP filter has selected a safe route template. Do not forward
      // that automatic metadata (including duplicate copies in transaction
      // names, breadcrumbs or contexts). Keep application-owned correlation
      // and ordinary exception diagnostics. This is an error-event metadata
      // boundary, not a sanitizer for arbitrary exception text or trace spans.
      const tags: NonNullable<Sentry.ErrorEvent['tags']> = {};
      for (const key of [
        'request_id',
        'http.method',
        'http.path',
        'service',
        'runtime',
        'environment',
        'release',
      ]) {
        if (event.tags?.[key] !== undefined) tags[key] = event.tags[key];
      }
      return {
        type: undefined,
        event_id: event.event_id,
        timestamp: event.timestamp,
        environment: event.environment,
        release: event.release,
        level: event.level,
        platform: event.platform,
        exception: event.exception,
        message: event.message,
        logentry: event.logentry,
        tags,
      };
    },
  };
}

/**
 * Initialise Sentry. No-op (returns false) when `SENTRY_DSN` is unset so dev/test
 * need no DSN; returns true when actually initialised.
 */
export function initSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN;
  if (!dsn || dsn.length === 0) {
    return false;
  }
  Sentry.init(buildSentryOptions(dsn, env));
  return true;
}
