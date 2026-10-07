-- AUD-MONEY-E2E-126 — read-only checks for the operator (agent 126). Do not run writes.
-- Q1. Does any Connect event (connected-account events) ever reach the backend?
--     Expected if there is NO working Connect event destination: 0 rows. Any row => B1 drops to U.
SELECT type, count(*) AS n, max(processed_at) AS last_seen
FROM "StripeProcessedEvent"
WHERE type IN ('account.updated', 'capability.updated', 'payout.paid', 'payout.failed', 'payout.canceled')
GROUP BY type;

-- Q2. Coaches whose saved mirror says they cannot take card payments (each is a coach whose clients get
--     COACH_NOT_PAYOUT_READY in the app). Compare each stripe_account_id in the Stripe dashboard (read-only):
--     charges enabled at Stripe but false here = B1 hitting a real coach today.
SELECT coach_user_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted, updated_at
FROM "ConnectAccount"
WHERE deauthorized_at IS NULL AND (charges_enabled = false OR payouts_enabled = false)
ORDER BY updated_at DESC;
