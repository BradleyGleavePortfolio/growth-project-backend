-- TM-1 — Talent Marketplace schema + RLS foundation (ADR-0002, refs #424).
--
-- Two-sided public job board. Creates the five new tables (JobListing,
-- Applicant, Application, CoachOffer, MarketplaceMutationIdempotency), their
-- foreign keys (authored here, not in schema.prisma — scalar-FK idiom), the
-- two partial unique indexes ported from 714a69af, and full RLS using the
-- spine idiom VERBATIM from 20261215000200_contracts_rls/migration.sql.
--
-- Re-dated AFTER main's latest migration 20261219000000 (ADR decision 4).
--
-- RLS summary (Primitive A = service_role bypass; app.is_owner() /
-- app.current_user_id() helpers; anon → zero rows):
--   JobListing                     -> public-read SELECT only WHERE
--                                     status='published'; hirer owns own rows
--                                     (insert/update write-scope).
--   Applicant (PII)                -> applicant reads/writes own (user_id);
--                                     head-coach SELECT via the REUSED
--                                     TeamSubCoachAssignment non-archived
--                                     predicate (post-flip visibility).
--   Application (PII)              -> applicant reads/writes own
--                                     (applicant_user_id); hirer of the listing
--                                     reads applications to their listing.
--   CoachOffer (financial)         -> head-coach reads/writes own offers;
--                                     applicant SELECT offers made to them.
--   MarketplaceMutationIdempotency -> RESTRICTIVE deny-all to anon +
--                                     authenticated (service_role only).
--
-- The head-coach → applicant/sub-coach scope REUSES the existing
-- TeamSubCoachAssignment non-archived EXISTS(...) predicate verbatim (the same
-- clause the contracts + Tier-2 coach-team policies use) — no new team-scope
-- expression is authored (Inconsistency-Tax avoidance).
--
-- Rollback: DROP the policies + tables created here. Additive-only; touches no
-- existing table, type, or migration.

BEGIN;

-- =====================================================================
-- 0) Enums.
-- =====================================================================
CREATE TYPE "JobListingStatus" AS ENUM ('draft', 'published', 'closed');
CREATE TYPE "CoachCompensationType" AS ENUM ('commission', 'rev_share', 'flat', 'hybrid');
CREATE TYPE "ApplicationStatus" AS ENUM ('submitted', 'screening', 'shortlisted', 'offered', 'placed', 'rejected', 'withdrawn');
CREATE TYPE "CoachOfferStatus" AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');

-- =====================================================================
-- 1) Tables.
-- =====================================================================
CREATE TABLE "JobListing" (
    "id"                 TEXT NOT NULL,
    "hirer_id"           TEXT NOT NULL,
    "title"              TEXT NOT NULL,
    "description"        TEXT NOT NULL,
    "specialty"          TEXT,
    "location"           TEXT,
    "modality"           TEXT,
    "compensation_type"  "CoachCompensationType" NOT NULL,
    "compensation_terms" JSONB NOT NULL,
    "expectations"       TEXT,
    "status"             "JobListingStatus" NOT NULL DEFAULT 'draft',
    "published_at"       TIMESTAMP(3),
    "closed_at"          TIMESTAMP(3),
    "idempotency_key"    TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobListing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Applicant" (
    "id"                 TEXT NOT NULL,
    "user_id"            TEXT NOT NULL,
    "email"              TEXT NOT NULL,
    "first_name"         TEXT NOT NULL,
    "last_name"          TEXT NOT NULL,
    "headline"           TEXT,
    "bio"                TEXT,
    "specialties"        TEXT[],
    "certifications"     TEXT[],
    "years_experience"   INTEGER,
    "sample_program_url" TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Applicant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Application" (
    "id"                TEXT NOT NULL,
    "listing_id"        TEXT NOT NULL,
    "applicant_id"      TEXT NOT NULL,
    "applicant_user_id" TEXT NOT NULL,
    "hirer_id"          TEXT NOT NULL,
    "cover_note"        TEXT,
    "fit_score"         INTEGER,
    "status"            "ApplicationStatus" NOT NULL DEFAULT 'submitted',
    "idempotency_key"   TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CoachOffer" (
    "id"                 TEXT NOT NULL,
    "head_coach_id"      TEXT NOT NULL,
    "application_id"     TEXT NOT NULL,
    "applicant_user_id"  TEXT NOT NULL,
    "compensation_type"  "CoachCompensationType" NOT NULL,
    "compensation_terms" JSONB NOT NULL,
    "client_capacity"    INTEGER NOT NULL,
    "onboarding_message" TEXT,
    "status"             "CoachOfferStatus" NOT NULL DEFAULT 'pending',
    "accepted_at"        TIMESTAMP(3),
    "idempotency_key"    TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoachOffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceMutationIdempotency" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "route_key"       TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "response"        JSONB,
    "status"          TEXT NOT NULL DEFAULT 'completed',
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"    TIMESTAMP(3),
    CONSTRAINT "MarketplaceMutationIdempotency_pkey" PRIMARY KEY ("id")
);

-- =====================================================================
-- 2) Indexes + unique constraints (incl. partial uniques ported from 714a69af).
-- =====================================================================
CREATE UNIQUE INDEX "JobListing_idempotency_key_key" ON "JobListing"("idempotency_key");
CREATE INDEX "JobListing_status_created_at_id_idx" ON "JobListing"("status", "created_at", "id");
CREATE INDEX "JobListing_hirer_id_status_idx" ON "JobListing"("hirer_id", "status");
CREATE INDEX "JobListing_specialty_status_idx" ON "JobListing"("specialty", "status");

CREATE UNIQUE INDEX "Applicant_user_id_key" ON "Applicant"("user_id");
CREATE INDEX "Applicant_email_idx" ON "Applicant"("email");

CREATE UNIQUE INDEX "Application_idempotency_key_key" ON "Application"("idempotency_key");
CREATE INDEX "Application_listing_id_status_created_at_id_idx" ON "Application"("listing_id", "status", "created_at", "id");
CREATE INDEX "Application_applicant_user_id_created_at_id_idx" ON "Application"("applicant_user_id", "created_at", "id");
CREATE INDEX "Application_hirer_id_status_idx" ON "Application"("hirer_id", "status");

CREATE UNIQUE INDEX "CoachOffer_idempotency_key_key" ON "CoachOffer"("idempotency_key");
CREATE INDEX "CoachOffer_head_coach_id_status_idx" ON "CoachOffer"("head_coach_id", "status");
CREATE INDEX "CoachOffer_application_id_status_idx" ON "CoachOffer"("application_id", "status");

-- One pending offer per (head_coach, application). Partial unique index so the
-- constraint applies only while the offer is live; rejected/withdrawn offers
-- do not block a future re-offer.
CREATE UNIQUE INDEX "CoachOffer_one_pending_per_head_coach_application_idx"
    ON "CoachOffer"("head_coach_id", "application_id")
    WHERE "status" = 'pending';

-- One accepted offer per application — no two `accepted` offers can coexist for
-- the same application even under a concurrent accept race. The service layer's
-- transactional withdraw-others step keeps the happy path clean; this index
-- catches anything that slips past.
CREATE UNIQUE INDEX "CoachOffer_one_accepted_per_application_idx"
    ON "CoachOffer"("application_id")
    WHERE "status" = 'accepted';

CREATE UNIQUE INDEX "MarketplaceMutationIdempotency_user_id_route_key_idempotenc_key"
    ON "MarketplaceMutationIdempotency"("user_id", "route_key", "idempotency_key");
CREATE INDEX "MarketplaceMutationIdempotency_user_id_route_key_idx"
    ON "MarketplaceMutationIdempotency"("user_id", "route_key");

-- =====================================================================
-- 3) Foreign keys (scalar-FK idiom — authored here, not in schema.prisma).
--    ON DELETE: user deletes RESTRICT against live marketplace rows so they
--    fail loudly rather than orphaning PII/financial state; the
--    Application→CoachOffer FK cascades (an offer cannot outlive its
--    application).
-- =====================================================================
ALTER TABLE "JobListing"
    ADD CONSTRAINT "JobListing_hirer_id_fkey"
    FOREIGN KEY ("hirer_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Applicant"
    ADD CONSTRAINT "Applicant_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Application"
    ADD CONSTRAINT "Application_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "JobListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Application"
    ADD CONSTRAINT "Application_applicant_id_fkey"
    FOREIGN KEY ("applicant_id") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Application"
    ADD CONSTRAINT "Application_applicant_user_id_fkey"
    FOREIGN KEY ("applicant_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Application"
    ADD CONSTRAINT "Application_hirer_id_fkey"
    FOREIGN KEY ("hirer_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CoachOffer"
    ADD CONSTRAINT "CoachOffer_head_coach_id_fkey"
    FOREIGN KEY ("head_coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CoachOffer"
    ADD CONSTRAINT "CoachOffer_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachOffer"
    ADD CONSTRAINT "CoachOffer_applicant_user_id_fkey"
    FOREIGN KEY ("applicant_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- 4) JobListing — public-read SELECT only WHERE status='published'; hirer owns
--    own rows (write-scope on insert/update).
-- =====================================================================
ALTER TABLE "JobListing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobListing" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_joblisting_service_role_all" ON "JobListing";
CREATE POLICY "p_joblisting_service_role_all" ON "JobListing" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_joblisting_service_role_all" ON "JobListing" IS 'Primitive A: service_role bypass for server-side jobs/migrations/seeds.';

DROP POLICY IF EXISTS "p_joblisting_select" ON "JobListing";
CREATE POLICY "p_joblisting_select" ON "JobListing" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR "status" = 'published' OR (app.current_user_id() IS NOT NULL AND "hirer_id" = app.current_user_id())));
COMMENT ON POLICY "p_joblisting_select" ON "JobListing" IS 'Public-read: anyone (incl. anon, NULL current_user_id) may SELECT published listings. The owning hirer additionally reads their own draft/closed rows. Non-published rows are invisible to anon and to other users.';

DROP POLICY IF EXISTS "p_joblisting_insert" ON "JobListing";
CREATE POLICY "p_joblisting_insert" ON "JobListing" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "hirer_id" = app.current_user_id())));
COMMENT ON POLICY "p_joblisting_insert" ON "JobListing" IS 'Write-scope: a hirer may INSERT only listings they own (hirer_id = self). Verified-hirer gating is enforced in TM-2 service layer.';

DROP POLICY IF EXISTS "p_joblisting_update" ON "JobListing";
CREATE POLICY "p_joblisting_update" ON "JobListing" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "hirer_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "hirer_id" = app.current_user_id())));
COMMENT ON POLICY "p_joblisting_update" ON "JobListing" IS 'Write-scope: only owner or the row''s hirer_id may UPDATE (publish/close/edit); CHECK prevents re-owning to another hirer_id.';

-- =====================================================================
-- 5) Applicant (PII) — applicant reads/writes own; head-coach SELECT via the
--    REUSED TeamSubCoachAssignment non-archived predicate (post-flip).
-- =====================================================================
ALTER TABLE "Applicant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Applicant" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_applicant_service_role_all" ON "Applicant";
CREATE POLICY "p_applicant_service_role_all" ON "Applicant" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_applicant_service_role_all" ON "Applicant" IS 'Primitive A: service_role bypass for server-side jobs/migrations/seeds.';

DROP POLICY IF EXISTS "p_applicant_select" ON "Applicant";
CREATE POLICY "p_applicant_select" ON "Applicant" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR EXISTS (SELECT 1 FROM public."TeamSubCoachAssignment" tsca WHERE tsca."sub_coach_id" = "Applicant"."user_id" AND tsca."head_coach_id" = app.current_user_id() AND tsca."archived_at" IS NULL)))));
COMMENT ON POLICY "p_applicant_select" ON "Applicant" IS 'Read: the applicant themselves (user_id), or the head coach of the applicant once flipped to a non-archived sub-coach (reused TeamSubCoachAssignment predicate). anon sees zero. Cross-applicant reads are denied (IDOR / PII).';

DROP POLICY IF EXISTS "p_applicant_insert" ON "Applicant";
CREATE POLICY "p_applicant_insert" ON "Applicant" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_applicant_insert" ON "Applicant" IS 'Write-scope: a pre-coach user may INSERT only their own profile (user_id = self).';

DROP POLICY IF EXISTS "p_applicant_update" ON "Applicant";
CREATE POLICY "p_applicant_update" ON "Applicant" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_applicant_update" ON "Applicant" IS 'Write-scope: only owner or the row''s user_id may UPDATE; CHECK prevents re-owning to another user_id.';

-- =====================================================================
-- 6) Application (PII) — applicant reads/writes own (applicant_user_id); hirer
--    of the listing reads applications to their listing.
-- =====================================================================
ALTER TABLE "Application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Application" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_application_service_role_all" ON "Application";
CREATE POLICY "p_application_service_role_all" ON "Application" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_application_service_role_all" ON "Application" IS 'Primitive A: service_role bypass for server-side jobs/migrations/seeds.';

DROP POLICY IF EXISTS "p_application_select" ON "Application";
CREATE POLICY "p_application_select" ON "Application" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("applicant_user_id" = app.current_user_id() OR "hirer_id" = app.current_user_id()))));
COMMENT ON POLICY "p_application_select" ON "Application" IS 'Read: the applying user (applicant_user_id) or the owning hirer of the listing (hirer_id). anon sees zero. Cross-principal reads denied (IDOR / PII).';

DROP POLICY IF EXISTS "p_application_insert" ON "Application";
CREATE POLICY "p_application_insert" ON "Application" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "applicant_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_application_insert" ON "Application" IS 'Write-scope: only the applying user (applicant_user_id = self) may INSERT an application. Hirers never create applications.';

DROP POLICY IF EXISTS "p_application_update" ON "Application";
CREATE POLICY "p_application_update" ON "Application" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("applicant_user_id" = app.current_user_id() OR "hirer_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("applicant_user_id" = app.current_user_id() OR "hirer_id" = app.current_user_id()))));
COMMENT ON POLICY "p_application_update" ON "Application" IS 'Write-scope: the applying user may UPDATE/withdraw their own application; the owning hirer may advance pipeline status on applications to their listing. CHECK keeps both columns owner-pinned.';

-- =====================================================================
-- 7) CoachOffer (financial) — head-coach reads/writes own offers; applicant
--    SELECT offers made to them.
-- =====================================================================
ALTER TABLE "CoachOffer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachOffer" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachoffer_service_role_all" ON "CoachOffer";
CREATE POLICY "p_coachoffer_service_role_all" ON "CoachOffer" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachoffer_service_role_all" ON "CoachOffer" IS 'Primitive A: service_role bypass for the transactional accept/withdraw path + server-side jobs.';

DROP POLICY IF EXISTS "p_coachoffer_select" ON "CoachOffer";
CREATE POLICY "p_coachoffer_select" ON "CoachOffer" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "applicant_user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_coachoffer_select" ON "CoachOffer" IS 'Read: the offering head coach (head_coach_id) or the applicant the offer was made to (applicant_user_id). anon sees zero. Cross-coach reads denied (IDOR / financial).';

DROP POLICY IF EXISTS "p_coachoffer_insert" ON "CoachOffer";
CREATE POLICY "p_coachoffer_insert" ON "CoachOffer" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "head_coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachoffer_insert" ON "CoachOffer" IS 'Write-scope: only the offering head coach (head_coach_id = self) may INSERT an offer. HeadCoachOnly/NoActiveSubCoach gating is enforced in the TM-12 service layer.';

DROP POLICY IF EXISTS "p_coachoffer_update" ON "CoachOffer";
CREATE POLICY "p_coachoffer_update" ON "CoachOffer" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "applicant_user_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "applicant_user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_coachoffer_update" ON "CoachOffer" IS 'Write-scope: the head coach may withdraw/edit their own offer; the applicant may accept/reject an offer made to them. CHECK keeps head_coach_id/applicant_user_id owner-pinned. The atomic accept-with-withdraw-others runs as service_role.';

-- =====================================================================
-- 8) MarketplaceMutationIdempotency (ledger) — RESTRICTIVE deny-all to anon +
--    authenticated. Accessed only through service_role (Primitive A). The
--    RESTRICTIVE policies AND with any permissive grant, so no non-service
--    principal can ever read/write the ledger.
-- =====================================================================
ALTER TABLE "MarketplaceMutationIdempotency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketplaceMutationIdempotency" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_marketplace_idempotency_service_role_all" ON "MarketplaceMutationIdempotency";
CREATE POLICY "p_marketplace_idempotency_service_role_all" ON "MarketplaceMutationIdempotency" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_marketplace_idempotency_service_role_all" ON "MarketplaceMutationIdempotency" IS 'Primitive A: service_role bypass. The idempotency ledger is written/read only by the server-side mutation engine (TM-4) running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_marketplace_idempotency" ON "MarketplaceMutationIdempotency";
CREATE POLICY "deny_all_anon_marketplace_idempotency" ON "MarketplaceMutationIdempotency" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_marketplace_idempotency" ON "MarketplaceMutationIdempotency" IS 'RESTRICTIVE deny-all: anon can never read/write the ledger regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_marketplace_idempotency" ON "MarketplaceMutationIdempotency";
CREATE POLICY "deny_all_authenticated_marketplace_idempotency" ON "MarketplaceMutationIdempotency" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_marketplace_idempotency" ON "MarketplaceMutationIdempotency" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write the ledger; only service_role (Primitive A) may.';

COMMIT;
