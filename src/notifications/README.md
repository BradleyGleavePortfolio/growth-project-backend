# Notifications Module

The notifications module is the single place all communication with users and coaches flows through. It manages the in-app notification inbox, push delivery, email digest scheduling, and per-user channel preferences. Every other module (check-ins, weight, messaging, build-week, PTM alerts) calls into this module's emitters rather than writing their own notification logic, so policy changes (mute, quiet hours, rate limits) apply automatically everywhere.

---

## Notification Kind × Channel × Default-On Matrix

| Kind | In-app | Push | Email | Who receives |
|---|---|---|---|---|
| `milestone_reached` | on | on | off | Client |
| `message_received` | on | on | off | Client |
| `missed_checkin` | on | on | off | Client + Coach |
| `weight_trend_alert` | on | on | off | Client |
| `checkin_submitted` | on | off | off | Coach |
| `build_week_day_unlocked` | on | on | on | Client |
| `coach_alert` | on | on | off | Coach |
| `client_digest` | off | off | on | Client |
| `coach_digest` | off | off | on | Coach |

Defaults live in `NotificationsService.getPreferences`. Each channel flag can be toggled independently via `PATCH /notifications/preferences`.

### Community v1-4 push kinds

These seven kinds are part of the Community Expansion (realtime + push slice).
They are **code-level only** — the `NotificationPreferences` table has no
per-kind column for them (v1-4 is schema-frozen), so their channel defaults
live in `COMMUNITY_PUSH_DEFAULTS`
(`src/community/notifications/community-notifications.types.ts`) and are applied
at the read path. All delivery is gated behind `FEATURE_COMMUNITY_PUSH`.

| Kind | In-app | Push | Email | Category | Who receives |
|---|---|---|---|---|---|
| `community_message_received` | on | on | off | COACH_DIRECT | Member |
| `community_dm_received` | on | on | off | COACH_DIRECT | Member |
| `community_post_replied` | on | on | off | CLIENT_BOT | Post author |
| `community_event_starting_soon` | on | on | off | MILESTONE | RSVP'd member |
| `community_challenge_milestone` | on | on | off | MILESTONE | Participant |
| `community_moderation_action_against_me` | on | on | on | SYSTEM | Actioned member |
| `community_membership_changed` | on | off | off | SYSTEM | Member |

Lock-screen privacy: when enabled, the push `body` is a fixed safe string
(`COMMUNITY_PUSH_BODIES[kind].privacyOn`) that never contains user names,
message excerpts, cohort names, or event titles. The richer privacy-off body
is built only from pre-approved short context.

---

## Endpoints

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| `GET` | `/notifications` | JWT (any role) | `?limit&cursor&filter=all\|unread` | `{ items, nextCursor, unreadCount }` |
| `POST` | `/notifications/:id/read` | JWT (any role) | — | Updated notification row |
| `POST` | `/notifications/mark-all-read` | JWT (any role) | — | `{ updated: number }` |
| `GET` | `/notifications/preferences` | JWT (any role) | — | NotificationPreferences row |
| `PATCH` | `/notifications/preferences` | JWT (any role) | `UpdateNotificationPreferencesDto` | Updated preferences row |

All endpoints derive `user_id` from the JWT — clients can only access their own notifications.

---

## Prisma Models

| Model | Key fields | Notes |
|---|---|---|
| `Notification` | `id, user_id, kind, payload, body, deep_link, channel, read_at, created_at` | In-app inbox. One row per delivered notification. Never stores another user's PII. |
| `NotificationDigestLog` | `id, user_id, digest_kind, window_date, status, sent_at, error` | Idempotency guard. Unique on `(user_id, digest_kind, window_date)`. |
| `NotificationPreferences` | `user_id, muted, milestone_push, …` | Per-user channel toggles. 9 kinds × 3 channels = 27 flags + `muted` global. |

`Notification.body` is capped to 160 chars by `NotificationsService.createNotification`. `Notification.deep_link` uses the `tgp://` scheme so the mobile app routes to the right screen.

---

## Emitters

Each emitter lives in `src/notifications/emitters/` and is a self-contained `@Injectable()` service. Callers import just the emitter they need — no circular imports.

| Emitter file | Kind emitted | Called from |
|---|---|---|
| `milestone-reached.emitter.ts` | `milestone_reached` | WeightService, CheckInsService |
| `message-received.emitter.ts` | `message_received` | MessagingService |
| `missed-checkin.emitter.ts` | `missed_checkin` | PtmService (checkin_miss signal) |
| `weight-trend-alert.emitter.ts` | `weight_trend_alert` | WeightService |
| `checkin-submitted.emitter.ts` | `checkin_submitted` | CheckInsService |
| `build-week-day-unlocked.emitter.ts` | `build_week_day_unlocked` | BuildWeekService |
| `coach-alert.emitter.ts` | `coach_alert` | CoachAlertsService |

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

| Var | Default | Meaning |
|---|---|---|
| `EMAIL_DIGEST_CLIENT_ENABLED` | `on` | Set to `off` to disable all client digest emails |
| `EMAIL_DIGEST_COACH_ENABLED` | `on` | Set to `off` to disable all coach digest emails |
| `CLIENT_DAILY_CRON` | `0 7 * * *` | Cron schedule for client daily digest (UTC) |
| `COACH_DAILY_CRON` | `0 6 * * *` | Cron schedule for coach daily digest (UTC) |
| `WEEKLY_DIGEST_CRON` | `0 8 * * 0` | Cron schedule for weekly digest (UTC, Sunday) |
| `EMAIL_FROM_ADDRESS` | `noreply@thegrowthproject.app` | From address for all digest emails |
| `EMAIL_TRANSPORT` | `log` | Transport: `resend`, `sendgrid`, `postmark`, or `log` (dev/test) |
| `RESEND_API_KEY` | — | Required when `EMAIL_TRANSPORT=resend` |
| `SENDGRID_API_KEY` | — | Required when `EMAIL_TRANSPORT=sendgrid` |
| `POSTMARK_SERVER_TOKEN` | — | Required when `EMAIL_TRANSPORT=postmark` |
| `APP_URL` | `https://app.thegrowthproject.app` | Base URL for client digest CTA and unsubscribe links |
| `CONSOLE_URL` | `https://console.thegrowthproject.app` | Base URL for coach digest CTA links |

---

## Tests

| File | What it asserts |
|---|---|
| `tests/notification-emitters.spec.ts` | Every emitter: correct kind, body ≤ 160 chars, no emoji, tgp:// deep-link, payload shape, graceful error handling |
| `tests/notifications.controller.spec.ts` | Every endpoint: 401 without auth, 200 with valid JWT, whitelist stripping, validation errors |
| `tests/digest.cron.spec.ts` | Template snapshot (renders, contains fixture data, no emoji), idempotency logic (second claim returns false), subject line format (numeric, plural correct) |
| `tests/notification-prefs.spec.ts` | getPreferences defaults, updatePreferences create + partial update, mute suppresses createNotification, per-kind channel gate, markRead 404 guard, markAllRead count |

---

## Future Work

- Replace the in-process push rate-limit Map with Redis sorted sets when the app scales beyond a single Fly machine.
- Add `User.push_token` column and wire real APNs/FCM SDK calls in `NotificationsService.pushToCoach`.
- Add `GET /notifications/digest-log` (owner-only) to inspect send history for debugging.
- Migrate digest cron to `SchedulerRegistry` dynamic registration so schedules can be changed at runtime without a redeploy.
- Add weekly digest for client wins section (currently returns empty array — needs CommunityWin query).
