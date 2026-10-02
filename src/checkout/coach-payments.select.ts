import type { Prisma } from '@prisma/client';

// C-641-2 — explicit field allow-lists for every coach-facing payments read.
//
// A coach-facing route must never return a raw ClientPurchase row: it holds
// the CLIENT's Stripe PaymentIntent `stripe_client_secret` and customer
// `stripe_ephemeral_key` (cached for the client's own PaymentSheet retries),
// plus internal Stripe ids and idempotency keys. Each coach route selects
// only the fields below; anything added to the models later stays private
// until someone adds it here on purpose (and the regression spec
// test/coach-payments-field-select.spec.ts fails on any secret-like name).
//
// Payment method details are never stored on these models; if they ever are,
// only brand and last4 may be added here.

/** ClientPurchase fields a coach may see about a sale to their client. */
export const COACH_PURCHASE_SELECT = {
  id: true,
  client_user_id: true,
  coach_user_id: true,
  package_id: true,
  amount_cents: true,
  currency: true,
  billing_type: true,
  status: true,
  entitlement_active: true,
  access_expires_at: true,
  current_period_end: true,
  cancel_at_period_end: true,
  canceled_at: true,
  last_error: true,
  source: true,
  created_at: true,
  updated_at: true,
} as const satisfies Prisma.ClientPurchaseSelect;

/** SplitLedgerEntry fields a coach may see (amounts, state, Stripe charge / transfer ids). */
export const COACH_LEDGER_SELECT = {
  id: true,
  purchase_id: true,
  kind: true,
  payee_user_id: true,
  amount_cents: true,
  currency: true,
  status: true,
  reversed_cents: true,
  stripe_charge_id: true,
  stripe_transfer_id: true,
  posted_at: true,
  reversed_at: true,
  created_at: true,
  updated_at: true,
} as const satisfies Prisma.SplitLedgerEntrySelect;

/** ConnectTransfer fields a coach may see about a follow-on transfer. */
export const COACH_TRANSFER_SELECT = {
  id: true,
  purchase_id: true,
  destination_user_id: true,
  amount_cents: true,
  currency: true,
  status: true,
  stripe_transfer_id: true,
  posted_at: true,
  reversed_at: true,
  reversed_amount_cents: true,
  created_at: true,
  updated_at: true,
} as const satisfies Prisma.ConnectTransferSelect;

/** DunningState fields a coach may see about a failing payment on their roster. */
export const COACH_DUNNING_SELECT = {
  id: true,
  purchase_id: true,
  status: true,
  failure_count: true,
  last_attempt_number: true,
  last_failed_amount_cents: true,
  last_failure_at: true,
  last_failure_reason: true,
  grace_period_ends_at: true,
  cancel_scheduled_at: true,
  resolved_at: true,
  abandoned_at: true,
  step_index: true,
  next_attempt_at: true,
  entered_at: true,
  recovered_at: true,
  escalated_at: true,
  locked_out_at: true,
  created_at: true,
  updated_at: true,
} as const satisfies Prisma.DunningStateSelect;

/**
 * Field names that must never appear in a coach-facing payments response.
 * Used by the regression spec; exported so every coach route spec can share
 * one definition.
 */
export const COACH_FORBIDDEN_FIELD_PATTERN =
  /secret|ephemeral|idempotency|stripe_customer_id|checkout_session|payment_intent|payment_method|stripe_destination_account|stripe_account_id|application_fee_id|grant_metadata|card_(number|exp|cvc|fingerprint)|fingerprint/i;
