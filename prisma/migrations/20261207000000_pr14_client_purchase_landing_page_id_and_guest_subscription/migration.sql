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

-- PR-14 R2 P3 — CREATE INDEX CONCURRENTLY for the ClientPurchase
-- landing_page_id index. ClientPurchase is a hot, populated production
-- table (it backs every paid purchase across in-app + storefront +
-- guest). A standard CREATE INDEX takes ACCESS EXCLUSIVE for the build
-- duration, blocking every INSERT/UPDATE/DELETE on the table — observable
-- as request timeouts in the checkout flow. CREATE INDEX CONCURRENTLY
-- builds without blocking writes (takes a ShareUpdateExclusive lock
-- that does not conflict with normal DML).
--
-- COMMIT / BEGIN bookend: Prisma migrate deploy wraps each migration
-- file in a single transaction. CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block. The accepted Prisma 5 workaround is to
-- break out of the implicit transaction with COMMIT, run the concurrent
-- index build at the top level, and then start a fresh transaction so
-- Prisma's wrapping COMMIT still has something to close. Mirrors the
-- pattern at prisma/migrations/20260704000001_coach_brief_cwa_index_concurrent.
--
-- IF NOT EXISTS makes it safe to re-run if a previous CONCURRENTLY build
-- failed mid-way (Postgres leaves an INVALID index; operators should
-- check pg_index.indisvalid and DROP any invalid leftovers before
-- re-running, per Postgres docs).
COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ClientPurchase_landing_page_id_idx"
  ON "ClientPurchase" ("landing_page_id");

BEGIN;
