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

/** GC-1: the renewing part of a package, from the checkout's own rule. */
export interface PublicPackageRecurring {
  /** What each renewal charges. */
  amount_cents: number;
  interval: 'week' | 'month' | 'year';
  interval_count: number;
  /** One-time part charged today with the first period (0 unless combo). */
  one_time_cents: number;
  /** ISO date of the first renewal if paid now. */
  next_charge_at: string;
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
  /** GC-1: what checkout charges today (chargeQuote; GC-3: 0 for a trial). */
  due_today_cents: number;
  /** GC-1: null for a one-time package. */
  recurring: PublicPackageRecurring | null;
}

export interface GuestCheckoutResult {
  client_secret: string;
  payment_intent_id: string;
  guest_checkout_id: string;
  // PR-14 — storefront recurring + one-time+recurring combo support.
  // When the package has a recurring component the storefront mints a
  // Stripe Subscription whose first invoice's PaymentIntent the guest
  // confirms; the subscription id is surfaced here so the Next.js layer
  // can wire its server-side state to the same id Stripe webhooks use.
  // Null for pure one-time checkouts.
  subscription_id?: string | null;
  // GC-3 — 'setup' for a free trial: client_secret is the trial's SetupIntent
  // (card saved, nothing charged today) and payment_intent_id is its seti_ id.
  intent?: 'payment' | 'setup';
  // r48 #8 — wallet capability flags returned alongside the PaymentIntent
  // so the storefront can render Apple Pay / Google Pay buttons only when
  // the coach's connected account actually supports them. Defaults to
  // `false` on legacy / unconfigured boots so the storefront falls back
  // to card-only.
  supports_apple_pay?: boolean;
  supports_google_pay?: boolean;
}
