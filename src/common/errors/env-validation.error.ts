// Typed error thrown by assertEnv() when required environment variables are
// missing, placeholders, or fail validator rules. Carrying a named class
// (rather than raw `new Error(...)`) lets the bootstrap path distinguish
// env failures from other runtime errors and lets tests assert on the
// specific failure mode without string-matching log messages.
//
// R44: All raw `new Error(...)` is banned. Env-validation failures route
// through this class.
export class EnvValidationError extends Error {
  // Stable, machine-readable code for log aggregation. Free-form `message`
  // is for humans; `code` is for dashboards.
  readonly code: string;

  // Names (not values) of the env vars that failed. Always names only —
  // values can contain secrets and must never be logged here.
  readonly variables: string[];

  constructor(
    message: string,
    opts: { code?: string; variables?: string[] } = {},
  ) {
    super(message);
    this.name = 'EnvValidationError';
    this.code = opts.code ?? 'ENV_VALIDATION_FAILED';
    this.variables = opts.variables ?? [];
    Object.setPrototypeOf(this, EnvValidationError.prototype);
  }
}
