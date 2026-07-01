// Sentry initialisation — must be imported BEFORE any other application module
// so its hooks attach to Node's `http`/`fs`/etc. (main.ts imports it first).
// The init options live in observability/sentry-config.ts (unit-testable in
// isolation); this file is the thin boot-time entrypoint that fires the side
// effect at the earliest possible moment.
import * as Sentry from '@sentry/node';
import { initSentry } from './observability/sentry-config';

initSentry();

export { Sentry };
