-- R81 BACKFILL CLEANUP — rebuild tail of PR #395 / PR #402.
--
-- Recreates the coach first-payment notification ledger with DDL IDENTICAL to
-- the original 20260614065425_add_coach_first_payment_notification migration
-- (which is removed from main by the R81 revert of PR #395). It is ordered
-- strictly AFTER 20261220000000_drop_coach_first_payment_notification so the
-- migration history reads cleanly: drop the reverted table, then recreate it as
-- part of the rebuilt feature whose N1 (push-throttle pre-commit mutation) fix
-- ships in the same PR. R82 tracker: #407.
--
-- Additive-only in effect (the prior drop left no table). No pre-existing table,
-- column, type, index, or constraint outside this ledger is altered. The
-- additive back-relation on public."User" (first_payment_notification) is a
-- Prisma-level virtual relation and emits no DDL against the User table.
--
-- ───────────────────────────────────────────────────────────────────────────
-- WHY UNIQUE(coachId) (50-Failures #28 Race / #29 Idempotency)
-- ───────────────────────────────────────────────────────────────────────────
-- The application performs a DIRECT INSERT inside the same $transaction that
-- records the ClientPurchase. There is NO check-then-act / pre-SELECT: the
-- UNIQUE("coachId") constraint IS the race protection. Concurrent webhook
-- retries (Stripe redelivers 3-5×) or simultaneous first payments race into
-- the INSERT; exactly one wins, the rest raise 23505 (Prisma P2002), which the
-- service swallows as "already emitted" with a structured log. Exactly one row
-- per coach can ever exist. This DB-backed exactly-once ledger is also why the
-- N1 fix can safely skip the in-process push throttle on transactional emits.
--
-- ───────────────────────────────────────────────────────────────────────────
-- RLS POLICY CITATION (HECTACORN security gate — ENGINEERING_RULES §2)
-- ───────────────────────────────────────────────────────────────────────────
-- This table is coach-owned and written ONLY by the server (the Stripe webhook
-- handler, which runs under service_role). The coach reads only their own row;
-- no client/anon may read another coach's row (50-Failures #5 IDOR). All writes
-- go through service_role (the webhook), so there is no public INSERT/UPDATE
-- policy — the server is the sole writer of this ledger.
-- ───────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "coach_first_payment_notification" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_first_payment_notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coach_first_payment_notification_coachId_key" ON "coach_first_payment_notification"("coachId");

-- AddForeignKey
ALTER TABLE "coach_first_payment_notification" ADD CONSTRAINT "coach_first_payment_notification_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY (HECTACORN QUALITY) — see header citation above.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── coach_first_payment_notification — coach-owner-self scope ───────────────
ALTER TABLE "coach_first_payment_notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_first_payment_notification" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachfirstpayment_service_role_all" ON "coach_first_payment_notification";
CREATE POLICY "p_coachfirstpayment_service_role_all" ON "coach_first_payment_notification" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachfirstpayment_service_role_all" ON "coach_first_payment_notification" IS 'Primitive A: service_role bypass. The Stripe webhook handler (sole writer of this ledger) runs under service_role; all INSERTs flow through here.';

DROP POLICY IF EXISTS "p_coachfirstpayment_select" ON "coach_first_payment_notification";
CREATE POLICY "p_coachfirstpayment_select" ON "coach_first_payment_notification" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id())));
COMMENT ON POLICY "p_coachfirstpayment_select" ON "coach_first_payment_notification" IS 'Owner-self read: a coach reads only their own first-payment row (coachId = self); platform owner reads all. anon (NULL current_user_id) sees zero. Cross-coach reads are denied (IDOR).';
