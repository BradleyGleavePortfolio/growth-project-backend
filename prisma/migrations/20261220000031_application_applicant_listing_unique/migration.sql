-- TM-5 — one Application per (applicant, listing): composite-unique DB backstop.
--
-- The apply funnel dedups same-key retries through the idempotency ledger, and
-- the default key is namespaced per (account, listing). But ApplyDto carries a
-- free, client-supplied idempotency_key, so two DISTINCT keys for the same
-- (applicant, listing) could create duplicate Application rows with no DB
-- guard. This adds the composite unique index. A P2002 on it is caught in
-- apply.service and routed into the idempotent recoverConfirmation path, so a
-- distinct-key duplicate submit replays the original confirmation rather than
-- creating a second row or surfacing a 500.
--
-- Safety: additive DDL only, dated AFTER 20261220000020_marketplace_abuse_signal_rls
-- and does not alter any shipped migration. CREATE UNIQUE INDEX IF NOT EXISTS is
-- idempotent — re-applying is a no-op. The matching `idempotency_key` unique and
-- the RLS policies on Application are unaffected. The index would fail only if
-- duplicate (applicant_user_id, listing_id) rows already existed; this PR has
-- not shipped, so no such duplicates can exist in any environment.

CREATE UNIQUE INDEX IF NOT EXISTS "Application_applicant_user_id_listing_id_key"
    ON "Application"("applicant_user_id", "listing_id");
