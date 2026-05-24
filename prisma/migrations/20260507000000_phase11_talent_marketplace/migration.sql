-- Phase 11 / Track 8 — Talent Marketplace
--
-- Adds the four enums and three tables that back the public coach-application
-- intake, the Scale+ talent-pool browse, the head-coach offer flow, and the
-- per-coach Stripe Connect Express mirror.
--
-- Forward-only. Additive only. No existing tables modified.
--
-- Tables:
--   CoachApplication     — submitted publicly; reviewed by OWNER admins;
--                          approved coaches enter the pool.
--   CoachConnectAccount  — one row per coach user; mirrors Stripe Connect
--                          Express account id + onboarding state.
--   CoachOffer           — head-coach extends an offer to an application;
--                          on accept the applicant is placed.
--
-- Defense-in-depth: row-level security is enabled on every new table and
-- locked to the `service_role` (the backend Postgres role used by Prisma).
-- The Supabase anon / authenticated roles cannot read or write these tables
-- directly; all access flows through the NestJS authorisation layer.

-- ─── 1. Enums ───────────────────────────────────────────────────────────────

CREATE TYPE "CoachClientType" AS ENUM ('fitness', 'wellness', 'both');

CREATE TYPE "CoachApplicationStatus" AS ENUM (
    'pending',
    'reviewed',
    'approved',
    'pool',
    'placed',
    'inactive'
);

CREATE TYPE "CoachCompensationType" AS ENUM (
    'commission',
    'rev_share',
    'flat',
    'hybrid'
);

CREATE TYPE "CoachOfferStatus" AS ENUM (
    'pending',
    'accepted',
    'rejected',
    'withdrawn'
);

-- ─── 2. CoachApplication ────────────────────────────────────────────────────

CREATE TABLE "CoachApplication" (
    "id"                          TEXT                     NOT NULL,
    "applicant_user_id"           TEXT,
    "email"                       TEXT                     NOT NULL,
    "first_name"                  TEXT                     NOT NULL,
    "last_name"                   TEXT                     NOT NULL,
    "certifications"              TEXT[],
    "specializations"             TEXT[],
    "years_experience"            INTEGER                  NOT NULL,
    "sample_program_url"          TEXT,
    "preferences"                 JSONB                    NOT NULL,
    "availability_hours_per_week" INTEGER                  NOT NULL,
    "preferred_client_type"       "CoachClientType"        NOT NULL DEFAULT 'fitness',
    "background_verified"         BOOLEAN                  NOT NULL DEFAULT false,
    "status"                      "CoachApplicationStatus" NOT NULL DEFAULT 'pending',
    "reviewer_user_id"            TEXT,
    "reviewer_score"              INTEGER,
    "reviewer_notes"              TEXT,
    "idempotency_key"             TEXT,
    "created_at"                  TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMP(3)             NOT NULL,

    CONSTRAINT "CoachApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachApplication_idempotency_key_key"
    ON "CoachApplication"("idempotency_key");

CREATE INDEX "CoachApplication_status_created_at_id_idx"
    ON "CoachApplication"("status", "created_at" DESC, "id" DESC);

CREATE INDEX "CoachApplication_applicant_user_id_idx"
    ON "CoachApplication"("applicant_user_id");

CREATE INDEX "CoachApplication_email_idx"
    ON "CoachApplication"("email");

ALTER TABLE "CoachApplication"
    ADD CONSTRAINT "CoachApplication_applicant_user_id_fkey"
    FOREIGN KEY ("applicant_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CoachApplication"
    ADD CONSTRAINT "CoachApplication_reviewer_user_id_fkey"
    FOREIGN KEY ("reviewer_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. CoachConnectAccount ─────────────────────────────────────────────────

CREATE TABLE "CoachConnectAccount" (
    "id"                   TEXT         NOT NULL,
    "user_id"              TEXT         NOT NULL,
    "stripe_account_id"    TEXT         NOT NULL,
    "onboarding_completed" BOOLEAN      NOT NULL DEFAULT false,
    "capabilities"         JSONB,
    "country"              TEXT         NOT NULL DEFAULT 'US',
    "default_currency"     TEXT         NOT NULL DEFAULT 'usd',
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachConnectAccount_pkey" PRIMARY KEY ("id")
);

-- One Connect account per coach user. Doubles as the race guard for
-- concurrent onboarding-link requests: a second insert under the same user_id
-- raises a unique violation that the service catches and resolves to the
-- existing row.
CREATE UNIQUE INDEX "CoachConnectAccount_user_id_key"
    ON "CoachConnectAccount"("user_id");

CREATE UNIQUE INDEX "CoachConnectAccount_stripe_account_id_key"
    ON "CoachConnectAccount"("stripe_account_id");

CREATE INDEX "CoachConnectAccount_stripe_account_id_idx"
    ON "CoachConnectAccount"("stripe_account_id");

ALTER TABLE "CoachConnectAccount"
    ADD CONSTRAINT "CoachConnectAccount_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 4. CoachOffer ──────────────────────────────────────────────────────────

CREATE TABLE "CoachOffer" (
    "id"                  TEXT                     NOT NULL,
    "head_coach_id"       TEXT                     NOT NULL,
    "applicant_user_id"   TEXT,
    "application_id"      TEXT                     NOT NULL,
    "compensation_type"   "CoachCompensationType"  NOT NULL,
    "compensation_terms"  JSONB                    NOT NULL,
    "client_capacity"     INTEGER                  NOT NULL,
    "onboarding_message"  TEXT,
    "status"              "CoachOfferStatus"       NOT NULL DEFAULT 'pending',
    "accepted_at"         TIMESTAMP(3),
    "idempotency_key"     TEXT,
    "created_at"          TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3)             NOT NULL,

    CONSTRAINT "CoachOffer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachOffer_idempotency_key_key"
    ON "CoachOffer"("idempotency_key");

CREATE INDEX "CoachOffer_head_coach_id_status_idx"
    ON "CoachOffer"("head_coach_id", "status");

CREATE INDEX "CoachOffer_application_id_status_idx"
    ON "CoachOffer"("application_id", "status");

-- One pending offer per (head_coach, application). Partial unique index so the
-- constraint applies only while the offer is live; rejected/withdrawn offers
-- do not block a future re-offer.
CREATE UNIQUE INDEX "CoachOffer_one_pending_per_head_coach_application_idx"
    ON "CoachOffer"("head_coach_id", "application_id")
    WHERE "status" = 'pending';

ALTER TABLE "CoachOffer"
    ADD CONSTRAINT "CoachOffer_head_coach_id_fkey"
    FOREIGN KEY ("head_coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoachOffer"
    ADD CONSTRAINT "CoachOffer_applicant_user_id_fkey"
    FOREIGN KEY ("applicant_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CoachOffer"
    ADD CONSTRAINT "CoachOffer_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "CoachApplication"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 5. Row-Level Security ──────────────────────────────────────────────────
--
-- The backend connects with the Supabase service_role, which bypasses RLS by
-- default. Enabling RLS and adding restrictive policies for `anon` and
-- `authenticated` roles closes the direct-from-client attack surface: even if
-- a leaked JWT or anon key reaches the database, those roles have no policy
-- granting them SELECT/INSERT/UPDATE/DELETE, so every operation is rejected.

ALTER TABLE "CoachApplication"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachConnectAccount"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachOffer"           ENABLE ROW LEVEL SECURITY;

-- CoachApplication: backend-only writes (anon/authenticated cannot bypass
-- the NestJS validation + admin queue). Applicants read their own row by
-- applicant_user_id; OWNER admin reads happen through the service role and
-- are not subject to this policy.
CREATE POLICY "CoachApplication_applicant_read_own"
    ON "CoachApplication"
    FOR SELECT
    TO authenticated
    USING (
        "applicant_user_id" IS NOT NULL
        AND "applicant_user_id" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    );

-- CoachConnectAccount: a coach may read only their own Connect account row.
-- All writes go through the service role; no anon/authenticated write policy
-- is defined, so direct writes are denied.
CREATE POLICY "CoachConnectAccount_owner_read"
    ON "CoachConnectAccount"
    FOR SELECT
    TO authenticated
    USING (
        "user_id" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    );

-- CoachOffer: the head_coach who created it and the linked applicant (when
-- present) may read their own offer rows. Anonymous-applicant offers
-- (applicant_user_id IS NULL) are visible only to the head_coach and to the
-- service role; no anon/authenticated user can claim them by reading.
CREATE POLICY "CoachOffer_head_coach_read"
    ON "CoachOffer"
    FOR SELECT
    TO authenticated
    USING (
        "head_coach_id" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    );

CREATE POLICY "CoachOffer_applicant_read"
    ON "CoachOffer"
    FOR SELECT
    TO authenticated
    USING (
        "applicant_user_id" IS NOT NULL
        AND "applicant_user_id" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    );
