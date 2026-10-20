-- COACH-GONE-DELIVERY (agent 160): from the moment a coach confirms his account
-- deletion nothing of his is sold and his clients' plans stop renewing; if he
-- cancels inside the grace period, exactly what was stopped comes back. These two
-- columns are the memory of what was stopped (is_active and cancel_at_period_end
-- alone cannot tell the deletion's change from the coach's or client's own).
-- Server-written only (PackagesService rules and the billing reconciler); no
-- policy change: CoachPackage and ClientPurchase keep their row rules.
--
-- Additive only. Reverse: down.sql (drops only what this file adds).
ALTER TABLE "CoachPackage" ADD COLUMN "closed_for_deletion_at" TIMESTAMP(3);
ALTER TABLE "ClientPurchase" ADD COLUMN "renewal_off_for_deletion_at" TIMESTAMP(3);
