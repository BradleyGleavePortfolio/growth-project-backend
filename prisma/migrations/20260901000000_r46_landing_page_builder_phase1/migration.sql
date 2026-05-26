-- R46 Landing Page Builder — Phase 1: schema + RLS + migration.
--
-- 1. Creates 6 Postgres ENUM types matching the 6 Prisma enums added in
--    schema.prisma.  We use native ENUM types (not TEXT + CHECK) so that
--    pg_dump, psql \d, and Supabase Studio all show the domain correctly.
--    The Prisma generator uses @db.Text for enum columns by default but
--    we declare the native types here so the CHECK constraints at the DB
--    layer are redundant — ENUM itself rejects out-of-range values.
--
-- 2. Creates 5 new tables:
--      CoachLandingPage          — a coach's public sales page
--      CoachLandingPageSection   — ordered content blocks within a page
--      CoachLandingLead          — lead form submissions
--      CoachLandingPageView      — anonymized page-view analytics events
--      CoachCrmIntegration       — per-coach CRM connection config
--
-- 3. Creates all indexes required for the access patterns listed in spec §4.
--
-- 4. Locks all 5 tables with RLS ENABLE + FORCE + deny-all RESTRICTIVE
--    policies.  Design mirrors R43 Storefront Phase 1 (GuestCheckout
--    pattern): the Prisma client connects as the service role and bypasses
--    RLS; no PostgREST / client-authed path reaches these tables directly.
--    Coach-scoped tables (CoachLandingPage, CoachLandingLead,
--    CoachCrmIntegration) additionally get an explicit note explaining that
--    the SELECT policy will be replaced by a coach-scoped permissive policy
--    in a future migration when/if we expose a direct Supabase Realtime
--    subscription.  For now: service-role-only.
--
-- 5. Documents design decisions and rollback order in comments.

-- ─── Step 1: ENUM types ──────────────────────────────────────────────────────

-- LandingPageTemplate: the four locked design templates (spec §3.1).
DO $$ BEGIN
    CREATE TYPE "LandingPageTemplate" AS ENUM (
        'transformation',
        'authority',
        'community',
        'offer'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- LandingPageStatus: draft → published → archived lifecycle (spec §3.1).
DO $$ BEGIN
    CREATE TYPE "LandingPageStatus" AS ENUM (
        'draft',
        'published',
        'archived'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- LandingCtaType: what happens when a visitor hits the primary CTA (spec §3.2).
-- 'checkout' MUST route through TGP GuestCheckout — server validates in PR #2.
DO $$ BEGIN
    CREATE TYPE "LandingCtaType" AS ENUM (
        'checkout',
        'lead_form',
        'book_call'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- LandingSectionKind: the eight locked content archetypes (spec §2 #3, Miller's Law).
-- Max 6 active sections per page is enforced at the service layer (PR #2).
DO $$ BEGIN
    CREATE TYPE "LandingSectionKind" AS ENUM (
        'hero',
        'before_after',
        'testimonials',
        'pricing',
        'faq',
        'lead_form',
        'offer_stack',
        'guarantee'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CrmSyncStatus: lifecycle of a CoachLandingLead's outbound CRM push (spec §7).
-- Lead written with 'pending' FIRST before any CRM call — never lose a lead.
DO $$ BEGIN
    CREATE TYPE "CrmSyncStatus" AS ENUM (
        'pending',
        'synced',
        'failed',
        'skipped'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CrmProvider: the five CRM/automation targets shipped in v1 (spec §7).
-- 'webhook' covers generic HTTP destinations (Zapier, Make, n8n, custom).
DO $$ BEGIN
    CREATE TYPE "CrmProvider" AS ENUM (
        'hubspot',
        'gohighlevel',
        'mailchimp',
        'activecampaign',
        'webhook'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Step 2: CoachCrmIntegration ─────────────────────────────────────────────
-- Created BEFORE CoachLandingPage because CoachLandingPage has an FK into it.
--
-- One row per (coach, provider) is NOT enforced at the DB layer — the spec
-- allows one integration per provider, but the uniqueness check lives in the
-- service layer (PR #2) so coaches can safely clean up duplicates before the
-- constraint is introduced in a future migration if needed.
--
-- credentials_encrypted: AES-256-GCM ciphertext keyed by LANDING_CRM_AES_KEY.
-- field_mapping: JSONB — map of TGP lead field names → CRM field IDs.

CREATE TABLE IF NOT EXISTS "CoachCrmIntegration" (
    "id"                    TEXT          NOT NULL PRIMARY KEY,
    "coach_id"              TEXT          NOT NULL,
    "provider"              "CrmProvider" NOT NULL,
    "credentials_encrypted" TEXT          NOT NULL,
    "field_mapping"         JSONB         NOT NULL DEFAULT '{}',
    "enabled"               BOOLEAN       NOT NULL DEFAULT TRUE,
    "last_synced_at"        TIMESTAMP(3),
    "last_error"            TEXT,
    "created_at"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachCrmIntegration_coach_id_fkey"
        FOREIGN KEY ("coach_id") REFERENCES "User" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Fast "list all integrations for coach" query from the CRM settings screen.
CREATE INDEX IF NOT EXISTS "CoachCrmIntegration_coach_id_idx"
    ON "CoachCrmIntegration" ("coach_id");

-- ─── Step 3: CoachLandingPage ─────────────────────────────────────────────────
--
-- package_ids: TEXT[] — denormalized CoachPackage IDs.  No FK into CoachPackage
-- to avoid cascade complexity; ownership is validated at write time in the
-- service layer (PR #2).
--
-- lead_capture_fields: TEXT[] — ordered subset of ["name","email","phone","goal"].
-- Validated in service layer; "email" is always present for lead_form CTA type.
--
-- crm_integration_id: nullable FK into CoachCrmIntegration.  SET NULL on delete
-- so removing an integration does not cascade-delete all pages that used it.
--
-- custom_domain: null on free-tier coaches.  Uniqueness across coaches is
-- enforced by the index below — two coaches cannot claim the same domain.

CREATE TABLE IF NOT EXISTS "CoachLandingPage" (
    "id"                        TEXT                  NOT NULL PRIMARY KEY,
    "coach_id"                  TEXT                  NOT NULL,
    "slug"                      TEXT                  NOT NULL,
    "template"                  "LandingPageTemplate" NOT NULL,
    "status"                    "LandingPageStatus"   NOT NULL DEFAULT 'draft',
    "headline"                  VARCHAR(120)          NOT NULL,
    "subheadline"               VARCHAR(280),
    "hero_image_url"            TEXT,
    "accent_color"              TEXT,
    "primary_cta_type"          "LandingCtaType"      NOT NULL,
    "primary_cta_label"         VARCHAR(40)           NOT NULL,
    "package_ids"               TEXT[]                NOT NULL DEFAULT '{}',
    "lead_capture_fields"       TEXT[]                NOT NULL DEFAULT '{}',
    "crm_integration_id"        TEXT,
    "custom_domain"             TEXT,
    "custom_domain_verified_at" TIMESTAMP(3),
    "published_at"              TIMESTAMP(3),
    "unpublished_at"            TIMESTAMP(3),
    "created_at"                TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachLandingPage_coach_id_fkey"
        FOREIGN KEY ("coach_id") REFERENCES "User" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- SET NULL so removing an integration does not cascade-delete pages.
    CONSTRAINT "CoachLandingPage_crm_integration_id_fkey"
        FOREIGN KEY ("crm_integration_id") REFERENCES "CoachCrmIntegration" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- Per-coach slug uniqueness — two coaches can pick the same slug word but not
-- the same (coach_id, slug) pair.
CREATE UNIQUE INDEX IF NOT EXISTS "CoachLandingPage_coach_id_slug_key"
    ON "CoachLandingPage" ("coach_id", "slug");

-- Primary coach-dashboard list query: filter by coach + status.
CREATE INDEX IF NOT EXISTS "CoachLandingPage_coach_id_status_idx"
    ON "CoachLandingPage" ("coach_id", "status");

-- Custom-domain uniqueness for the SNI router (Fly cert + public renderer, PR #4).
-- @@unique so two coaches cannot claim the same domain.  Postgres unique indexes
-- treat multiple NULLs as distinct, so free-tier rows (null custom_domain) do not
-- collide — no WHERE clause needed.
-- Audit note (mirrors R43 CoachPackage_share_token_key rationale): if the table
-- is large in staging/prod, build this index CONCURRENTLY via psql before running
-- prisma migrate deploy — the IF NOT EXISTS guard makes it idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "CoachLandingPage_custom_domain_key"
    ON "CoachLandingPage" ("custom_domain");

-- Analytics feed: list published pages ordered by publish date.
CREATE INDEX IF NOT EXISTS "CoachLandingPage_status_published_at_idx"
    ON "CoachLandingPage" ("status", "published_at");

-- ─── Step 4: CoachLandingPageSection ─────────────────────────────────────────
--
-- Section payload is JSONB; shape is validated per-kind in the service layer
-- (PR #2) via per-kind Zod schemas.  Keeping it as a single JSONB column
-- avoids 8 separate tables for v1 while leaving room for future stricter
-- column extraction if needed.
--
-- order_index is 0-based.  The @@unique([page_id, order_index]) constraint
-- ensures no two sections share a slot; a reorder operation must update all
-- affected indexes in a single transaction.

CREATE TABLE IF NOT EXISTS "CoachLandingPageSection" (
    "id"          TEXT                 NOT NULL PRIMARY KEY,
    "page_id"     TEXT                 NOT NULL,
    "kind"        "LandingSectionKind" NOT NULL,
    "order_index" INTEGER              NOT NULL,
    "payload"     JSONB                NOT NULL DEFAULT '{}',
    CONSTRAINT "CoachLandingPageSection_page_id_fkey"
        FOREIGN KEY ("page_id") REFERENCES "CoachLandingPage" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Enforce no duplicate order slot within a page.
CREATE UNIQUE INDEX IF NOT EXISTS "CoachLandingPageSection_page_id_order_index_key"
    ON "CoachLandingPageSection" ("page_id", "order_index");

-- Page render: load all sections for a page (ordered by order_index in query).
CREATE INDEX IF NOT EXISTS "CoachLandingPageSection_page_id_idx"
    ON "CoachLandingPageSection" ("page_id");

-- ─── Step 5: CoachLandingLead ─────────────────────────────────────────────────
--
-- Every form submission is written here FIRST with crm_sync_status='pending'
-- before any CRM API call.  A BullMQ worker (PR #3) transitions the status.
-- This guarantees zero lead loss even if the CRM is down.
--
-- coach_id is denormalized from page.coach_id so the coach inbox query can
-- hit a single index without a page join.
--
-- converted_user_id is a soft reference (no FK) — the lead may convert to a
-- TGP User after signup, but we do not want the User hard-delete cascade to
-- remove historical lead records.
--
-- email is NOT indexed separately — consistent with R43 GuestCheckout audit
-- P2-6 reasoning (PII in index leaf pages, no runtime lookup by email).

CREATE TABLE IF NOT EXISTS "CoachLandingLead" (
    "id"                TEXT           NOT NULL PRIMARY KEY,
    "page_id"           TEXT           NOT NULL,
    "coach_id"          TEXT           NOT NULL,
    "email"             TEXT           NOT NULL,
    "name"              TEXT,
    "phone"             TEXT,
    "payload"           JSONB          NOT NULL DEFAULT '{}',
    "crm_sync_status"   "CrmSyncStatus" NOT NULL DEFAULT 'pending',
    "crm_synced_at"     TIMESTAMP(3),
    "crm_error"         TEXT,
    "converted_user_id" TEXT,
    "created_at"        TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachLandingLead_page_id_fkey"
        FOREIGN KEY ("page_id") REFERENCES "CoachLandingPage" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    -- Intentionally NO FK on coach_id: coach_id is denormalized from
    -- CoachLandingPage.coach_id and adding a second FK against User would
    -- create a redundant constraint path. If the coach's User row is
    -- hard-deleted, the page CASCADE already handles cleanup.
    -- Intentionally NO FK on converted_user_id: see comment above.
);

-- Coach lead inbox: list leads for a page, newest first.
CREATE INDEX IF NOT EXISTS "CoachLandingLead_page_id_created_at_idx"
    ON "CoachLandingLead" ("page_id", "created_at" DESC);

-- Coach dashboard: all leads across all pages for one coach, newest first.
CREATE INDEX IF NOT EXISTS "CoachLandingLead_coach_id_created_at_idx"
    ON "CoachLandingLead" ("coach_id", "created_at" DESC);

-- CRM sync worker: claim all pending leads in one index scan.
CREATE INDEX IF NOT EXISTS "CoachLandingLead_crm_sync_status_idx"
    ON "CoachLandingLead" ("crm_sync_status");

-- ─── Step 6: CoachLandingPageView ────────────────────────────────────────────
--
-- Anonymized analytics event.  ip_hash and ua_hash are SHA-256(rawValue +
-- dailySalt).  The salt rotates every midnight UTC so hashes cannot be
-- correlated across days — satisfies GDPR Art. 4(1) (no longer PII once
-- the daily key is discarded).
--
-- Inserted by sendBeacon at page unload.  Throttled at 30/min/IP by the
-- public renderer (PR #2) so this table cannot be flooded by bots.

CREATE TABLE IF NOT EXISTS "CoachLandingPageView" (
    "id"             TEXT         NOT NULL PRIMARY KEY,
    "page_id"        TEXT         NOT NULL,
    "ip_hash"        TEXT         NOT NULL,
    "ua_hash"        TEXT         NOT NULL,
    "referrer_host"  TEXT,
    "utm_source"     TEXT,
    "utm_medium"     TEXT,
    "utm_campaign"   TEXT,
    "scroll_depth"   INTEGER,
    "cta_clicked"    BOOLEAN      NOT NULL DEFAULT FALSE,
    "form_submitted" BOOLEAN      NOT NULL DEFAULT FALSE,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachLandingPageView_page_id_fkey"
        FOREIGN KEY ("page_id") REFERENCES "CoachLandingPage" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Analytics time-series: views for a page over a date range.
CREATE INDEX IF NOT EXISTS "CoachLandingPageView_page_id_created_at_idx"
    ON "CoachLandingPageView" ("page_id", "created_at" DESC);

-- ─── Step 7: Row-Level Security ───────────────────────────────────────────────
--
-- Pattern mirrors R43 Storefront Phase 1 (GuestCheckout) exactly:
--   ENABLE + FORCE so even the table owner (Supabase pgAdmin role) cannot
--   read or write rows unless a policy matches.
--   RESTRICTIVE deny-all policies for SELECT / INSERT / UPDATE / DELETE.
--   RESTRICTIVE policies AND with any future PERMISSIVE policies — so zero
--   rows are visible to non-service-role connections until an explicit
--   permissive policy is added.
--   The Prisma client connects as the service role, which bypasses RLS.
--
-- Note on future coach-scoped permissive policies: when/if we expose a
-- Supabase Realtime subscription for live lead notifications, we will add:
--   CREATE POLICY "coach_own_rows_select" ON "CoachLandingPage"
--     AS PERMISSIVE FOR SELECT
--     USING (coach_id = auth.uid()::text);
-- That migration will be a separate PR so the RLS surface is auditable
-- in isolation.

-- ── CoachLandingPage RLS ──────────────────────────────────────────────────────

ALTER TABLE "CoachLandingPage" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "CoachLandingPage" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "landing_page_deny_all_select" ON "CoachLandingPage";
DROP POLICY IF EXISTS "landing_page_deny_all_insert" ON "CoachLandingPage";
DROP POLICY IF EXISTS "landing_page_deny_all_update" ON "CoachLandingPage";
DROP POLICY IF EXISTS "landing_page_deny_all_delete" ON "CoachLandingPage";

CREATE POLICY "landing_page_deny_all_select" ON "CoachLandingPage"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "landing_page_deny_all_insert" ON "CoachLandingPage"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "landing_page_deny_all_update" ON "CoachLandingPage"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "landing_page_deny_all_delete" ON "CoachLandingPage"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ── CoachLandingPageSection RLS ───────────────────────────────────────────────
-- Sections are always accessed via a page join inside LandingPageService —
-- no direct public or coach-authed path hits this table. Deny-all.

ALTER TABLE "CoachLandingPageSection" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "CoachLandingPageSection" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "landing_section_deny_all_select" ON "CoachLandingPageSection";
DROP POLICY IF EXISTS "landing_section_deny_all_insert" ON "CoachLandingPageSection";
DROP POLICY IF EXISTS "landing_section_deny_all_update" ON "CoachLandingPageSection";
DROP POLICY IF EXISTS "landing_section_deny_all_delete" ON "CoachLandingPageSection";

CREATE POLICY "landing_section_deny_all_select" ON "CoachLandingPageSection"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "landing_section_deny_all_insert" ON "CoachLandingPageSection"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "landing_section_deny_all_update" ON "CoachLandingPageSection"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "landing_section_deny_all_delete" ON "CoachLandingPageSection"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ── CoachLandingLead RLS ──────────────────────────────────────────────────────
-- Leads contain PII (email, name, phone).  Service-role bypass only.
-- Coach reads happen via LandingPageService.listLeads — never direct DB.

ALTER TABLE "CoachLandingLead" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "CoachLandingLead" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "landing_lead_deny_all_select" ON "CoachLandingLead";
DROP POLICY IF EXISTS "landing_lead_deny_all_insert" ON "CoachLandingLead";
DROP POLICY IF EXISTS "landing_lead_deny_all_update" ON "CoachLandingLead";
DROP POLICY IF EXISTS "landing_lead_deny_all_delete" ON "CoachLandingLead";

CREATE POLICY "landing_lead_deny_all_select" ON "CoachLandingLead"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "landing_lead_deny_all_insert" ON "CoachLandingLead"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "landing_lead_deny_all_update" ON "CoachLandingLead"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "landing_lead_deny_all_delete" ON "CoachLandingLead"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ── CoachLandingPageView RLS ──────────────────────────────────────────────────
-- Analytics events.  Written via service role only (sendBeacon → NestJS →
-- LandingPagePublicService).  Deny-all keeps raw hashes off direct-DB paths.

ALTER TABLE "CoachLandingPageView" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "CoachLandingPageView" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "landing_view_deny_all_select" ON "CoachLandingPageView";
DROP POLICY IF EXISTS "landing_view_deny_all_insert" ON "CoachLandingPageView";
DROP POLICY IF EXISTS "landing_view_deny_all_update" ON "CoachLandingPageView";
DROP POLICY IF EXISTS "landing_view_deny_all_delete" ON "CoachLandingPageView";

CREATE POLICY "landing_view_deny_all_select" ON "CoachLandingPageView"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "landing_view_deny_all_insert" ON "CoachLandingPageView"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "landing_view_deny_all_update" ON "CoachLandingPageView"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "landing_view_deny_all_delete" ON "CoachLandingPageView"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ── CoachCrmIntegration RLS ───────────────────────────────────────────────────
-- CRM credentials are encrypted but still sensitive config.  Service-role only.
-- Coach reads happen via CoachCrmService — never direct DB.

ALTER TABLE "CoachCrmIntegration" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "CoachCrmIntegration" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_integration_deny_all_select" ON "CoachCrmIntegration";
DROP POLICY IF EXISTS "crm_integration_deny_all_insert" ON "CoachCrmIntegration";
DROP POLICY IF EXISTS "crm_integration_deny_all_update" ON "CoachCrmIntegration";
DROP POLICY IF EXISTS "crm_integration_deny_all_delete" ON "CoachCrmIntegration";

CREATE POLICY "crm_integration_deny_all_select" ON "CoachCrmIntegration"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "crm_integration_deny_all_insert" ON "CoachCrmIntegration"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "crm_integration_deny_all_update" ON "CoachCrmIntegration"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "crm_integration_deny_all_delete" ON "CoachCrmIntegration"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ─── Reversibility (mirrors R43 P3-2 pattern) ────────────────────────────────
-- This migration is forward-only in production.  The block below documents the
-- exact reverse order so an operator can roll back in dev/staging if the
-- landing-page launch is aborted.  Statements are commented out so
-- `prisma migrate deploy` does not execute them.
--
-- ROLLBACK (reverse order — RLS → indexes → tables → ENUM types):
--
-- DROP POLICY IF EXISTS "crm_integration_deny_all_delete"  ON "CoachCrmIntegration";
-- DROP POLICY IF EXISTS "crm_integration_deny_all_update"  ON "CoachCrmIntegration";
-- DROP POLICY IF EXISTS "crm_integration_deny_all_insert"  ON "CoachCrmIntegration";
-- DROP POLICY IF EXISTS "crm_integration_deny_all_select"  ON "CoachCrmIntegration";
-- ALTER TABLE "CoachCrmIntegration" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachCrmIntegration" DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "landing_view_deny_all_delete"  ON "CoachLandingPageView";
-- DROP POLICY IF EXISTS "landing_view_deny_all_update"  ON "CoachLandingPageView";
-- DROP POLICY IF EXISTS "landing_view_deny_all_insert"  ON "CoachLandingPageView";
-- DROP POLICY IF EXISTS "landing_view_deny_all_select"  ON "CoachLandingPageView";
-- ALTER TABLE "CoachLandingPageView" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachLandingPageView" DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "landing_lead_deny_all_delete"  ON "CoachLandingLead";
-- DROP POLICY IF EXISTS "landing_lead_deny_all_update"  ON "CoachLandingLead";
-- DROP POLICY IF EXISTS "landing_lead_deny_all_insert"  ON "CoachLandingLead";
-- DROP POLICY IF EXISTS "landing_lead_deny_all_select"  ON "CoachLandingLead";
-- ALTER TABLE "CoachLandingLead" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachLandingLead" DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "landing_section_deny_all_delete"  ON "CoachLandingPageSection";
-- DROP POLICY IF EXISTS "landing_section_deny_all_update"  ON "CoachLandingPageSection";
-- DROP POLICY IF EXISTS "landing_section_deny_all_insert"  ON "CoachLandingPageSection";
-- DROP POLICY IF EXISTS "landing_section_deny_all_select"  ON "CoachLandingPageSection";
-- ALTER TABLE "CoachLandingPageSection" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachLandingPageSection" DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "landing_page_deny_all_delete"  ON "CoachLandingPage";
-- DROP POLICY IF EXISTS "landing_page_deny_all_update"  ON "CoachLandingPage";
-- DROP POLICY IF EXISTS "landing_page_deny_all_insert"  ON "CoachLandingPage";
-- DROP POLICY IF EXISTS "landing_page_deny_all_select"  ON "CoachLandingPage";
-- ALTER TABLE "CoachLandingPage" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachLandingPage" DISABLE ROW LEVEL SECURITY;
--
-- DROP INDEX IF EXISTS "CoachLandingPageView_page_id_created_at_idx";
-- DROP TABLE IF EXISTS "CoachLandingPageView";
--
-- DROP INDEX IF EXISTS "CoachLandingLead_crm_sync_status_idx";
-- DROP INDEX IF EXISTS "CoachLandingLead_coach_id_created_at_idx";
-- DROP INDEX IF EXISTS "CoachLandingLead_page_id_created_at_idx";
-- DROP TABLE IF EXISTS "CoachLandingLead";
--
-- DROP INDEX IF EXISTS "CoachLandingPageSection_page_id_idx";
-- DROP INDEX IF EXISTS "CoachLandingPageSection_page_id_order_index_key";
-- DROP TABLE IF EXISTS "CoachLandingPageSection";
--
-- DROP INDEX IF EXISTS "CoachLandingPage_status_published_at_idx";
-- DROP INDEX IF EXISTS "CoachLandingPage_custom_domain_key";   -- unique index on custom_domain
-- DROP INDEX IF EXISTS "CoachLandingPage_coach_id_status_idx";
-- DROP INDEX IF EXISTS "CoachLandingPage_coach_id_slug_key";   -- unique index on (coach_id, slug)
-- DROP TABLE IF EXISTS "CoachLandingPage";
--
-- DROP INDEX IF EXISTS "CoachCrmIntegration_coach_id_idx";
-- DROP TABLE IF EXISTS "CoachCrmIntegration";
--
-- DROP TYPE IF EXISTS "CrmProvider";
-- DROP TYPE IF EXISTS "CrmSyncStatus";
-- DROP TYPE IF EXISTS "LandingSectionKind";
-- DROP TYPE IF EXISTS "LandingCtaType";
-- DROP TYPE IF EXISTS "LandingPageStatus";
-- DROP TYPE IF EXISTS "LandingPageTemplate";
