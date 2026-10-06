import type { Prisma } from '@prisma/client';

// B-SECRETS-3 (#646 C-646-1, both lenses) — owner / admin reads of
// ClientPurchase.
//
// A ClientPurchase row caches the client's Stripe PaymentIntent
// `stripe_client_secret` and customer `stripe_ephemeral_key` so the client's
// own PaymentSheet can resume a pending payment. They are the client's
// payment credentials: no owner or admin route needs them (support works
// from the Stripe ids, which stay visible), so every admin read omits them.
// Coach routes use the stricter allow-lists in coach-payments.select.ts.

/** The cached PaymentSheet credentials on a ClientPurchase row. */
export const PURCHASE_PAYMENT_SECRET_FIELDS = [
  'stripe_client_secret',
  'stripe_ephemeral_key',
] as const;

/** Every ClientPurchase column except the client's payment credentials. */
export const ADMIN_PURCHASE_OMIT = {
  stripe_client_secret: true,
  stripe_ephemeral_key: true,
} as const satisfies Prisma.ClientPurchaseOmit;

/** Shape of a purchase row on an owner / admin route. */
export type AdminPurchaseView = Prisma.ClientPurchaseGetPayload<{
  omit: typeof ADMIN_PURCHASE_OMIT;
}>;

/**
 * B-SECRETS-3 (#646 C-646-2 Opus) — written with every transition that ends
 * a PaymentSheet payment (succeeded, checkout expired, subscription ended):
 * once the PaymentIntent can no longer be paid, nothing may resume it, so
 * the cached credentials are erased at rest. A failed payment keeps them
 * (the client retries the same PaymentIntent).
 */
export const CLEARED_PAYMENT_SECRETS = {
  stripe_client_secret: null,
  stripe_ephemeral_key: null,
} as const satisfies Prisma.ClientPurchaseUpdateInput;
