-- AUD-CRONX-126 — read-only duplicate checks for the duplicate-scheduler double run (agent 126 fleet).
-- Backend main f71bb9a4 (= production deploy 16). Table names checked against prisma/schema.prisma (@@map honoured).
-- All queries are SELECT only. Window: last 30 days. "Duplicate" = a later row with an earlier twin
-- (same user + same kind + same payload/target) created within 10 seconds of it.
-- The double scheduler exists since #171 (2026-05-12), so every 30-day window is affected.
-- Complete 18:15 PDT 10-06. Every other sender job is safe twice by code (see AUD-CRONX-126.md table); Q0* catch anything missed.
-- Run order suggestion: Q3 (canary: did the double run happen at all), then Q1, Q2, then the Q0 catch-alls.

------------------------------------------------------------------------------------------------------------------------
-- Q0 (catch-all, PUSH). Every server push goes through "PushOutbox" (claim is FOR UPDATE SKIP LOCKED, so the
-- worker itself never sends a row twice). A double-run PRODUCER would show up as two rows with the same
-- user/kind/title/body/data seconds apart. extra_copies_sent = duplicates that actually reached the phone.
------------------------------------------------------------------------------------------------------------------------
SELECT a.kind,
       count(*)                                    AS extra_copies,
       count(*) FILTER (WHERE a.status = 'sent')   AS extra_copies_sent,
       count(DISTINCT a.user_id)                   AS users_affected,
       min(a.created_at)                           AS first_seen,
       max(a.created_at)                           AS last_seen
FROM "PushOutbox" a
WHERE a.created_at >= now() - interval '30 days'
  AND EXISTS (
    SELECT 1 FROM "PushOutbox" b
    WHERE b.user_id = a.user_id
      AND b.kind = a.kind
      AND b.title = a.title
      AND b.body = a.body
      AND b.data::text = a.data::text
      AND (b.created_at, b.id) < (a.created_at, a.id)
      AND b.created_at >= a.created_at - interval '10 seconds'
  )
GROUP BY a.kind
ORDER BY extra_copies DESC;

------------------------------------------------------------------------------------------------------------------------
-- Q0b (catch-all, IN-APP). In-app inbox rows ("Notification"). Same user/kind/body/deep_link/payload within 10 s.
------------------------------------------------------------------------------------------------------------------------
SELECT a.kind,
       count(*)                  AS extra_copies,
       count(DISTINCT a.user_id) AS users_affected,
       min(a.created_at)         AS first_seen,
       max(a.created_at)         AS last_seen
FROM "Notification" a
WHERE a.created_at >= now() - interval '30 days'
  AND EXISTS (
    SELECT 1 FROM "Notification" b
    WHERE b.user_id = a.user_id
      AND b.kind = a.kind
      AND b.body = a.body
      AND b.deep_link IS NOT DISTINCT FROM a.deep_link
      AND b.payload::text IS NOT DISTINCT FROM a.payload::text
      AND (b.created_at, b.id) < (a.created_at, a.id)
      AND b.created_at >= a.created_at - interval '10 seconds'
  )
GROUP BY a.kind
ORDER BY extra_copies DESC;

------------------------------------------------------------------------------------------------------------------------
-- Q0c (catch-all, EMAIL). "EmailSendLog" has a unique idempotency_key, so a duplicate means two different keys for
-- the same template to the same address within 10 s. Output shows the template only (no addresses printed).
------------------------------------------------------------------------------------------------------------------------
SELECT a.template_key,
       count(*)                                   AS extra_copies,
       count(*) FILTER (WHERE a.status = 'sent')  AS extra_copies_sent,
       count(DISTINCT a.recipient_email)          AS recipients_affected,
       min(a.created_at)                          AS first_seen,
       max(a.created_at)                          AS last_seen
FROM "EmailSendLog" a
WHERE a.created_at >= now() - interval '30 days'
  AND EXISTS (
    SELECT 1 FROM "EmailSendLog" b
    WHERE b.recipient_email = a.recipient_email
      AND b.template_key = a.template_key
      AND (b.created_at, b.id) < (a.created_at, a.id)
      AND b.created_at >= a.created_at - interval '10 seconds'
  )
GROUP BY a.template_key
ORDER BY extra_copies DESC;

-- NOTE on Q0/Q0b: they need identical data/payload, so they MISS duplicates whose payload carries a per-row id
-- (coach alerts carry alertId). Q0L/Q0bL below drop the payload match; read the kind column (chat kinds can repeat
-- legitimately when someone sends the same text twice). Pushes sent by NotificationsService.pushToUser go straight to
-- Expo and leave NO row anywhere (nudge pushes do this); count their in-app twins instead (Q1).

-- Q0L (loose PUSH): same user + kind + title + body within 10 s, payload ignored.
SELECT a.kind,
       count(*)                                    AS extra_copies,
       count(*) FILTER (WHERE a.status = 'sent')   AS extra_copies_sent,
       count(DISTINCT a.user_id)                   AS users_affected
FROM "PushOutbox" a
WHERE a.created_at >= now() - interval '30 days'
  AND EXISTS (
    SELECT 1 FROM "PushOutbox" b
    WHERE b.user_id = a.user_id AND b.kind = a.kind AND b.title = a.title AND b.body = a.body
      AND (b.created_at, b.id) < (a.created_at, a.id)
      AND b.created_at >= a.created_at - interval '10 seconds'
  )
GROUP BY a.kind
ORDER BY extra_copies DESC;

-- Q0bL (loose IN-APP): same user + kind + body within 10 s, payload ignored.
SELECT a.kind,
       count(*)                  AS extra_copies,
       count(DISTINCT a.user_id) AS users_affected
FROM "Notification" a
WHERE a.created_at >= now() - interval '30 days'
  AND EXISTS (
    SELECT 1 FROM "Notification" b
    WHERE b.user_id = a.user_id AND b.kind = a.kind AND b.body = a.body
      AND (b.created_at, b.id) < (a.created_at, a.id)
      AND b.created_at >= a.created_at - interval '10 seconds'
  )
GROUP BY a.kind
ORDER BY extra_copies DESC;

------------------------------------------------------------------------------------------------------------------------
-- Q1 NUDGES (src/notifications/nudges/nudge.scheduler.ts:43 -> nudge-engine.service.ts:210 reprocessDeferred).
-- NOT SAFE TWICE: a nudge held for quiet hours is re-read by both copies (findMany status='deferred', then an
-- unconditional update), both pass the cap-bucket step (same row, same bucket, no conflict) and both deliver:
-- two in-app rows ("Notification", kind nudge_*), two direct Expo pushes (no row), one email (idempotency key).
-- Fresh nudges are safe (unique NudgeLog(user_id, trigger_type, signal_key)). Count the doubled ones:
------------------------------------------------------------------------------------------------------------------------
WITH g AS (
  SELECT user_id, kind, payload->>'signal_key' AS signal_key,
         count(*) AS copies, max(created_at) - min(created_at) AS spread
  FROM "Notification"
  WHERE kind IN ('nudge_missed_checkin', 'nudge_streak_broken', 'nudge_onboarding_abandoned', 'nudge_inactive')
    AND created_at >= now() - interval '30 days'
  GROUP BY 1, 2, 3
  HAVING count(*) > 1
)
SELECT kind,
       count(*)                AS nudges_doubled,
       sum(copies - 1)         AS extra_copies,
       count(DISTINCT user_id) AS users_affected,
       max(spread)             AS max_gap_between_copies
FROM g
GROUP BY kind
ORDER BY extra_copies DESC;

-- Q1b NUDGES, how many deferred nudges were delivered in the window (upper bound on Q1 if the double run hit every one).
SELECT trigger_type,
       count(*) AS sent_after_deferral
FROM "NudgeLog"
WHERE status = 'sent'
  AND sent_at >= now() - interval '30 days'
  AND cap_bucket IS NOT NULL
  AND sent_at - attempted_at > interval '15 minutes'
GROUP BY trigger_type
ORDER BY sent_after_deferral DESC;

------------------------------------------------------------------------------------------------------------------------
-- Q2 COACH RED-RISK ALERTS (src/ptm/ptm.scheduler.ts:41 -> ptm-recompute.service.ts:101 recomputeOne ->
-- coach/coach-alerts.service.ts:85 createAlert). NOT SAFE TWICE: both copies read the same previous prediction,
-- both write a red prediction, and createAlert's dedupe is find-then-create with no unique constraint, so the coach
-- gets two "X crossed into the red risk band" alerts and two in-app rows; the push is usually collapsed to one by the
-- outbox collapse key, so Q2b 'push' is expected to be lower than 'inapp'.
------------------------------------------------------------------------------------------------------------------------
SELECT a.alert_type,
       count(*)                   AS extra_copies,
       count(DISTINCT a.coach_id) AS coaches_affected,
       count(DISTINCT a.client_id) AS clients_involved,
       min(a.created_at)          AS first_seen,
       max(a.created_at)          AS last_seen
FROM "CoachAlert" a
WHERE a.created_at >= now() - interval '30 days'
  AND EXISTS (
    SELECT 1 FROM "CoachAlert" b
    WHERE b.coach_id = a.coach_id AND b.client_id = a.client_id AND b.alert_type = a.alert_type
      AND (b.created_at, b.id) < (a.created_at, a.id)
      AND b.created_at >= a.created_at - interval '60 seconds'
  )
GROUP BY a.alert_type
ORDER BY extra_copies DESC;

-- Q2b the in-app and push twins of those alerts (kind 'coach_alert'; payload carries the alert id, so match on body).
SELECT 'inapp' AS channel, count(*) AS extra_copies, count(DISTINCT a.user_id) AS coaches_affected
FROM "Notification" a
WHERE a.kind = 'coach_alert' AND a.created_at >= now() - interval '30 days'
  AND EXISTS (SELECT 1 FROM "Notification" b
              WHERE b.user_id = a.user_id AND b.kind = a.kind AND b.body = a.body
                AND (b.created_at, b.id) < (a.created_at, a.id)
                AND b.created_at >= a.created_at - interval '60 seconds')
UNION ALL
SELECT 'push', count(*), count(DISTINCT a.user_id)
FROM "PushOutbox" a
WHERE a.kind = 'coach_alert' AND a.created_at >= now() - interval '30 days' AND a.status = 'sent'
  AND EXISTS (SELECT 1 FROM "PushOutbox" b
              WHERE b.user_id = a.user_id AND b.kind = a.kind AND b.body = a.body
                AND (b.created_at, b.id) < (a.created_at, a.id)
                AND b.created_at >= a.created_at - interval '60 seconds');

------------------------------------------------------------------------------------------------------------------------
-- Q3 CANARY: proves the double run in production history. Two append-only nightly jobs with NO dedupe write one row
-- per subject per run; two rows seconds apart per subject per night = the scheduler fired twice.
-- (src/coach/coach-effectiveness.scheduler.ts:46 -> coach-effectiveness.service.ts:107 create;
--  src/ptm/ptm.scheduler.ts:41 -> ptm-recompute.service.ts persist -> "PtmPrediction" create)
------------------------------------------------------------------------------------------------------------------------
SELECT 'CoachEffectivenessScore' AS tbl,
       date_trunc('day', computed_at) AS day,
       count(*) AS rows,
       count(DISTINCT coach_id) AS subjects
FROM "CoachEffectivenessScore"
WHERE computed_at >= now() - interval '30 days'
GROUP BY 2
UNION ALL
SELECT 'PtmPrediction', date_trunc('day', computed_at), count(*), count(DISTINCT user_id)
FROM "PtmPrediction"
WHERE computed_at >= now() - interval '30 days'
GROUP BY 2
ORDER BY 1, 2;
-- rows = 2 x subjects on a night => the double run happened that night.
