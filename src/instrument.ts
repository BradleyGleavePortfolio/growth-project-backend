// Sentry initialisation — must be imported BEFORE any other application
// module so its instrumentation hooks attach to Node's `http`/`fs`/etc. The
// import order is enforced in main.ts (this is the very first import).
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  // OBSERVABILITY (Phase 10): tracesSampleRate is now configurable via the
  // SENTRY_TRACES_SAMPLE_RATE env var (default 0.1 = 10%).  Errors are always
  // captured at rate 1.0 regardless of this setting.  Increase to 0.5 or 1.0
  // once traffic baselines are established — see src/observability/README.md.
  const tracesSampleRate = parseFloat(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
  );

  // Release tag — prefer GIT_SHA (set by the deploy script via Dockerfile
  // ARG; see fly.toml `build.args` and Dockerfile `ARG GIT_SHA`). Fall back
  // to RELEASE_VERSION for backwards compatibility with the sourcemap-upload
  // pipeline which already wires that variable. Without either, leave the
  // release unset so Sentry buckets events under "no release" rather than a
  // misleading default.
  const release = process.env.GIT_SHA || process.env.RELEASE_VERSION || undefined;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    release,
    tracesSampleRate: isNaN(tracesSampleRate) ? 0.1 : Math.min(1, Math.max(0, tracesSampleRate)),
    // Strip PII from common headers before transmission.  The request_id is
    // retained so Sentry events can be correlated with structured log lines.
    beforeSend(event) {
      if (event.request?.headers) {
        delete (event.request.headers as Record<string, unknown>).authorization;
        delete (event.request.headers as Record<string, unknown>).Authorization;
        delete (event.request.headers as Record<string, unknown>).cookie;
        delete (event.request.headers as Record<string, unknown>).Cookie;
      }
      return event;
    },
  });
}

export { Sentry };
