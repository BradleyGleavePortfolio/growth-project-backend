import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { safeDiagnostic } from './orm-diagnostics';

/** Shared process sinks must sanitize before either logger or telemetry sees ORM data. */
export function reportProcessError(
  kind: 'UnhandledRejection' | 'UncaughtException',
  error: unknown,
): void {
  const diagnostic = safeDiagnostic(error);
  Sentry.captureException(diagnostic);
  new Logger(kind).error(diagnostic);
}
