-- Phase 11 / Track 8 — Audit #2 follow-up
--
-- Two related fixes:
--   1. P1-1: stop reusing `CoachOffer.idempotency_key` for create/accept/reject.
--      Introduce a per-route idempotency ledger keyed by
--      (user_id, route_key, idempotency_key) so the original create key stays
--      permanently replayable and accept/reject/admin-review/onboarding-link
--      retries land here instead of overwriting any mutated row.
--   2. P1-3: enforce one accepted offer per application at the DB layer via a
--      partial unique index. The application-level transactional guard still
--      runs first; this index is the fail-closed backstop.
--
-- Additive only. No existing data modified.

-- ─── 1. MarketplaceMutationIdempotency ────────────────────────────────────────

CREATE TABLE "MarketplaceMutationIdempotency" (
    "id"              TEXT         NOT NULL,
    "user_id"         TEXT         NOT NULL,
    "route_key"       TEXT         NOT NULL,
    "idempotency_key" TEXT         NOT NULL,
    "response"        JSONB        NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceMutationIdempotency_pkey" PRIMARY KEY ("id")
);

-- Composite uniqueness: the same UUID may legitimately appear under two
-- different routes or two different users; only the same user retrying the
-- same mutation hits the cached response.
CREATE UNIQUE INDEX "MarketplaceMutationIdempotency_user_route_key_key"
    ON "MarketplaceMutationIdempotency"("user_id", "route_key", "idempotency_key");

CREATE INDEX "MarketplaceMutationIdempotency_user_route_idx"
    ON "MarketplaceMutationIdempotency"("user_id", "route_key");

-- Defense-in-depth: enable RLS like the other marketplace tables. All access
-- flows through the service_role.
ALTER TABLE "MarketplaceMutationIdempotency" ENABLE ROW LEVEL SECURITY;

-- ─── 2. CoachOffer: one accepted offer per application ────────────────────────
--
-- Partial unique index ensures no two `accepted` offers can coexist for the
-- same application, even under a concurrent accept race. The service layer's
-- transactional withdraw-others step keeps the happy path clean; this index
-- catches anything that slips past.

CREATE UNIQUE INDEX "CoachOffer_one_accepted_per_application_idx"
    ON "CoachOffer"("application_id")
    WHERE "status" = 'accepted';
