-- AUD-MJ-DUNNING-126 (agent 126) — read-only checks for dunning double work, last 30 days.
-- Written 2026-10-06 18:1x PDT against backend main f71bb9a4. Postgres (Supabase). NOT run by the auditor (no DB access).
-- Every statement is a SELECT. No PII is returned: emails are only grouped, never selected.
-- Verdict in the report: every dunning job is SAFE, so every "duplicate" query below is EXPECTED TO RETURN 0 / no rows.
-- CORRECTED 18:16 PDT: FEATURE_DUNNING_V2 is ON in production since fly-env-sync apply 2026-10-06 21:11Z. Q0 comment below is stale;
-- Q8-Q13 (v2-ON duplicate checks) were added at the end.
-- A non-zero result means a guard failed in production and the operator should page the money lane.

-- Q0. Is dunning live at all? (v2 on since 21:11Z 10-06; v1 is webhook-only and never sends under v2.)
SELECT 'DunningState opened'          AS what, count(*) AS n FROM "DunningState"          WHERE created_at > now() - interval '30 days'
UNION ALL SELECT 'DunningAttempt rows',     count(*) FROM "DunningAttempt"        WHERE created_at > now() - interval '30 days'
UNION ALL SELECT 'DunningAttempt sent',     count(*) FROM "DunningAttempt"        WHERE created_at > now() - interval '30 days' AND status = 'sent'
UNION ALL SELECT 'DunningNoticeDelivery',   count(*) FROM "DunningNoticeDelivery" WHERE created_at > now() - interval '30 days'
UNION ALL SELECT 'PaymentReminder rows',    count(*) FROM "PaymentReminder"       WHERE created_at > now() - interval '30 days'
UNION ALL SELECT 'ClientBillingOperation',  count(*) FROM "ClientBillingOperation" WHERE created_at > now() - interval '30 days';

-- Q1. Same dunning / past-due email template to the same address twice within 10 minutes (the double-run signature).
--     Covers v1 cadence, v1 recovery, v2 client + coach, coach SaaS payment-failed. EXPECTED: no rows.
SELECT template_key, count(*) AS near_duplicate_sends
FROM (
  SELECT template_key, created_at,
         lag(created_at) OVER (PARTITION BY template_key, recipient_email ORDER BY created_at) AS prev_at
  FROM "EmailSendLog"
  WHERE created_at > now() - interval '30 days'
    AND template_key IN ('payment-reminder', 'payment-reminder-soft', 'payment-reminder-urgent',
                         'payment-final-notice', 'dunning-final', 'payment-recovered', 'payment-failed',
                         'dunning-v2-client', 'dunning-v2-coach')
) t
WHERE prev_at IS NOT NULL AND created_at - prev_at < interval '10 minutes'
GROUP BY template_key
ORDER BY near_duplicate_sends DESC;

-- Q2. More than one recovery email per dunning row (key dunning-recovered:<state id>). EXPECTED: no rows.
SELECT idempotency_key, count(*) AS n
FROM "EmailSendLog"
WHERE created_at > now() - interval '30 days' AND idempotency_key LIKE 'dunning-recovered:%'
GROUP BY idempotency_key HAVING count(*) > 1;

-- Q3. v2 notices: one row per (state, cycle, step, channel) is enforced by the id; a row that was claimed more than
--     once AND ended 'sent' is the only way a v2 push / in-app could have gone out twice (claim takeover after 10 min).
--     EXPECTED: 0 (and 0 rows at all while the flag is off).
SELECT channel, count(*) AS sent_after_retake
FROM "DunningNoticeDelivery"
WHERE created_at > now() - interval '30 days' AND status = 'sent' AND attempts > 1
GROUP BY channel;

-- Q4. Two dunning blockers for the same client + dunning row + variant within 10 minutes. EXPECTED: no rows.
SELECT count(*) AS duplicate_blockers
FROM (
  SELECT user_id, payload->>'dunningStateId' AS state_id, payload->>'variant' AS variant, created_at,
         lag(created_at) OVER (PARTITION BY user_id, payload->>'dunningStateId', payload->>'variant' ORDER BY created_at) AS prev_at
  FROM "Notification"
  WHERE kind = 'dunning_blocker' AND created_at > now() - interval '30 days'
) t
WHERE prev_at IS NOT NULL AND created_at - prev_at < interval '10 minutes';

-- Q5. Reconciler / client billing: more than one OPEN operation of the same kind on one purchase (the lease should make
--     this impossible). EXPECTED: no rows.
SELECT purchase_id, kind, count(*) AS open_ops
FROM "ClientBillingOperation"
WHERE completed_at IS NULL AND created_at > now() - interval '30 days'
GROUP BY purchase_id, kind HAVING count(*) > 1;

-- Q6. v1 cadence: two attempts of the same kind sent for one dunning row within 10 minutes. EXPECTED: no rows.
SELECT count(*) AS duplicate_v1_sends
FROM (
  SELECT dunning_state_id, kind, sent_at,
         lag(sent_at) OVER (PARTITION BY dunning_state_id, kind ORDER BY sent_at) AS prev_at
  FROM "DunningAttempt"
  WHERE status = 'sent' AND sent_at > now() - interval '30 days'
) t
WHERE prev_at IS NOT NULL AND sent_at - prev_at < interval '10 minutes';

-- Q7. Informational (by design, not double work): v1 cadence attempts that are due but were never sent. Nothing runs the
--     v1 tick on a timer (only the owner-only admin route does), and under v2 the tick returns at once.
SELECT status, count(*) AS n, min(scheduled_for) AS oldest_due
FROM "DunningAttempt"
WHERE scheduled_for < now() AND created_at > now() - interval '30 days'
GROUP BY status ORDER BY n DESC;


-- ============================================================================================================
-- v2-ON duplicate checks (added 18:16 PDT after the operator's 18:16 correction). Window: since flag-on 21:11Z 10-06,
-- widened to 30 days so earlier test traffic is included. ALL EXPECTED: 0 / no rows.
-- ============================================================================================================

-- Q8. DunningAttempt: more than one row per (dunning_state_id, step_index) (unique index; must be 0), and v1 emails SENT
--     after v2 went on (tick returns under v2, so any 'sent' here means a second, v1 email sequence went out).
SELECT 'dup (state, step)' AS check, count(*) AS n FROM (
  SELECT dunning_state_id, step_index FROM "DunningAttempt"
  WHERE created_at > now() - interval '30 days' GROUP BY 1, 2 HAVING count(*) > 1) d
UNION ALL
SELECT 'v1 sent after v2 on', count(*) FROM "DunningAttempt"
  WHERE status = 'sent' AND sent_at >= timestamp '2026-10-06 21:11:00'
UNION ALL
SELECT 'dup email_idempotency_key', count(*) FROM (
  SELECT email_idempotency_key FROM "DunningAttempt"
  WHERE email_idempotency_key IS NOT NULL AND created_at > now() - interval '30 days' GROUP BY 1 HAVING count(*) > 1) e;

-- Q9. DunningNoticeDelivery: more than one row per (state, cycle, step, channel) — the deterministic id should make it 1.
SELECT dunning_state_id, cycle_key, step_index, channel, count(*) AS n
FROM "DunningNoticeDelivery"
WHERE created_at > now() - interval '30 days'
GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;

-- Q10. DunningNoticeDelivery: a notice that needed a claim takeover and then ended 'sent' (the only way a v2 push / blocker
--      could have gone out twice), per channel. Same as Q3, repeated here for the v2 set.
SELECT channel, count(*) AS sent_after_retake
FROM "DunningNoticeDelivery"
WHERE created_at > now() - interval '30 days' AND status = 'sent' AND attempts > 1
GROUP BY channel;

-- Q11. v2 client emails: more than one SENT email for the same (state, cycle, step), ignoring the :rN retry suffix.
SELECT count(*) AS steps_emailed_twice FROM (
  SELECT regexp_replace(idempotency_key, ':r[0-9]+$', '') AS base_key
  FROM "EmailSendLog"
  WHERE idempotency_key LIKE 'dunning_v2:%:email:%' AND status = 'sent' AND created_at > now() - interval '30 days'
  GROUP BY 1 HAVING count(*) > 1) t;

-- Q12. DunningState: two v2 cycles opened for one dunning row within an hour (a double Day-0 claim would show as two
--      cycle_keys with step-0 deliveries created close together), and more than one row per purchase (unique; must be 0).
SELECT 'two cycles within 1h' AS check, count(*) AS n FROM (
  SELECT dunning_state_id, cycle_key, min(created_at) AS opened,
         lag(min(created_at)) OVER (PARTITION BY dunning_state_id ORDER BY min(created_at)) AS prev_opened
  FROM "DunningNoticeDelivery"
  WHERE step_index = 0 AND created_at > now() - interval '30 days'
  GROUP BY dunning_state_id, cycle_key) c
WHERE prev_opened IS NOT NULL AND opened - prev_opened < interval '1 hour'
UNION ALL
SELECT 'dup purchase_id', count(*) FROM (
  SELECT purchase_id FROM "DunningState" GROUP BY 1 HAVING count(*) > 1) p
UNION ALL
SELECT 'locked before Day 10', count(*) FROM "DunningState"
  WHERE locked_out_at IS NOT NULL AND entered_at IS NOT NULL AND locked_out_at < entered_at + interval '10 days'
    AND (last_failure_reason IS NULL OR last_failure_reason NOT IN ('charge_disputed', 'charge_refunded'))  -- pause cycles lock at once by design
    AND updated_at > now() - interval '30 days';

-- Q13. PaymentRecoveryToken: no code path creates these (only revokes), so any row at all is unexpected; plus the unique checks.
SELECT 'rows (expect 0)' AS check, count(*) AS n FROM "PaymentRecoveryToken" WHERE created_at > now() - interval '30 days'
UNION ALL
SELECT 'dup dunning_attempt_id', count(*) FROM (
  SELECT dunning_attempt_id FROM "PaymentRecoveryToken" GROUP BY 1 HAVING count(*) > 1) d
UNION ALL
SELECT 'dup jwt_jti', count(*) FROM (
  SELECT jwt_jti FROM "PaymentRecoveryToken" GROUP BY 1 HAVING count(*) > 1) j;

-- Non-SQL check (Fly logs since deploy 16 boot 00:40:58Z): the second copy of each dunning timer should log
--   "dunning v2 sweep: previous tick still running, skipping"        at minute :07 every hour, and
--   "client billing reconcile: previous tick still running, skipping" at minute :37 every hour.
