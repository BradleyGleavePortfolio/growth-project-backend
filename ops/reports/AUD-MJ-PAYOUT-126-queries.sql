-- AUD-MJ-PAYOUT-126 — read-only confirmation queries (Postgres, production DB, last 30 days).
-- Author: worker AUD-MJ-PAYOUT-126 (agent 126 fleet), written 18:13 PDT 2026-10-06. Code: backend main f71bb9a4.
-- Every payout job was rated SAFE (guards cited in /home/user/workspace/ops/reports/AUD-MJ-PAYOUT-126.md).
-- These queries let the operator prove from data that the double scheduler (2x ScheduleModule.forRoot, fixed by b#810)
-- did not pay, reverse or alert twice. Expected result for Q1-Q6: ZERO rows. Q7-Q8 are informational.
-- SELECT only. Nothing here writes. Run in a read-only session:
BEGIN READ ONLY;

-- Q1. Two transfer rows for the same money leg (would mean a coach was paid twice for one charge leg).
--     Guard: ConnectTransfer.idempotency_key @unique (tgp-settle-<charge>-<leg> / tgp-tr-<purchase>-headcoach).
--     Reinstate kinds are excluded (one row per dispute-reinstate state is legitimate).
SELECT COALESCE(settlement_id, 'legacy:' || purchase_id) AS leg_owner,
       kind,
       destination_user_id,
       COUNT(*)                         AS transfer_rows,
       SUM(amount_cents)                AS total_cents,
       array_agg(id ORDER BY created_at) AS transfer_ids
FROM "ConnectTransfer"
WHERE created_at >= now() - interval '30 days'
  AND kind NOT IN ('coach_reinstate', 'head_coach_reinstate')
GROUP BY 1, 2, 3
HAVING COUNT(*) > 1;

-- Q2. One Stripe transfer recorded on two rows (stripe_transfer_id has no unique index).
SELECT stripe_transfer_id, COUNT(*) AS rows, array_agg(id) AS transfer_ids
FROM "ConnectTransfer"
WHERE stripe_transfer_id IS NOT NULL
  AND updated_at >= now() - interval '30 days'
GROUP BY stripe_transfer_id
HAVING COUNT(*) > 1;

-- Q3. A transfer reversed for more than it paid (a clawback applied twice).
SELECT t.id, t.destination_user_id, t.amount_cents, t.reversed_amount_cents,
       COALESCE(SUM(o.amount_cents) FILTER (WHERE o.status = 'succeeded'), 0) AS succeeded_op_cents,
       COUNT(o.id) FILTER (WHERE o.status = 'succeeded')                     AS succeeded_ops
FROM "ConnectTransfer" t
LEFT JOIN "TransferReversalOp" o ON o.transfer_id = t.id
WHERE t.updated_at >= now() - interval '30 days'
GROUP BY t.id, t.destination_user_id, t.amount_cents, t.reversed_amount_cents
HAVING t.reversed_amount_cents > t.amount_cents
    OR COALESCE(SUM(o.amount_cents) FILTER (WHERE o.status = 'succeeded'), 0) > t.amount_cents;

-- Q4. A coach alerted twice for the same failed transfer or failed / canceled bank payout.
SELECT user_id,
       payload->>'event'                                                      AS alert_event,
       COALESCE(payload->>'stripe_transfer_id', payload->>'stripe_payout_id') AS stripe_object_id,
       COUNT(*)                                                               AS alerts,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at
FROM "Notification"
WHERE kind = 'coach_alert'
  AND payload->>'event' IN ('transfer_failed', 'payout_failed', 'payout_canceled')
  AND created_at >= now() - interval '30 days'
GROUP BY 1, 2, 3
HAVING COUNT(*) > 1;

-- Q5. A payout-adjustment notice (refund / chargeback effect on a payout) delivered twice on one channel.
SELECT user_id, payload->>'notice_id' AS notice_id, channel, COUNT(*) AS rows,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at
FROM "Notification"
WHERE kind = 'coach_alert'
  AND payload->>'event' = 'payout_adjustment'
  AND created_at >= now() - interval '30 days'
GROUP BY 1, 2, 3
HAVING COUNT(*) > 1;

-- Q6. Earnings double-count: two ledger slices for the same purchase / kind / payee / charge
--     (NULL charge ids bypass the 4-column unique index, so this checks them too).
SELECT purchase_id, kind, payee_user_id, COALESCE(stripe_charge_id, '(null)') AS charge,
       COUNT(*) AS rows, SUM(amount_cents) AS cents
FROM "SplitLedgerEntry"
WHERE created_at >= now() - interval '30 days'
GROUP BY 1, 2, 3, 4
HAVING COUNT(*) > 1;

-- Q7 (informational). Payout sweep lease and recent per-charge money locks: one holder at a time.
SELECT name, holder, acquired_at, lease_until, updated_at
FROM "CronLease"
WHERE name = 'sfee-settlement-sweep' OR name LIKE 'sfee-charge:%'
ORDER BY updated_at DESC
LIMIT 20;

-- Q8 (informational). Transfers whose last send is still unresolved (would show a contested or lost send).
SELECT id, kind, destination_user_id, amount_cents, attempts, max_attempts,
       stripe_send_unresolved_at, next_attempt_at, last_error
FROM "ConnectTransfer"
WHERE status = 'pending'
  AND stripe_send_unresolved_at IS NOT NULL
  AND stripe_send_unresolved_at < now() - interval '10 minutes'
ORDER BY stripe_send_unresolved_at;

ROLLBACK;
