// R43 Storefront Phase 1 — public payload returned by
// GET /v1/packages/public/join/:token. Consumed by the Next.js storefront
// SSR layer. Stable contract; the auditor checks this shape against the
// spec in §4.2.

export type BillingCycle = 'monthly' | 'quarterly' | 'annual' | 'one_time';

export interface PublicPackageCoach {
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  verified: boolean;
}

export interface PublicPackageData {
  package_id: string;
  package_name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_cycle: BillingCycle;
  trial_days: number | null;
  features: string[];
  coach: PublicPackageCoach;
  stripe_publishable_key: string;
  share_link_enabled: boolean;
}

export interface GuestCheckoutResult {
  client_secret: string;
  payment_intent_id: string;
  guest_checkout_id: string;
  // r48 #8 — wallet capability flags returned alongside the PaymentIntent
  // so the storefront can render Apple Pay / Google Pay buttons only when
  // the coach's connected account actually supports them. Defaults to
  // `false` on legacy / unconfigured boots so the storefront falls back
  // to card-only.
  supports_apple_pay?: boolean;
  supports_google_pay?: boolean;
}
