# Notifications Module

The notifications module is the single place all communication with users and coaches flows through. It manages the in-app notification inbox, push delivery, email digest scheduling, and per-user channel preferences. Every other module (check-ins, weight, messaging, build-week, PTM alerts) calls into this module's emitters rather than writing their own notification logic, so policy changes (mute, quiet hours, rate limits) apply automatically everywhere.

---

## Notification Kind × Channel × Default-On Matrix

| Kind | In-app | Push | Email | Setting | Mute all | Who receives |
| ---- | ------ | ---- | ----- | ------- | -------- | ------------ |
| `milestone_reached` | on | on | off | `milestone_*` | row kept, push muted | Client |
| `message_received` | on | on | off | `message_*` | row kept, push muted | Client |
| `missed_checkin` | on | on | off | `missed_checkin_*` | row kept, push muted | Client + Coach |
| `weight_trend_alert` | on | on | off | `weight_trend_*` | row kept, push muted | Client |
| `checkin_submitted` | on | off | off | `checkin_submitted_*` | row kept, push muted | Coach |
| `build_week_day_unlocked` | on | on | on | `build_week_*` | row kept, push muted | Client |
| `coach_alert` | on | on | off | `coach_alert_*` | row kept, push muted except safety and money alerts (note 1) | Coach |
| `coach_client_moved` | on | off | off | none | row kept | Coach (the coach a client left for TGP's house coach; SWITCH-TELL-BE) |
| `client_digest` | off | off | on | `digest_*` | email muted | Client |
| `coach_digest` | off | off | on | `digest_*` | email muted | Coach |
| `workout_reminder` | on | on | n/a | `workout_reminder_*` | row kept, push muted (note 2) | Client (C05 item 7) |
| `workout_assigned` | on | on | n/a | `workout_reminder_*` | row kept, push muted | Client (FU-WORKLOG-126: the workout reminder switches) |
| `meal_plan_assigned` | on | on | n/a | none | row kept | Client (one row, written on the `push` channel; it shows in the inbox) |
| `drip_released` | on | on | off | `drip_released_*` | row kept, push muted | Client (buyer) |
| `coach_new_purchase` | on | on | off | `coach_new_purchase_*` | passes (money) | Coach |
| `booking_requested`, `booking_confirmed`, `booking_declined`, `booking_cancelled`, `booking_rescheduled`, `booking_reminder_24h`, `booking_reminder_1h`, `booking_link_needed`, `booking_link_ready`, `booking_request_expired` | on | on | off | `booking_*` | row kept, push muted | Client + Coach |
| `nudge_missed_checkin` | on | on | off | `nudge_missed_checkin_*` | row kept, push and email muted (note 2) | Client |
| `nudge_streak_broken` | on | on | off | `nudge_practice_paused_*` | row kept, push and email muted (note 2) | Client |
| `nudge_onboarding_abandoned` | on | on | on | `nudge_onboarding_abandoned_*` | row kept, push and email muted (note 2) | Client |
| `nudge_inactive` | on | on | on | `nudge_inactive_*` | row kept, push and email muted (note 2) | Client |
| `dunning_blocker` | on | n/a | n/a | none | passes (money) | Client (the Day 3, Day 7 and dispute payment blocker, and the full-refund notice; the payment push goes through `pushToUser`) |
| `first_payment` | on | on | n/a | none | passes (money) | Coach |
| `trial_ending` | on | on | n/a | none | passes (money) | Client |
| `plan_renewal` | n/a | on | n/a | `plan_renewal_*` | passes (money) | Client (push only, no inbox row) |
| `contract_signed`, `contract_declined`, `contract_expired` | off | off | on | `digest_*` | no sender yet | Coach (B5 contracts; no sender on main yet) |

Defaults live in `NotificationsService.getPreferences`. Each channel flag can be toggled independently via `PATCH /notifications/preferences`.
Setting is the column family `notificationPrefsPrefix` picks for the kind (`src/notifications/push/push-preferences.ts`). `none` means
the kind has no column of its own: only `muted` (Mute all) stops it at the core gate, and only its push. A kind with no line there falls to `digest_*`,
whose in-app and push are off by default, so every money or safety kind has its own line. `test/dunning-kind-fix-notification-kinds.spec.ts`
walks every kind through the real gate and fails when one lands under an off setting this table does not name.

Mute all (`muted`, owner ruling #171-3) never stops a row, since every row is listed in the inbox, and never stops a money kind
(`MONEY_NOTIFICATION_KINDS` in `notification-kind.ts`, "passes (money)") on any channel; no email sender reads it except the digests and the nudges (note 2).
It mutes every other push, at enqueue and again at send time (`muteAllStops` in `push-preferences.ts`), except a push whose context
passes Mute all: a safety alert (`context.safetyAlert`, any key of `SAFETY_ALERT_PUSH_BODY`, owner ruling #168-18) or a money notice
sent on a kind that is not money (`context.passesMuteAll`, the `MUTE_ALL_PASS` flag). The Mute all column says what the core gate does;
`test/dunning-kind-fix-notification-kinds.spec.ts` walks every kind through it and fails when a new kind is not classed money or not,
and drives every safety key and every money sender with Mute all on.

- Note 1: a safety alert's push passes Mute all; it is urgent (sent at once, even in quiet hours) when its severity is `critical`
  (urgent and crisis replies), and an eating-disorder reply (`warning`) waits for 08:00. The coach payout notice
  (`checkout/payout-notice.service.ts`) and the Day 7 payment alert (`checkout/dunning-v2/dunning-v2.dispatcher.ts`) carry
  `MUTE_ALL_PASS`, so their pushes pass too. Refund and dispute alerts are in-app rows only. Every other coach alert push is muted.
- Note 2: these senders read the settings themselves, and since FR-1154 they always write the in-app row: `engagement/workout-reminder.service.ts`
  (the push obeys Mute all), `notifications/nudges/nudge-engine.service.ts` (push and email obey Mute all; a muted user with no
  in-app channel on is `suppressed_muted`) and `community/notifications/community-notifications.service.ts` (the push obeys Mute all).
  `packages/trials/trial-notice.service.ts` passes `MUTE_ALL_PASS` and `checkout/plan-renewal/switch-tell.ts` no longer reads `muted`.

### Community v1-4 push kinds

These seven kinds are part of the Community Expansion (realtime + push slice).
They are **code-level only** — the `NotificationPreferences` table has no
per-kind column for them (v1-4 is schema-frozen), so their channel defaults
live in `COMMUNITY_PUSH_DEFAULTS`
(`src/community/notifications/community-notifications.types.ts`) and are applied
at the read path. All delivery is gated behind `FEATURE_COMMUNITY_PUSH`.

| Kind | In-app | Push | Email | Setting | Mute all | Category | Who receives |
| ---- | ------ | ---- | ----- | ------- | -------- | -------- | ------------ |
| `community_message_received` | on | on | off | none | row kept, push muted (note 2) | COACH_DIRECT | Member |
| `community_dm_received` | on | on | off | none | row kept, push muted (note 2) | COACH_DIRECT | Member |
| `community_post_replied` | on | on | off | none | row kept, push muted (note 2) | CLIENT_BOT | Post author |
| `community_event_starting_soon` | on | on | off | none | row kept, push muted (note 2) | MILESTONE | RSVP'd member |
| `community_challenge_milestone` | on | on | off | none | row kept, push muted (note 2) | MILESTONE | Participant |
| `community_moderation_action_against_me` | on | on | on | none | row kept, push muted (note 2) | SYSTEM | Actioned member |
| `community_membership_changed` | on | off | off | none | row kept, push muted (note 2) | SYSTEM | Member |

`notificationPrefsPrefix` files `community_message_received` (every space chat push) under `community_message`,
a prefix with no column: only `muted` and the space's own setting stop it.

Lock-screen privacy: when enabled, the push `body` is a fixed safe string
(`COMMUNITY_PUSH_BODIES[kind].privacyOn`) that never contains user names,
message excerpts, cohort names, or event titles. The richer privacy-off body
is built only from pre-approved short context.

---

## Endpoints

| Method  | Path                           | Auth           | Request                            | Response                             |
| ------- | ------------------------------ | -------------- | ---------------------------------- | ------------------------------------ |
| `GET`   | `/notifications`               | JWT (any role) | `?limit&cursor&filter=all\|unread` | `{ items, nextCursor, unreadCount }` |
| `POST`  | `/notifications/:id/read`      | JWT (any role) | —                                  | Updated notification row             |
| `POST`  | `/notifications/mark-all-read` | JWT (any role) | —                                  | `{ updated: number }`                |
| `GET`   | `/notifications/preferences`   | JWT (any role) | —                                  | NotificationPreferences row          |
| `PATCH` | `/notifications/preferences`   | JWT (any role) | `UpdateNotificationPreferencesDto` | Updated preferences row              |

All endpoints derive `user_id` from the JWT — clients can only access their own notifications.

---

## Prisma Models

| Model                     | Key fields                                                                  | Notes                                                                              |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Notification`            | `id, user_id, kind, payload, body, deep_link, channel, read_at, created_at` | In-app inbox. One row per delivered notification. Never stores another user's PII. |
| `NotificationDigestLog`   | `id, user_id, digest_kind, window_date, status, sent_at, error`             | Idempotency guard. Unique on `(user_id, digest_kind, window_date)`.                |
| `NotificationPreferences` | `user_id, muted, milestone_push, …`                                         | Per-user channel toggles. 9 kinds × 3 channels = 27 flags + `muted` global.        |

`Notification.body` is capped to 160 chars by `NotificationsService.createNotification`. `Notification.deep_link` uses the `tgp://` scheme so the mobile app routes to the right screen.

---

## Emitters

Each emitter lives in `src/notifications/emitters/` and is a self-contained `@Injectable()` service. Callers import just the emitter they need — no circular imports.

| Emitter file                         | Kind emitted              | Called from                      |
| ------------------------------------ | ------------------------- | -------------------------------- |
| `milestone-reached.emitter.ts`       | `milestone_reached`       | WeightService, CheckInsService   |
| `message-received.emitter.ts`        | `message_received`        | MessagingService                 |
| `missed-checkin.emitter.ts`          | `missed_checkin`          | PtmService (checkin_miss signal) |
| `weight-trend-alert.emitter.ts`      | `weight_trend_alert`      | WeightService                    |
| `checkin-submitted.emitter.ts`       | `checkin_submitted`       | CheckInsService                  |
| `build-week-day-unlocked.emitter.ts` | `build_week_day_unlocked` | BuildWeekService                 |
| `coach-alert.emitter.ts`             | `coach_alert`             | CoachAlertsService               |

All emitters are **fire-and-forget** — they catch every error internally and log at WARN level. Callers do not `await` the emitter result.

---

## Email Digest

### How it works

1. `DigestScheduler` fires three cron jobs (UTC times, all configurable via env):
   - Client daily: `CLIENT_DAILY_CRON` (default `0 7 * * *`)
   - Coach daily: `COACH_DAILY_CRON` (default `0 6 * * *`)
   - Weekly (both roles): `WEEKLY_DIGEST_CRON` (default `0 8 * * 0` = Sunday)

2. For each eligible user, `DigestService` calls `claimDigestWindow(userId, kind, windowDate)`. This inserts a row in `NotificationDigestLog` with a unique constraint on `(user_id, digest_kind, window_date)`. If the row already exists the send is skipped — re-running the cron for any reason never produces duplicate emails.

3. `DigestService` builds the template data (check-in counts, streak, weight delta for clients; roster snapshot for coaches) and compiles the Handlebars template.

4. The HTML email is sent via the configured transport (`EMAIL_TRANSPORT`).

5. On success: `markDigestSent(logId)`. On failure: `markDigestFailed(logId, error)`.

### Privacy rules in digest content

- Client digest: only that client's own data. Coach name uses first name only.
- Coach digest: client display names only (first name). No weight, income, or body metrics from any client. Counts only ("3 clients need check-in this week").

---

## Rate Limiting

Push notifications are rate-limited to **1 push per user per kind per 60 seconds** via an in-process Map. At scale (multi-replica), migrate to a Redis sorted-set TTL key: `notif:rate:<userId>:<kind>`.

---

## Env Vars

| Var                           | Default                                | Meaning                                                          |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `EMAIL_DIGEST_CLIENT_ENABLED` | `on`                                   | Set to `off` to disable all client digest emails                 |
| `EMAIL_DIGEST_COACH_ENABLED`  | `on`                                   | Set to `off` to disable all coach digest emails                  |
| `EMAIL_DIGEST_CLIENT_DAILY_ENABLED` | `off`                            | Only `on` sends the client daily digest; the weekly one is kept  |
| `CLIENT_DAILY_CRON`           | `0 7 * * *`                            | Cron schedule for client daily digest (UTC)                      |
| `COACH_DAILY_CRON`            | `0 6 * * *`                            | Cron schedule for coach daily digest (UTC)                       |
| `WEEKLY_DIGEST_CRON`          | `0 8 * * 0`                            | Cron schedule for weekly digest (UTC, Sunday)                    |
| `EMAIL_FROM_ADDRESS`          | — (required for any live transport)    | The one From address for every email (src/email/email-sender.ts) |
| `EMAIL_TRANSPORT`             | `log`                                  | Transport: `resend`, `sendgrid`, `postmark`, or `log` (dev/test) |
| `RESEND_API_KEY`              | —                                      | Required when `EMAIL_TRANSPORT=resend`                           |
| `SENDGRID_API_KEY`            | —                                      | Required when `EMAIL_TRANSPORT=sendgrid`                         |
| `POSTMARK_SERVER_TOKEN`       | —                                      | Required when `EMAIL_TRANSPORT=postmark`                         |
| `APP_URL`                     | `https://app.thegrowthproject.app`     | Base URL for client digest CTA and unsubscribe links             |
| `CONSOLE_URL`                 | `https://console.thegrowthproject.app` | Base URL for coach digest CTA links                              |

---

## Tests

| File                                     | What it asserts                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/notification-emitters.spec.ts`    | Every emitter: correct kind, body ≤ 160 chars, no emoji, tgp:// deep-link, payload shape, graceful error handling                                                    |
| `tests/notifications.controller.spec.ts` | Every endpoint: 401 without auth, 200 with valid JWT, whitelist stripping, validation errors                                                                         |
| `tests/digest.cron.spec.ts`              | Template snapshot (renders, contains fixture data, no emoji), idempotency logic (second claim returns false), subject line format (numeric, plural correct)          |
| `tests/notification-prefs.spec.ts`       | getPreferences defaults, updatePreferences create + partial update, mute suppresses createNotification, per-kind channel gate, markRead 404 guard, markAllRead count |

---

## Future Work

- Replace the in-process push rate-limit Map with Redis sorted sets when the app scales beyond a single Fly machine.
- Add `User.push_token` column and wire real APNs/FCM SDK calls in `NotificationsService.pushToCoach`.
- Add `GET /notifications/digest-log` (owner-only) to inspect send history for debugging.
- Migrate digest cron to `SchedulerRegistry` dynamic registration so schedules can be changed at runtime without a redeploy.
- Add weekly digest for client wins section (currently returns empty array — needs CommunityWin query).
