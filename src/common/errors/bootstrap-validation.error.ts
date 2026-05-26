// Typed error thrown during application bootstrap (before NestJS lifecycle
// begins) when a precondition required for safe startup fails. Examples
// include CORS misconfiguration and STOREFRONT_BASE_URL being structurally
// invalid in production. Carrying a named error class lets observability
// (Sentry, structured logs) distinguish boot failures from runtime
// failures, and lets ops grep for them across the codebase.
//
// R44: All raw `new Error(...)` is banned. Bootstrap precondition failures
// route through this class instead. Tests assert `instanceof
// BootstrapValidationError` to lock the contract in place.
export class BootstrapValidationError extends Error {
  // Stable, machine-readable code for log aggregation. Free-form `message`
  // is for humans; `code` is for dashboards.
  readonly code: string;

  constructor(message: string, code = 'BOOTSTRAP_VALIDATION_FAILED') {
    super(message);
    this.name = 'BootstrapValidationError';
    this.code = code;
    Object.setPrototypeOf(this, BootstrapValidationError.prototype);
  }
}
