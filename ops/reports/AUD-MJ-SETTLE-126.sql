-- AUD-MJ-SETTLE-126 — settlement and fees: did any money job do the same work twice?
-- Read-only Postgres. Quoted Prisma table names (no @@map in schema.prisma). Window: last 30 days.
-- Every query is a SELECT; none writes. Expected result for Q1-Q11: ZERO rows (Q0: the listed indexes present).
-- Backend main f71bb9a4. Written by AUD-MJ-SETTLE-126 (agent 126), 2026-10-06 PDT. Not run by the auditor (no DB access).

-- Q0. The unique indexes the SAFE verdicts rely on exist in production.
-- Expect at least: ChargeSettlement_stripe_charge_id_key, ConnectTransfer_idempotency_key_key,
-- ConnectTransfer_ledger_entry_id_key, PayeeRecovery_idempotency_key_key, PayoutAdjustmentNotice_idempotency_key_key,
-- TransferReversalOp_idempotency_key_key, TransferReversalOp_stripe_reversal_id_key, TransferReversalOp_transfer_id_seq_key,
-- SplitLedgerEntry_idempotency_key_key, SplitLedgerEntry_purchase_kind_payee_charge_key,
-- SplitLedgerReversal_entry_id_source_kind_source_id_key, ChargeRefund_stripe_refund_id_key, CronLease_pkey, StripeProcessedEvent_pkey.
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('ChargeSettlement','ConnectTransfer','PayeeRecovery','PayoutAdjustmentNotice','TransferReversalOp',
                    'SplitLedgerEntry','SplitLedgerReversal','ChargeRefund','CronLease','StripeProcessedEvent')
  AND (indexdef ILIKE 'CREATE UNIQUE%')
ORDER BY tablename, indexname;

-- Q1. A charge's ledger slice written twice (the fee slices have payee NULL, which the 4-column unique does not catch).
SELECT stripe_charge_id, kind, payee_user_id, count(*) AS rows, sum(amount_cents) AS cents
FROM "SplitLedgerEntry"
WHERE created_at >= now() - interval '30 days' AND stripe_charge_id IS NOT NULL
GROUP BY stripe_charge_id, kind, payee_user_id
HAVING count(*) > 1;

-- Q2. More than one first-pay transfer per settlement leg (coach_net / head_coach_split).
SELECT settlement_id, kind, destination_user_id, count(*) AS transfers, sum(amount_cents) AS cents
FROM "ConnectTransfer"
WHERE created_at >= now() - interval '30 days' AND settlement_id IS NOT NULL
  AND kind IN ('coach_net','head_coach_split')
GROUP BY settlement_id, kind, destination_user_id
HAVING count(*) > 1;

-- Q3. One Stripe transfer recorded on two rows.
SELECT stripe_transfer_id, count(*) AS rows
FROM "ConnectTransfer"
WHERE created_at >= now() - interval '30 days' AND stripe_transfer_id IS NOT NULL
GROUP BY stripe_transfer_id
HAVING count(*) > 1;

-- Q4. Payees paid more (net of reversals) than the charge's gross: the clearest sign of a double payout on a charge.
SELECT s.stripe_charge_id, s.gross_cents,
       sum(t.amount_cents - t.reversed_amount_cents) FILTER (WHERE t.status IN ('succeeded','reversed')) AS net_paid_cents
FROM "ChargeSettlement" s
JOIN "ConnectTransfer" t ON t.settlement_id = s.id
WHERE s.created_at >= now() - interval '30 days'
GROUP BY s.id, s.stripe_charge_id, s.gross_cents
HAVING sum(t.amount_cents - t.reversed_amount_cents) FILTER (WHERE t.status IN ('succeeded','reversed')) > s.gross_cents;

-- Q5. A transfer reversed for more than it paid (a refund / dispute reversal applied twice).
SELECT t.id AS connect_transfer_id, t.amount_cents, sum(o.amount_cents) AS reversed_by_ops_cents, count(*) AS ops
FROM "TransferReversalOp" o
JOIN "ConnectTransfer" t ON t.id = o.transfer_id
WHERE o.status = 'succeeded' AND o.created_at >= now() - interval '30 days'
GROUP BY t.id, t.amount_cents
HAVING sum(o.amount_cents) > t.amount_cents;

-- Q6. A ledger slice reversed twice for the same refund / dispute (B-676-1 posting).
SELECT entry_id, source_kind, source_id, count(*) AS rows
FROM "SplitLedgerReversal"
WHERE created_at >= now() - interval '30 days'
GROUP BY entry_id, source_kind, source_id
HAVING count(*) > 1;

-- Q7. A payee recovery collected beyond what was owed (netting counted twice).
SELECT id, payee_user_id, amount_cents, collected_cents, status
FROM "PayeeRecovery"
WHERE created_at >= now() - interval '30 days' AND collected_cents > amount_cents;

-- Q8. Netting cross-check per payee (all time; small tables): cents netted out of transfers must equal cents
-- collected on recoveries. A positive or negative gap means a recovery was collected twice or skipped.
-- Caveat: a netted transfer that later failed for good can leave a legitimate gap (its own alert path,
-- transfer-orchestrator.service.ts:1516); check those rows' ConnectTransfer.status before calling it a double count.
WITH netted AS (
  SELECT destination_user_id AS payee, currency, sum(netted_recovery_cents) AS cents
  FROM "ConnectTransfer" WHERE netted_recovery_cents > 0 GROUP BY 1, 2
), collected AS (
  SELECT payee_user_id AS payee, currency, sum(collected_cents) AS cents
  FROM "PayeeRecovery" WHERE collected_cents > 0 GROUP BY 1, 2
)
SELECT coalesce(n.payee, c.payee) AS payee, coalesce(n.currency, c.currency) AS currency,
       coalesce(n.cents, 0) AS netted_cents, coalesce(c.cents, 0) AS collected_cents
FROM netted n FULL JOIN collected c ON c.payee = n.payee AND c.currency = n.currency
WHERE coalesce(n.cents, 0) <> coalesce(c.cents, 0);

-- Q9. A coach got the generic refund alert twice for one Stripe refund.
SELECT payload->>'stripe_refund_id' AS stripe_refund_id, user_id, count(*) AS alerts
FROM "Notification"
WHERE kind = 'coach_alert' AND payload->>'event' = 'refund_processed'
  AND created_at >= now() - interval '30 days'
GROUP BY 1, 2
HAVING count(*) > 1;

-- Q10. A payout-adjustment notice delivered to the in-app inbox twice.
SELECT payload->>'notice_id' AS notice_id, user_id, count(*) AS inbox_rows
FROM "Notification"
WHERE kind = 'coach_alert' AND payload->>'event' = 'payout_adjustment'
  AND created_at >= now() - interval '30 days'
GROUP BY 1, 2
HAVING count(*) > 1;

-- Q11. A refund's head-coach reversal counted twice on the refund side (legacy path): two Stripe reversal ids for one op key.
SELECT idempotency_key, count(DISTINCT stripe_reversal_id) AS stripe_reversals
FROM "TransferReversalOp"
WHERE created_at >= now() - interval '30 days' AND stripe_reversal_id IS NOT NULL
GROUP BY idempotency_key
HAVING count(DISTINCT stripe_reversal_id) > 1;

-- Info (not a defect check): the settlement sweep lease row. lease_until in the past between runs; one holder.
SELECT name, holder, lease_until, acquired_at FROM "CronLease" WHERE name IN ('sfee-settlement-sweep','sfee-invoice-backfill-cursor');
