-- AUD-MJ-BILL-126 — read-only checks for the operator (Postgres, production). Last 30 days.
-- Worker AUD-MJ-BILL-126 ran none of these (no database access). All are SELECT-only.
-- No query returns an email address or name (ids and timestamps only).

-- Q1 (UNSAFE: guest-checkout-reconciliation / guest conversion retry — second welcome+receipt email)
-- The welcome email (subject "<coach> is ready for you on Growth Project", carries the Stripe receipt link) is a raw
-- Resend POST with no idempotency key and no EmailSendLog row (guest-checkout.service.ts:1713, :2063), so the
-- database cannot prove a duplicate. This lists the conversions that were exposed: the reconciler could see the
-- row as 'paid' with no user (created_at older than 2 minutes) or as a retry. Each listed id may have had two emails.
-- Confirm in the Resend dashboard (read-only): two "is ready for you on Growth Project" emails to one address
-- within a few minutes.
SELECT gc.id                               AS guest_checkout_id,
       gc.created_at                       AS checkout_created_at,
       cp.id                               AS client_purchase_id,
       cp.created_at                       AS purchase_created_at,
       cp.created_at - gc.created_at       AS convert_delay,
       gc.retry_count,
       gc.last_error
FROM "GuestCheckout" gc
JOIN "ClientPurchase" cp ON cp.stripe_payment_intent_id = gc.stripe_payment_intent_id
WHERE gc.status = 'converted'
  AND gc.created_at > now() - interval '30 days'
  AND (gc.retry_count > 0 OR cp.created_at - gc.created_at > interval '2 minutes')
ORDER BY gc.created_at DESC;

-- Q1-count: the same as one number.
SELECT count(*) AS exposed_guest_conversions_30d
FROM "GuestCheckout" gc
JOIN "ClientPurchase" cp ON cp.stripe_payment_intent_id = gc.stripe_payment_intent_id
WHERE gc.status = 'converted'
  AND gc.created_at > now() - interval '30 days'
  AND (gc.retry_count > 0 OR cp.created_at - gc.created_at > interval '2 minutes');

-- Q2 (sanity, expected 0 rows): money did NOT double on guest conversion. Unique keys make a second purchase
-- impossible (ClientPurchase.stripe_checkout_session_id = 'guest_pi_<pi>' @unique, idempotency_key @unique).
SELECT stripe_payment_intent_id, count(*) AS purchases
FROM "ClientPurchase"
WHERE stripe_checkout_session_id LIKE 'guest\_pi\_%'
  AND created_at > now() - interval '30 days'
GROUP BY stripe_payment_intent_id
HAVING count(*) > 1;

-- Q3 (sanity, expected 0 rows): no client holds two live purchases of the same package created within
-- 10 minutes of each other (any path: webhook, guest, reconciler). A hit means a double purchase.
SELECT a.client_user_id, a.package_id, a.id AS purchase_a, b.id AS purchase_b,
       a.created_at AS a_created, b.created_at AS b_created
FROM "ClientPurchase" a
JOIN "ClientPurchase" b
  ON b.client_user_id = a.client_user_id
 AND b.package_id = a.package_id
 AND b.id > a.id
 AND abs(extract(epoch FROM (b.created_at - a.created_at))) < 600
WHERE a.created_at > now() - interval '30 days'
  AND a.status IN ('paid', 'active', 'past_due')
  AND b.status IN ('paid', 'active', 'past_due');

-- Q4 (sanity, expected 0 / 0): the legacy PDF receipt cron (checkout-receipt) really was inert.
SELECT
  (SELECT count(*) FROM "GuestCheckout"
    WHERE receipt_url LIKE 'local://%' AND created_at > now() - interval '30 days') AS legacy_pdf_receipts,
  (SELECT count(*) FROM "EmailSendLog"
    WHERE idempotency_key LIKE 'checkout-receipt:%' AND created_at > now() - interval '30 days') AS legacy_receipt_emails;

-- Q5 (outside the double-work question; UNVERIFIED single-run money risk — see report "Noticed outside scope")
-- Guest checkouts that the app gave up on (set 'failed' or 'conversion_failed_terminal') with a real PaymentIntent
-- and no account/purchase. Open each PaymentIntent in the Stripe dashboard (read-only): any 'succeeded' one is a
-- buyer who was charged and never got an account (needs a manual refund or a manual conversion).
SELECT gc.id AS guest_checkout_id, gc.status, gc.reconcile_attempts, gc.retry_count,
       gc.created_at, gc.last_reconciled_at,
       gc.last_reconciled_at - gc.created_at AS time_to_give_up,
       gc.stripe_payment_intent_id
FROM "GuestCheckout" gc
WHERE gc.created_at > now() - interval '30 days'
  AND gc.status IN ('failed', 'conversion_failed_terminal')
  AND gc.created_user_id IS NULL
  AND gc.stripe_payment_intent_id NOT LIKE 'pending\_%'
  AND NOT EXISTS (SELECT 1 FROM "ClientPurchase" cp
                  WHERE cp.stripe_payment_intent_id = gc.stripe_payment_intent_id)
ORDER BY gc.created_at DESC;
