-- SaaS multi-tenant billing + drafts + activity stream.
--
-- Adds:
--   - 'owner' value to Role enum (used by SubscriptionGuard for OWNER bypass)
--   - CoachProfile (1:1 with coach users): branding + invite code + stripe customer mirror
--   - CoachSubscription: Stripe subscription state mirror
--   - Invoice: Stripe invoice mirror
--   - PaymentFailure: row per failed payment for the console billing page
--   - StripeProcessedEvent: webhook idempotency table
--   - MessageDraft: per-(coach, client) autosaved compose draft
--   - ActivityEvent: audit stream feeding console activity views
--
-- All additions. No existing tables modified, no data migrated, no destructive
-- rewrites.

-- 1. Extend Role enum -----------------------------------------------------
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'owner';

-- 2. CoachProfile ---------------------------------------------------------
CREATE TABLE "CoachProfile" (
    "id"                  TEXT NOT NULL,
    "user_id"             TEXT NOT NULL,
    "business_name"       TEXT,
    "bio"                 TEXT,
    "brand_accent"        TEXT,
    "logo_url"            TEXT,
    "timezone"            TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "invite_code"         TEXT,
    "stripe_customer_id"  TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoachProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoachProfile_user_id_key" ON "CoachProfile"("user_id");
CREATE UNIQUE INDEX "CoachProfile_invite_code_key" ON "CoachProfile"("invite_code");
CREATE UNIQUE INDEX "CoachProfile_stripe_customer_id_key" ON "CoachProfile"("stripe_customer_id");
ALTER TABLE "CoachProfile"
    ADD CONSTRAINT "CoachProfile_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. CoachSubscription ----------------------------------------------------
CREATE TABLE "CoachSubscription" (
    "id"                          TEXT NOT NULL,
    "coach_id"                    TEXT NOT NULL,
    "stripe_customer_id"          TEXT,
    "stripe_subscription_id"      TEXT,
    "stripe_price_id"             TEXT,
    "status"                      TEXT NOT NULL DEFAULT 'incomplete',
    "current_period_end"          TIMESTAMP(3),
    "trial_end"                   TIMESTAMP(3),
    "cancel_at_period_end"        BOOLEAN NOT NULL DEFAULT false,
    "last_payment_failed_at"      TIMESTAMP(3),
    "failed_payments_this_month"  INTEGER NOT NULL DEFAULT 0,
    "billing_email"               TEXT,
    "card_last4"                  TEXT,
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoachSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoachSubscription_coach_id_key" ON "CoachSubscription"("coach_id");
CREATE UNIQUE INDEX "CoachSubscription_stripe_subscription_id_key" ON "CoachSubscription"("stripe_subscription_id");
CREATE INDEX "CoachSubscription_status_idx" ON "CoachSubscription"("status");
ALTER TABLE "CoachSubscription"
    ADD CONSTRAINT "CoachSubscription_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Invoice --------------------------------------------------------------
CREATE TABLE "Invoice" (
    "id"                  TEXT NOT NULL,
    "coach_id"            TEXT NOT NULL,
    "stripe_invoice_id"   TEXT NOT NULL,
    "stripe_customer_id"  TEXT,
    "amount_paid_cents"   INTEGER NOT NULL DEFAULT 0,
    "amount_due_cents"    INTEGER NOT NULL DEFAULT 0,
    "currency"            TEXT NOT NULL DEFAULT 'usd',
    "status"              TEXT NOT NULL DEFAULT 'open',
    "hosted_invoice_url"  TEXT,
    "invoice_pdf"         TEXT,
    "period_start"        TIMESTAMP(3),
    "period_end"          TIMESTAMP(3),
    "paid_at"             TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_stripe_invoice_id_key" ON "Invoice"("stripe_invoice_id");
CREATE INDEX "Invoice_coach_id_created_at_idx" ON "Invoice"("coach_id", "created_at");
ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. PaymentFailure -------------------------------------------------------
CREATE TABLE "PaymentFailure" (
    "id"                 TEXT NOT NULL,
    "coach_id"           TEXT NOT NULL,
    "stripe_invoice_id"  TEXT,
    "stripe_event_id"    TEXT,
    "amount_due_cents"   INTEGER NOT NULL DEFAULT 0,
    "reason"             TEXT,
    "occurred_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentFailure_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentFailure_coach_id_occurred_at_idx" ON "PaymentFailure"("coach_id", "occurred_at");
ALTER TABLE "PaymentFailure"
    ADD CONSTRAINT "PaymentFailure_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. StripeProcessedEvent (webhook idempotency) ---------------------------
CREATE TABLE "StripeProcessedEvent" (
    "stripe_event_id" TEXT NOT NULL,
    "type"            TEXT NOT NULL,
    "processed_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StripeProcessedEvent_pkey" PRIMARY KEY ("stripe_event_id")
);
CREATE INDEX "StripeProcessedEvent_processed_at_idx" ON "StripeProcessedEvent"("processed_at");

-- 7. MessageDraft ---------------------------------------------------------
CREATE TABLE "MessageDraft" (
    "id"         TEXT NOT NULL,
    "coach_id"   TEXT NOT NULL,
    "client_id"  TEXT NOT NULL,
    "body"       TEXT NOT NULL,
    "snippet_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageDraft_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MessageDraft_coach_id_client_id_key" ON "MessageDraft"("coach_id", "client_id");
CREATE INDEX "MessageDraft_coach_id_idx" ON "MessageDraft"("coach_id");
ALTER TABLE "MessageDraft"
    ADD CONSTRAINT "MessageDraft_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageDraft"
    ADD CONSTRAINT "MessageDraft_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 8. ActivityEvent --------------------------------------------------------
CREATE TABLE "ActivityEvent" (
    "id"         TEXT NOT NULL,
    "actor_id"   TEXT,
    "actor_role" TEXT,
    "coach_id"   TEXT,
    "client_id"  TEXT,
    "type"       TEXT NOT NULL,
    "summary"    TEXT,
    "payload"    JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ActivityEvent_coach_id_created_at_idx" ON "ActivityEvent"("coach_id", "created_at");
CREATE INDEX "ActivityEvent_client_id_created_at_idx" ON "ActivityEvent"("client_id", "created_at");
CREATE INDEX "ActivityEvent_type_created_at_idx" ON "ActivityEvent"("type", "created_at");
ALTER TABLE "ActivityEvent"
    ADD CONSTRAINT "ActivityEvent_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent"
    ADD CONSTRAINT "ActivityEvent_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityEvent"
    ADD CONSTRAINT "ActivityEvent_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
