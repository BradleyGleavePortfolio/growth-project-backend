// Typed errors thrown internally by the guest-checkout conversion path so
// callers can distinguish transient (retryable) failures from terminal
// ones without string-matching on `Error.message`. The conversion-path
// caller catches these, tags them with safeErrorTag(), and uses
// markRetryable to flip the GuestCheckout row.
//
// R44: All raw `new Error(...)` is banned. Provider-call failures route
// through these classes.

export class GuestConversionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'GuestConversionError';
    this.code = code;
    Object.setPrototypeOf(this, GuestConversionError.prototype);
  }
}

// Specific subclasses let tests assert the exact reason instead of just
// the parent class. Each carries a stable `code` so observability can
// group occurrences without grepping log lines.

export class SupabaseTimeoutError extends GuestConversionError {
  constructor(tag: string) {
    super(`${tag}_timeout`, `${tag}_timeout`);
    this.name = 'SupabaseTimeoutError';
    Object.setPrototypeOf(this, SupabaseTimeoutError.prototype);
  }
}

export class SupabaseExistingUserNotFoundError extends GuestConversionError {
  constructor() {
    super(
      'supabase_existing_user_not_found',
      'supabase_existing_user_not_found',
    );
    this.name = 'SupabaseExistingUserNotFoundError';
    Object.setPrototypeOf(this, SupabaseExistingUserNotFoundError.prototype);
  }
}

export class SupabaseCreateUserError extends GuestConversionError {
  constructor(message: string) {
    super(message || 'supabase_createUser_failed', 'supabase_createUser_failed');
    this.name = 'SupabaseCreateUserError';
    Object.setPrototypeOf(this, SupabaseCreateUserError.prototype);
  }
}
