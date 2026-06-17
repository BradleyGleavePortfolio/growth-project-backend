-- TM-4 (fixer) — add fencing token to the marketplace idempotency ledger.
--
-- F1 fix: a stale `pending` claim reclaimed via the P1-8 TTL sweep left the
-- presumed-dead original owner unfenced — it could still call markCompleted and
-- blindly overwrite the new owner's row by composite key, double-executing the
-- mutation. `claim_nonce` is a per-claim fencing token: claimOrReplay stamps a
-- fresh nonce, reclaimStale ROTATES it, and markCompleted/releaseClaim are
-- compare-and-set on it. A reclaimed owner holds an old nonce → its write
-- affects zero rows and is rejected as a typed conflict.
--
-- Nullable (no backfill): only rows written by the TM-4 service carry a nonce,
-- and the service always stamps one at claim time. Pre-existing rows (none in
-- prod yet) simply never match a compare-and-set, which is the safe outcome.
--
-- Re-dated AFTER main's latest migration 20261220000000_talent_marketplace_rls.
-- Additive-only; touches no existing column, type, policy, or migration.
--
-- RLS: this column lives on MarketplaceMutationIdempotency, which already
-- carries the RESTRICTIVE deny-all (anon + authenticated) + service_role-only
-- posture from 20261220000000_talent_marketplace_rls. RLS is table-scoped, so
-- the new column inherits that posture verbatim. The block below RE-ASSERTS
-- the deny-all policies (idempotent DROP/CREATE) so this migration is
-- self-contained and the deny-all coverage is visible at the point of change.
-- =====================================================================

BEGIN;

ALTER TABLE "MarketplaceMutationIdempotency"
    ADD COLUMN "claim_nonce" TEXT;

-- Re-assert the parent table's RESTRICTIVE deny-all posture (idempotent). The
-- new column is covered by these table-scoped policies; only service_role
-- (Primitive A) may ever read/write the ledger.
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
