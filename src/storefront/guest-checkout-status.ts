// A276 P0-1 — single source of truth for the GuestCheckout.status enum.
//
// The DB-side CHECK constraint `GuestCheckout_status_check` enforces
// these values; this TS literal mirrors them so the compiler refuses
// any drift between code-side writes and DB-side validation. Adding a
// new state means: (1) a new migration that DROPs + re-ADDs the
// constraint with the value included, and (2) appending the literal
// here. The migration spec test (test/guest-checkout-status-check.spec.ts)
// asserts these two sources stay in sync.
//
// Migrations that have shaped this set:
//   - baseline (00000000000000_baseline)              → pending, paid, failed, converted
//   - 20260804000000_guest_checkout_retryable_conversion
//                                                      → +conversion_failed_retryable, +conversion_failed_terminal
//   - 20260921000000_add_refunded_disputed_to_guest_checkout_status
//                                                      → +refunded, +disputed
export const GUEST_CHECKOUT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'converted',
  'conversion_failed_retryable',
  'conversion_failed_terminal',
  'refunded',
  'disputed',
] as const;

export type GuestCheckoutStatus = (typeof GUEST_CHECKOUT_STATUSES)[number];

export function isGuestCheckoutStatus(v: string): v is GuestCheckoutStatus {
  return (GUEST_CHECKOUT_STATUSES as readonly string[]).includes(v);
}
