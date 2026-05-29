-- PR-14 — Guest storefront recurring support + landing_page_id propagation.
--
-- Two additive, nullable columns. No DROP, no RENAME, no type change.
-- Every existing row keeps behaving exactly as today.
--
-- WHY each change:
--
--   1. ClientPurchase.landing_page_id (nullable). GuestCheckout already
--      captures the landing-page referrer (§ R47 Phase 3). On guest
--      conversion the value is lost — per-page LTV / revenue attribution
--      is broken because the rollup query reads ClientPurchase, not
--      GuestCheckout. PR-3 did NOT add this column (verified: no
--      `landing_page_id` on ClientPurchase in PR-3's migration). Propagate
--      it inside the conversion $transaction in PR-14 application code.
--      Nullable: in-app and direct (non-LP-attributed) guest checkouts
--      leave it null; analytics filters on IS NOT NULL.
--
--   2. GuestCheckout.stripe_subscription_id (nullable, unique). The
--      storefront now sells recurring + one-time+recurring combo
--      packages (master plan §1 decision #1). For these flows Stripe
--      mints a Subscription whose first invoice's PaymentIntent the
--      guest confirms client-side. Storing the subscription id on
--      GuestCheckout — alongside the existing stripe_payment_intent_id —
--      gives the convert-to-user $transaction the subscription id to
--      copy onto ClientPurchase (which already has a unique
--      stripe_subscription_id column), so the existing
--      applySubscriptionUpdated webhook handler claims renewal /
--      cancellation events for guest-originated subscriptions exactly
--      like in-app ones. UNIQUE so a Stripe replay that races two
--      different GuestCheckout rows onto the same subscription id
--      P2002s instead of dual-binding. Nullable: pre-PR-14 rows and
--      one-time-only checkouts leave it null.

ALTER TABLE "ClientPurchase"
  ADD COLUMN "landing_page_id" TEXT;

ALTER TABLE "GuestCheckout"
  ADD COLUMN "stripe_subscription_id" TEXT;

CREATE UNIQUE INDEX "GuestCheckout_stripe_subscription_id_key"
  ON "GuestCheckout" ("stripe_subscription_id");

-- Index on landing_page_id for per-page LTV analytics joins
-- (mirrors GuestCheckout_landing_page_id_status_idx semantics).
CREATE INDEX "ClientPurchase_landing_page_id_idx"
  ON "ClientPurchase" ("landing_page_id");
