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

// Audit #5 P1-6 — when ConnectAccount row is missing (or stripe_account_id
// is null), resolveDestinationAccount used to silently return null,
// which let convertGuestToUser persist a ClientPurchase with
// stripe_destination_account = null and corrupt revenue reconciliation.
// Throw a typed error instead so the caller routes the checkout into
// conversion_failed_retryable. The reconciliation worker retries
// after the operator wires the coach's Connect onboarding.
//
// Existing upstream gate (storefront.service.ts: isConnectAccountReadyForCheckout)
// prevents createIntent from happening at all when the coach has no
// account, but a TOCTOU window exists between createIntent and
// convertGuestToUser — a coach can disconnect Stripe between paying
// and conversion. This typed error catches that window.
export class DestinationAccountMissingError extends GuestConversionError {
  constructor(coachUserId: string) {
    super(
      `destination_account_missing:coach=${coachUserId}`,
      'destination_account_missing',
    );
    this.name = 'DestinationAccountMissingError';
    Object.setPrototypeOf(this, DestinationAccountMissingError.prototype);
  }
}
