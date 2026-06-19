// Sentry initialisation — must be imported BEFORE any other application
// module so its instrumentation hooks attach to Node's `http`/`fs`/etc. The
// import order is enforced in main.ts (this is the very first import).
//
// The actual init options (release tagging, environment, PII-stripping
// beforeSend, tags block) live in src/observability/sentry-config.ts so they
// are unit-testable in isolation. This file is the thin boot-time entrypoint
// that fires the side effect at the earliest possible moment.
//
// Release resolution (H3): SENTRY_RELEASE (CI-injected, preferred) →
// GIT_SHA → RELEASE_VERSION → unset. See sentry-config.resolveRelease.
import * as Sentry from '@sentry/node';
import { initSentry } from './observability/sentry-config';

initSentry();

export { Sentry };
