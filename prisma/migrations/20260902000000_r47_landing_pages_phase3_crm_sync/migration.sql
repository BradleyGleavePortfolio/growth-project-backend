-- R47 Landing Page Builder — Phase 3: CRM sync + analytics linkage.
--
-- 1. Extends CoachLandingLead with per-provider sync metadata:
--      synced_to TEXT[]   — providers that have ACK'd this lead
--      external_ids JSONB — provider → external id returned by the API
--    These let the worker push to multiple CRMs in parallel and avoid
--    re-pushing already-synced leads on retry.
--
-- 2. Adds GuestCheckout.landing_page_id (nullable TEXT) — when a checkout
--    originated from a CoachLandingPage's CTA the storefront stamps this
--    so the GET /coach/landing-pages/:id/analytics endpoint can compute
--    $/visitor without scanning checkout metadata.  Index supports the
--    revenue rollup query (landing_page_id, status).
--
-- 3. RLS posture is unchanged.  Both tables already have FORCE RLS +
--    deny-all restrictive policies from r43 (GuestCheckout) and r46
--    (CoachLandingLead).  Adding columns / indexes does not weaken those
--    policies — the new columns inherit the same protection.

-- ─── Step 1: CoachLandingLead per-provider sync state ────────────────────────

ALTER TABLE "CoachLandingLead"
    ADD COLUMN IF NOT EXISTS "synced_to" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "CoachLandingLead"
    ADD COLUMN IF NOT EXISTS "external_ids" JSONB NOT NULL DEFAULT '{}';

-- ─── Step 2: GuestCheckout landing-page linkage ──────────────────────────────

ALTER TABLE "GuestCheckout"
    ADD COLUMN IF NOT EXISTS "landing_page_id" TEXT;

-- Revenue rollup for analytics endpoint:
--   SELECT SUM(amount_cents) FROM GuestCheckout
--   WHERE landing_page_id = $1 AND status IN ('paid','converted')
-- The composite (landing_page_id, status) index serves both the filter
-- and the per-status breakdown variant.  Partial index would shave a few
-- bytes but the table is small enough that a full composite is simpler.
CREATE INDEX IF NOT EXISTS "GuestCheckout_landing_page_id_status_idx"
    ON "GuestCheckout" ("landing_page_id", "status");

-- ─── Reversibility (mirrors R46 P3 pattern) ──────────────────────────────────
-- This migration is forward-only in production.  The block below documents
-- the exact reverse order so an operator can roll back in dev/staging if
-- the Phase 3 rollout is aborted.  Statements are commented out so
-- `prisma migrate deploy` does not execute them.
--
-- ROLLBACK (reverse order):
--
-- DROP INDEX IF EXISTS "GuestCheckout_landing_page_id_status_idx";
-- ALTER TABLE "GuestCheckout"   DROP COLUMN IF EXISTS "landing_page_id";
-- ALTER TABLE "CoachLandingLead" DROP COLUMN IF EXISTS "external_ids";
-- ALTER TABLE "CoachLandingLead" DROP COLUMN IF EXISTS "synced_to";
