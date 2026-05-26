-- R49 Coach Landing Page Custom Domains — Phase 4.
--
-- 1. Adds 2 Postgres ENUM types matching the Prisma enums added in
--    schema.prisma: DomainVerificationStatus, DomainCertStatus.
--
-- 2. Creates 1 new table:
--      coach_landing_page_domain — per-domain DNS + cert state.
--    @@map() in the Prisma model makes this snake_case so DB-level
--    JOINs from analytics dashboards read naturally; all other R46/R47
--    landing tables use PascalCase but those are pure-Prisma tables.
--    The snake_case here is deliberate and isolated.
--
-- 3. Adds indexes for the three access patterns:
--      - Coach mgmt: list all of a coach's domains.
--      - SNI middleware: resolve by hostname (@unique already covers,
--        explicit @@index is dedup'd by Prisma).
--      - Cert worker: scan by (verification_status, cert_status) to
--        claim rows that need DNS verify, cert issue, or renewal.
--
-- 4. Locks the new table with RLS ENABLE + FORCE + deny-all RESTRICTIVE
--    policies, mirroring R43 / R46 / R47 exactly.  The Prisma client
--    connects as the service role and bypasses RLS.  No PostgREST or
--    client-authed path reaches this table directly.
--
-- 5. Documents rollback in commented-out form at the foot of the file.

-- ─── Step 1: ENUM types ──────────────────────────────────────────────────────

-- DomainVerificationStatus — DNS-verification state machine (pending → verified
-- after both TXT + CNAME records check out; failed after the worker gives up;
-- revoked when the coach DELETEs the domain).
DO $$ BEGIN
    CREATE TYPE "DomainVerificationStatus" AS ENUM (
        'pending',
        'verified',
        'failed',
        'revoked'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DomainCertStatus — Fly-managed Let's Encrypt cert lifecycle. `requested`
-- is the in-flight ACME state; `issued` flips to `expired` if a renewal
-- check sees the cert is past its acme_expires_at.
DO $$ BEGIN
    CREATE TYPE "DomainCertStatus" AS ENUM (
        'none',
        'requested',
        'issued',
        'failed',
        'expired'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Step 2: coach_landing_page_domain table ─────────────────────────────────

-- A coach may claim multiple custom domains across their pages.  The
-- unique constraint on `domain` is the hard guard against two coaches
-- ever pointing the same hostname at the platform; we ALSO unique-index
-- it via @unique in the schema (the explicit CREATE UNIQUE INDEX below
-- is what Prisma emits for that).
--
-- FK ON DELETE CASCADE on both `coach_id` and `landing_page_id` so a
-- page hard-delete (rare; spec §9 only allows status transitions) or a
-- coach account hard-delete (GDPR right-to-erasure) cleans the domain
-- row without leaving an orphaned cert request behind.  The cert itself
-- is removed via Fly's `removeCertificate` mutation in the worker.
CREATE TABLE IF NOT EXISTS "coach_landing_page_domain" (
    "id"                   TEXT                       NOT NULL PRIMARY KEY,
    "coach_id"             TEXT                       NOT NULL,
    "landing_page_id"      TEXT                       NOT NULL,
    "domain"               TEXT                       NOT NULL,
    "verification_token"   TEXT                       NOT NULL,
    "verification_status"  "DomainVerificationStatus" NOT NULL DEFAULT 'pending',
    "cert_status"          "DomainCertStatus"         NOT NULL DEFAULT 'none',
    "cert_issued_at"       TIMESTAMP(3),
    "cert_expires_at"      TIMESTAMP(3),
    "fly_cert_id"          TEXT,
    "last_check_at"        TIMESTAMP(3),
    "last_error"           TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_landing_page_domain_coach_id_fkey"
        FOREIGN KEY ("coach_id") REFERENCES "User" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "coach_landing_page_domain_landing_page_id_fkey"
        FOREIGN KEY ("landing_page_id") REFERENCES "CoachLandingPage" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- ─── Step 3: Indexes ─────────────────────────────────────────────────────────

-- Hard guarantee that no two rows ever hold the same hostname.
CREATE UNIQUE INDEX IF NOT EXISTS "coach_landing_page_domain_domain_key"
    ON "coach_landing_page_domain" ("domain");

-- Coach mgmt screen: list all domains for a coach.
CREATE INDEX IF NOT EXISTS "coach_landing_page_domain_coach_id_idx"
    ON "coach_landing_page_domain" ("coach_id");

-- Cert worker: scan rows by (verification_status, cert_status) to find
-- work — verified+none (need to request cert), verified+requested (need
-- to poll), issued+near-expiry (need to renew).
CREATE INDEX IF NOT EXISTS "coach_landing_page_domain_verification_status_cert_status_idx"
    ON "coach_landing_page_domain" ("verification_status", "cert_status");

-- ─── Step 4: Row-Level Security ──────────────────────────────────────────────
-- Pattern mirrors R43 / R46 / R47 exactly: ENABLE + FORCE + deny-all
-- RESTRICTIVE policies.  The Prisma client bypasses RLS as the service
-- role, which is the ONLY write path.

ALTER TABLE "coach_landing_page_domain" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "coach_landing_page_domain" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "domain_deny_all_select" ON "coach_landing_page_domain";
DROP POLICY IF EXISTS "domain_deny_all_insert" ON "coach_landing_page_domain";
DROP POLICY IF EXISTS "domain_deny_all_update" ON "coach_landing_page_domain";
DROP POLICY IF EXISTS "domain_deny_all_delete" ON "coach_landing_page_domain";

CREATE POLICY "domain_deny_all_select" ON "coach_landing_page_domain"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "domain_deny_all_insert" ON "coach_landing_page_domain"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "domain_deny_all_update" ON "coach_landing_page_domain"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "domain_deny_all_delete" ON "coach_landing_page_domain"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ─── Reversibility ───────────────────────────────────────────────────────────
-- Forward-only in production.  Operator rollback (reverse order):
--
-- DROP POLICY IF EXISTS "domain_deny_all_delete" ON "coach_landing_page_domain";
-- DROP POLICY IF EXISTS "domain_deny_all_update" ON "coach_landing_page_domain";
-- DROP POLICY IF EXISTS "domain_deny_all_insert" ON "coach_landing_page_domain";
-- DROP POLICY IF EXISTS "domain_deny_all_select" ON "coach_landing_page_domain";
-- ALTER TABLE "coach_landing_page_domain" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "coach_landing_page_domain" DISABLE ROW LEVEL SECURITY;
--
-- DROP INDEX IF EXISTS "coach_landing_page_domain_verification_status_cert_status_idx";
-- DROP INDEX IF EXISTS "coach_landing_page_domain_coach_id_idx";
-- DROP INDEX IF EXISTS "coach_landing_page_domain_domain_key";
-- DROP TABLE IF EXISTS "coach_landing_page_domain";
--
-- DROP TYPE IF EXISTS "DomainCertStatus";
-- DROP TYPE IF EXISTS "DomainVerificationStatus";
