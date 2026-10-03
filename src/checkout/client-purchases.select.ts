import type { Prisma } from '@prisma/client';

// OR-112-19 — explicit field allow-list for the client's own purchase reads
// (GET /v1/checkout/purchases).
//
// The raw ClientPurchase row caches the PaymentIntent `stripe_client_secret`
// and customer `stripe_ephemeral_key` so POST /v1/checkout/payment-intent can
// replay them for the same idempotency key. That replay is the ONLY way a
// client resumes a payment: the mobile app never reads a secret from a
// purchase row (it reads id, package_id, status, entitlement_active,
// access_expires_at, current_period_end, cancel_at_period_end, canceled_at,
// created_at). So no purchase list or detail response carries a secret,
// whatever the purchase status. Stripe ids, idempotency keys, the coach's
// connected account and internal grant metadata stay private too.
//
// Anything added to the model later stays private until someone adds it here
// on purpose; test/client-purchases-field-select.spec.ts fails on any
// secret-like name.

/** ClientPurchase fields a client may see about their own purchase. */
export const CLIENT_PURCHASE_SELECT = {
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
  // B-TRIALS (OR-113-2) — trial snapshot + Stripe trial_end mirror; the list
  // also derives purchases[].trial (see src/packages/trials/trial-view.ts).
  trial_days: true,
  trial_ends_at: true,
  created_at: true,
  updated_at: true,
} as const satisfies Prisma.ClientPurchaseSelect;

/** Shape of one row in the client's own purchase list. */
export type ClientPurchaseView = Prisma.ClientPurchaseGetPayload<{
  select: typeof CLIENT_PURCHASE_SELECT;
}>;
