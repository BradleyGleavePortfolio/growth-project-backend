-- Audit #5 P1-2: R39.2 requires every new Supabase table to have
-- ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, and explicit
-- least-privilege policies. Prior marketplace migrations enabled RLS
-- but did not FORCE it, so the table owner role could still bypass
-- policies. FORCE closes that hole.

ALTER TABLE "CoachApplication"              FORCE ROW LEVEL SECURITY;
ALTER TABLE "CoachConnectAccount"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "CoachOffer"                    FORCE ROW LEVEL SECURITY;
ALTER TABLE "MarketplaceMutationIdempotency" FORCE ROW LEVEL SECURITY;

-- The idempotency ledger is service-only: the NestJS backend reads and
-- writes it via the Prisma service-role connection (which bypasses RLS),
-- and no Supabase anon/authenticated client should ever touch it. A
-- RESTRICTIVE policy that denies all access makes that intent explicit
-- so any accidental client-side query fails closed.
CREATE POLICY "idempotency_no_direct_access"
  ON "MarketplaceMutationIdempotency"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- P2 from Audit #5: the status column is consulted by claimOrReplay() to
-- decide whether to replay a cached response or return 409. Enforcing the
-- two valid states at the DB layer (F46) protects against a bad write
-- silently corrupting future idempotency reads.
ALTER TABLE "MarketplaceMutationIdempotency"
  ADD CONSTRAINT "marketplace_idempotency_status_check"
  CHECK (status IN ('in_progress', 'completed'));
