// Sentry initialisation — must be imported BEFORE any other application
// module so its instrumentation hooks attach to Node's `http`/`fs`/etc. The
// import order is enforced in main.ts (this is the very first import).
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.RELEASE_VERSION || undefined,
    // Performance — sampling kept conservative for cost control. Bump once
    // we have real traffic baselines.
    tracesSampleRate: 0.1,
    // Strip secrets from common headers before transmission.
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
