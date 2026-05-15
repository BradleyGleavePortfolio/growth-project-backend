-- Phase 2-3 Connect (CONNECT_MASTER_PLAN.md §Phase 2 — Offers/Packages and
-- §Phase 3 — Checkout/Billing-setup foundation).
--
-- CoachPackage  : coach's catalog of offers (one_time or recurring). Stripe
--                 Product+Price are created lazily on first checkout and
--                 cached on the row.
-- ConnectCustomer: per-client Stripe Customer on the platform account.
--                 Created on first checkout, reused thereafter. Mirrors
--                 default_payment_method for "saved cards" UI.
-- ClientPurchase : one row per checkout session. Lifecycle is driven by
--                 webhooks: checkout.session.completed, customer.subscription.*,
--                 payment_intent.payment_failed. entitlement_active is the
--                 derived access bit for authorization.

CREATE TABLE "CoachPackage" (
    "id"                TEXT        NOT NULL,
    "coach_id"          TEXT        NOT NULL,
    "name"              TEXT        NOT NULL,
    "description"       TEXT,
    "amount_cents"      INTEGER     NOT NULL,
    "currency"          TEXT        NOT NULL DEFAULT 'usd',
    "billing_type"      TEXT        NOT NULL DEFAULT 'one_time',
    "interval"          TEXT,
    "interval_count"    INTEGER     NOT NULL DEFAULT 1,
    "duration_periods"  INTEGER,
    "stripe_price_id"   TEXT,
    "stripe_product_id" TEXT,
    "is_active"         BOOLEAN     NOT NULL DEFAULT true,
    "archived_at"       TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachPackage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachPackage_coach_id_is_active_idx"      ON "CoachPackage"("coach_id", "is_active");
CREATE INDEX "CoachPackage_coach_id_archived_at_idx"    ON "CoachPackage"("coach_id", "archived_at");
CREATE INDEX "CoachPackage_stripe_price_id_idx"         ON "CoachPackage"("stripe_price_id");

ALTER TABLE "CoachPackage"
    ADD CONSTRAINT "CoachPackage_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE TABLE "ConnectCustomer" (
    "id"                         TEXT        NOT NULL,
    "client_user_id"             TEXT        NOT NULL,
    "stripe_customer_id"         TEXT        NOT NULL,
    "default_payment_method_id"  TEXT,
    "default_card_brand"         TEXT,
    "default_card_last4"         TEXT,
    "default_card_exp_month"     INTEGER,
    "default_card_exp_year"      INTEGER,
    "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                 TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectCustomer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectCustomer_client_user_id_key"     ON "ConnectCustomer"("client_user_id");
CREATE UNIQUE INDEX "ConnectCustomer_stripe_customer_id_key" ON "ConnectCustomer"("stripe_customer_id");
CREATE        INDEX "ConnectCustomer_stripe_customer_id_idx" ON "ConnectCustomer"("stripe_customer_id");

ALTER TABLE "ConnectCustomer"
    ADD CONSTRAINT "ConnectCustomer_client_user_id_fkey"
    FOREIGN KEY ("client_user_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE TABLE "ClientPurchase" (
    "id"                          TEXT        NOT NULL,
    "client_user_id"              TEXT        NOT NULL,
    "coach_user_id"               TEXT        NOT NULL,
    "package_id"                  TEXT        NOT NULL,
    "amount_cents"                INTEGER     NOT NULL,
    "currency"                    TEXT        NOT NULL DEFAULT 'usd',
    "billing_type"                TEXT        NOT NULL DEFAULT 'one_time',
    "stripe_checkout_session_id"  TEXT        NOT NULL,
    "stripe_payment_intent_id"    TEXT,
    "stripe_subscription_id"      TEXT,
    "stripe_customer_id"          TEXT,
    "stripe_destination_account"  TEXT,
    "status"                      TEXT        NOT NULL DEFAULT 'pending',
    "entitlement_active"          BOOLEAN     NOT NULL DEFAULT false,
    "access_expires_at"           TIMESTAMP(3),
    "current_period_end"          TIMESTAMP(3),
    "cancel_at_period_end"        BOOLEAN     NOT NULL DEFAULT false,
    "canceled_at"                 TIMESTAMP(3),
    "idempotency_key"             TEXT        NOT NULL,
    "last_error"                  TEXT,
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientPurchase_stripe_checkout_session_id_key" ON "ClientPurchase"("stripe_checkout_session_id");
CREATE UNIQUE INDEX "ClientPurchase_stripe_subscription_id_key"     ON "ClientPurchase"("stripe_subscription_id");
CREATE UNIQUE INDEX "ClientPurchase_idempotency_key_key"            ON "ClientPurchase"("idempotency_key");

CREATE INDEX "ClientPurchase_client_user_id_status_idx" ON "ClientPurchase"("client_user_id", "status");
CREATE INDEX "ClientPurchase_coach_user_id_status_idx"  ON "ClientPurchase"("coach_user_id", "status");
CREATE INDEX "ClientPurchase_package_id_idx"            ON "ClientPurchase"("package_id");
CREATE INDEX "ClientPurchase_stripe_subscription_id_idx" ON "ClientPurchase"("stripe_subscription_id");
CREATE INDEX "ClientPurchase_entitlement_active_access_expires_at_idx" ON "ClientPurchase"("entitlement_active", "access_expires_at");

ALTER TABLE "ClientPurchase"
    ADD CONSTRAINT "ClientPurchase_client_user_id_fkey"
    FOREIGN KEY ("client_user_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientPurchase"
    ADD CONSTRAINT "ClientPurchase_coach_user_id_fkey"
    FOREIGN KEY ("coach_user_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientPurchase"
    ADD CONSTRAINT "ClientPurchase_package_id_fkey"
    FOREIGN KEY ("package_id") REFERENCES "CoachPackage"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
