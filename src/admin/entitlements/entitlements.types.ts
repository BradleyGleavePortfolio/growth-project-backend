// Product entitlements — first-class read model for "what does this account
// have access to right now?". This is the typed contract the admin console
// renders into the coach overview and unified client record.
//
// Phase-1 scope: this is a *derived, read-only* model. We do not yet persist
// an Entitlement row per account; instead, EntitlementService folds three
// existing sources of truth into one stable shape:
//
//   1. Fitness Postgres (User.role / archived_at / deleted_at /
//      deletion_scheduled_at, plus CoachSubscription.status for coaches).
//   2. The finance backend's federation summary (FinanceCallOutcome —
//      ok / not_found / degraded). Degraded outcomes never invent a status;
//      finance_status falls back to `unknown` so the console can render a
//      "finance unavailable" pill instead of pretending the account is
//      finance-only-inactive.
//   3. Soft signals (deletion_scheduled_at => suspended; deleted_at =>
//      inactive) so the entitlement view stays coherent during GDPR scrubs.
//
// Persistent overrides (operator-suspended, comp'd, manual product grants)
// are out of scope for this PR and intentionally left to a follow-up — we
// document the migration shape in docs/entitlements.md so the read surface
// can be extended additively without breaking the contract below.

// Products the platform sells. `performance_os` is the bundle name for
// "fitness AND finance" — the marketing surface labels the combined plan
// "Performance OS", and the admin console renders that name verbatim when
// both products are active.
export type EntitlementProduct = 'fitness' | 'finance';

// Bundle label derived from active_products. Stable strings the admin UI
// can switch on without recomputing the set.
export type EntitlementBundle =
  | 'none'
  | 'fitness_only'
  | 'finance_only'
  | 'performance_os';

// Per-product entitlement status. These mirror the SubscriptionStatus enum
// where possible so the admin UI can reuse the existing status pill, with
// two additions:
//
//   inactive  — the product has no record for this account (finance not_found,
//               or fitness user without role/archived).
//   suspended — operator action or GDPR grace period; the account exists but
//               product access is paused.
//   unknown   — finance outcome was degraded (timeout, http error, etc.).
//               The console must render this as "temporarily unavailable" and
//               must not treat it as inactive.
export type EntitlementStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'suspended'
  | 'inactive'
  | 'unknown';

// Top-level account state. Folds the per-product statuses into one
// admin-friendly verdict.
//
//   active     — at least one product is trialing/active.
//   past_due   — no active product, but at least one is past_due (dunning).
//   canceled   — no active or past_due, but at least one canceled (churned).
//   suspended  — operator/GDPR suspension on the whole account.
//   inactive   — no records on either side.
//   unknown    — every signal we got was `unknown` (rare; finance degraded
//                with no fitness row).
export type EntitlementOverall =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'suspended'
  | 'inactive'
  | 'unknown';

// One-line, PII-free reason describing why a product is in its current
// status. The console renders this as a tooltip; tests assert on these
// stable strings.
export type EntitlementReason =
  | 'subscription_active'
  | 'subscription_trialing'
  | 'subscription_past_due'
  | 'subscription_canceled'
  | 'subscription_paused'
  | 'subscription_unknown'
  | 'no_subscription'
  | 'fitness_user_active'
  | 'fitness_user_archived'
  | 'fitness_user_pending_deletion'
  | 'fitness_user_deleted'
  | 'fitness_no_record'
  | 'finance_record_present'
  | 'finance_no_record'
  | 'finance_degraded'
  | 'finance_not_configured'
  | 'finance_auth_unconfigured';

export interface ProductEntitlement {
  product: EntitlementProduct;
  status: EntitlementStatus;
  reason: EntitlementReason;
  // Optional human-readable detail (e.g. the degraded reason from finance).
  // Always PII-free; safe to render in operator UI.
  detail?: string;
}

export interface AccountEntitlements {
  // The set of products the account currently has *any* access to
  // (status in {trialing, active, past_due}). Empty when inactive/canceled.
  active_products: EntitlementProduct[];
  bundle: EntitlementBundle;
  overall: EntitlementOverall;
  // Always returns both products so the console can render the full split
  // even if a product has no record for this account.
  products: {
    fitness: ProductEntitlement;
    finance: ProductEntitlement;
  };
  // True when account is operator-suspended or in GDPR grace period.
  // Drives the red "suspended" banner regardless of product status.
  account_suspended: boolean;
}
