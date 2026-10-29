# Notifications Module

The notifications module holds the in-app notification inbox, push delivery, the email digests and per-user channel preferences. Most senders go through it: an emitter in `emitters/`, `NotificationsService.createNotification` or `NotificationsService.sendPush`, so the per-kind switches, Mute all and push quiet hours are applied there. A few senders write `Notification` rows with Prisma themselves (`checkout/plan-renewal/switch-tell.ts`, `onboarding/onboarding.service.ts`, `onboarding/flagged-join-alert.ts`, `community/safety/community-moderation-notices.ts`, `ai/gateway/materialisers/send-notification.materialiser.ts`), so the `createNotification` gate does not run for those rows.
Pushes sent with `NotificationsService.pushToUser` skip the core gate too: it reads no preference and goes straight to Expo, not
through the `sendPush` outbox. Its callers read the settings themselves or not at all: the trial notice
(`packages/trials/trial-notice.service.ts`), the nudges (`notifications/nudges/nudge-engine.service.ts`), the coach brief
(`coach/brief/coach-brief.scheduler.ts`), the churn intervention message (`coach/command-center/churn-intervention.service.ts`),
the workout reminder (`engagement/workout-reminder.service.ts`), Scout (`scout/scout.service.ts`), the payout notice
(`checkout/payout-notice.service.ts`), the dunning v2 dispatcher (`checkout/dunning-v2/dunning-v2.dispatcher.ts`) and the community
notifications (`community/notifications/community-notifications.service.ts`). The coach brief, the churn intervention and Scout read
only `muted`. `NotificationsService.pushToCoach` has no caller outside its spec.

---

## Notification Kind × Channel × Default-On Matrix

| Kind | In-app | Push | Email | Setting | Mute all | Who receives |
| ---- | ------ | ---- | ----- | ------- | -------- | ------------ |
| `milestone_reached` | on | on | on | `milestone_*` | row kept, push muted | Client |
| `message_received` | on | on | off | `message_*` | row kept, push muted | Client |
| `missed_checkin` | on | on | off | `missed_checkin_*` | row kept, push muted | Client + Coach |
| `weight_trend_alert` | on | on | off | `weight_trend_*` | row kept, push muted | Client |
| `checkin_submitted` | on | off | off | `checkin_submitted_*` | row kept, push muted | Coach |
| `build_week_day_unlocked` | on | on | on | `build_week_*` | row kept, push muted | Client |
| `coach_alert` | on | on | off | `coach_alert_*` | row kept, push muted except safety and money alerts (note 1) | Coach |
| `coach_client_moved` | on | n/a | n/a | none | row kept | Coach (the coach a client left for TGP's house coach; SWITCH-TELL-BE; one in-app row written with Prisma, no push) |
| `client_digest` | off | off | on | `digest_*` | email muted | Client |
| `coach_digest` | off | off | on | `digest_*` | email muted | Coach (after the email goes out, one inbox row on the `email` channel says the summary was sent) |
| `workout_reminder` | on | on | n/a | `workout_reminder_*` | row kept, push muted (note 2) | Client (C05 item 7; the family has `workout_reminder_inapp` and `workout_reminder_push` only) |
| `workout_assigned` | on | on | n/a | `workout_reminder_*` | row kept, push muted | Client (FU-WORKLOG-126: the workout reminder switches; one inbox row on the `push` channel, so `workout_reminder_push` gates the row too; the workout builder and the program library also queue the device push, the AI assign-workout path writes only the row) |
| `meal_plan_assigned` | on | n/a | n/a | none | row kept | Client (one row from the AI assign-meal-plan path, written on the `push` channel; it shows in the inbox, and no device push is sent) |
| `drip_released` | on | on | off | `drip_released_*` | row kept, push muted | Client (buyer) |
| `coach_new_purchase` | on | on | off | `coach_new_purchase_*` | passes (money) | Coach |
| `booking_requested`, `booking_confirmed`, `booking_declined`, `booking_cancelled`, `booking_rescheduled`, `booking_reminder_24h`, `booking_reminder_1h`, `booking_link_needed`, `booking_link_ready`, `booking_request_expired` | on | on | off | `booking_*` | row kept, push muted | Client + Coach |
| `nudge_missed_checkin` | on | on | off | `nudge_missed_checkin_*` | row kept, push and email muted (note 2) | Client |
| `nudge_streak_broken` | on | on | off | `nudge_practice_paused_*` | row kept, push and email muted (note 2) | Client |
| `nudge_onboarding_abandoned` | on | on | on | `nudge_onboarding_abandoned_*` | row kept, push and email muted (note 2) | Client |
| `nudge_inactive` | on | on | on | `nudge_inactive_*` | row kept, push and email muted (note 2) | Client |
| `dunning_blocker` | on | n/a | n/a | none | passes (money) | Client (the Day 3, Day 7 and dispute payment blocker, and the full-refund notice; the payment push and emails come from `dunning-v2.dispatcher.ts` through `pushToUser` and `EmailService`, outside this kind) |
| `first_payment` | on | n/a | n/a | none | passes (money) | Coach (an in-app row plus a hidden `push` twin row; no device push is sent) |
| `trial_ending` | on | on | on | none | passes (money) | Client (`TrialNoticeService` writes the row, sends the push with `pushToUser` and sends the trial email; it reads no email flag) |
| `plan_renewal` | n/a | on | n/a | `plan_renewal_*` | passes (money) | Client (push only, no inbox row; the family has only `plan_renewal_push`) |
| `contract_signed`, `contract_declined`, `contract_expired` | off | off | on | `digest_*` | no sender yet | Coach (B5 contracts; no sender on main yet) |

Defaults live in `NotificationsService.getPreferences` and match the schema defaults. For a kind with a Setting family, on and off
are the saved default of that family's `_inapp`, `_push` or `_email` flag, and n/a means the family has no flag for that channel.
For a kind with Setting `none`, on means its sender sends on that channel and n/a means no sender does. Most families have all
three flags; `workout_reminder` has only `_inapp` and `_push`, and `plan_renewal` only `_push`. Only the digests (`digest_email`)
and the nudges (`nudge_*_email`) read an email flag before they send; the trial, dunning and payout notice emails are sent by
their own services, which read none. `PATCH /notifications/preferences` sets
each channel flag in `UpdateNotificationPreferencesDto`; the DTO has no `drip_released_*` field, so a PATCH that sends one is
rejected with 400, and those three flags cannot be changed through this endpoint.
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
  The payout notice also sends its email through `EmailService` without reading `coach_alert_email`.
- Note 2: these senders read the settings themselves, and since FR-1154 Mute all never stops their in-app row: `engagement/workout-reminder.service.ts`
  (the push obeys Mute all), `notifications/nudges/nudge-engine.service.ts` (push and email obey Mute all; a muted user with no
  in-app channel on is `suppressed_muted`) and `community/notifications/community-notifications.service.ts` (the push obeys Mute all; it writes its
  inbox row only when it goes on to try the push, see the community section below).
  `packages/trials/trial-notice.service.ts` passes `MUTE_ALL_PASS` and `checkout/plan-renewal/switch-tell.ts` no longer reads `muted`.

### Community v1-4 push kinds

These seven kinds are part of the Community Expansion (realtime + push slice).
They are **code-level only** — the `NotificationPreferences` table has no
per-kind column for them (v1-4 is schema-frozen), so their channel defaults
live in `COMMUNITY_PUSH_DEFAULTS`
(`src/community/notifications/community-notifications.types.ts`) and are applied
at the read path. All delivery is gated behind `FEATURE_COMMUNITY_PUSH`, except the space chat
push (`community_message_received` from `src/community/space-push/`), which only
`FEATURE_COMMUNITY_SPACE_PUSH` gates (`spacePushOn()`, `space-push-policy.ts`). The older
cohort message push of that kind (`pushCohortMessage`, `community-messages.service.ts`) needs
`FEATURE_COMMUNITY_PUSH` and stops whenever the space chat push is on.

| Kind | In-app | Push | Email | Setting | Mute all | Category | Who receives |
| ---- | ------ | ---- | ----- | ------- | -------- | -------- | ------------ |
| `community_message_received` | on | on | off | none | row kept, push muted (note 2) | COACH_DIRECT | Member |
| `community_dm_received` | on | on | off | none | row kept, push muted (note 2) | COACH_DIRECT | Member |
| `community_post_replied` | on | on | off | none | row kept, push muted (note 2) | CLIENT_BOT | Post author |
| `community_event_starting_soon` | on | on | off | none | row kept, push muted (note 2) | MILESTONE | RSVP'd member |
| `community_challenge_milestone` | on | on | off | none | row kept, push muted (note 2) | MILESTONE | Participant |
| `community_moderation_action_against_me` | on | on | on | none | row kept, push muted (note 2) | SYSTEM | Actioned member |
| `community_membership_changed` | on | off | off | none | row kept, push muted (note 2) | SYSTEM | Member |

Of these defaults, only `push` and the category are read. `sendCommunityPush` writes one inbox row on the `push` channel, then
sends the push with `pushToUser`; it writes nothing when `FEATURE_COMMUNITY_PUSH` is off or the kind's push default is off
(`community_membership_changed`, which also has no sender on main). No code reads the `inapp` or `email` values, and no community
email is sent. The space chat push (`community/space-push/community-space-push.service.ts`) goes through `sendPush` and writes no
inbox row.

`notificationPrefsPrefix` files `community_message_received` (every space chat push) under `community_message`,
a prefix with no column: only `muted` and the space's own setting stop it.

Push switches (enabled only by the literal value `true`):
- `FEATURE_COMMUNITY_PUSH` gates `CommunityNotificationsService.sendCommunityPush`:
  the legacy community sender for DMs, post replies, events, challenges,
  moderation and the older cohort message push.
- `FEATURE_COMMUNITY_SPACE_PUSH` independently gates space-chat pushes
  (`community_message_received`: unread updates, replies and High alerts).
  It does not require `FEATURE_COMMUNITY_PUSH`.

Turning off `FEATURE_COMMUNITY_PUSH` alone does not stop space-chat pushes.
To stop both push paths, both switches must be off.

For the legacy `sendCommunityPush` path (privacy is always on today: `resolveLockscreenPrivacy` returns `true`), lock-screen privacy means the push
`body` is a fixed safe string
(`COMMUNITY_PUSH_BODIES[kind].privacyOn`) that never contains user names,
message excerpts, cohort names, or event titles. The richer privacy-off body
is built only from pre-approved short context.

---

## Endpoints

| Method  | Path                           | Auth           | Request                            | Response                             |
| ------- | ------------------------------ | -------------- | ---------------------------------- | ------------------------------------ |
| `GET`   | `/notifications`               | JWT, `student` role | `?limit&cursor&filter=all\|unread` | `{ items, nextCursor, unreadCount, emptyState }` |
| `POST`  | `/notifications/:id/read`      | JWT, `student` role | —                                  | The notification row (404 if it is not the caller's) |
| `POST`  | `/notifications/mark-all-read` | JWT, `student` role | —                                  | `{ updated: number }`                |
| `GET`   | `/notifications/unread-count`  | JWT, `student` role | —                                  | `{ count }`                          |
| `GET`   | `/notifications/preferences`   | JWT, `student` role | —                                  | NotificationPreferences row          |
| `PATCH` | `/notifications/preferences`   | JWT, `student` role | `UpdateNotificationPreferencesDto` | Updated preferences row (30 writes per minute) |
| `PUT`   | `/notifications/timezone`      | JWT, `student` role | `UpdateTimeZoneDto` (IANA name)    | Stored zone result (30 writes per minute) |
| `GET`   | `/email/unsubscribe`           | Public, signed `?t=` token | —                      | HTML confirm page (`digest-unsubscribe.controller.ts`) |
| `POST`  | `/email/unsubscribe`           | Public, signed `?t=` token | —                      | Sets `digest_email` to false, HTML done page |

The controller carries `@Roles('student')`: a client, a coach and the owner pass it (`roleSatisfies` lets a coach through
student routes and the owner through every route), and a `sub_coach` gets 403. The `/notifications` endpoints take `user_id`
from the JWT, so a user reaches only their own notifications. The unsubscribe
endpoints take the user from the signed token instead.

---

## Prisma Models

| Model                     | Key fields                                                                  | Notes                                                                              |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Notification`            | `id, user_id, kind, payload, body, deep_link, channel, read_at, inbox_hidden, created_at` | In-app inbox. `inbox_hidden` keeps a `push` twin of an `inapp` row out of the inbox and the unread counts. |
| `NotificationDigestLog`   | `id, user_id, digest_kind, window_date, status, sent_at, error, created_at` | Idempotency guard. Unique on `(user_id, digest_kind, window_date)`. Status is `sending`, then `sent` or `failed`. |
| `NotificationPreferences` | `user_id, muted, milestone_push, …`                                         | Per-user settings: `_inapp`, `_push` and `_email` flags for most setting families (`workout_reminder` has only `_inapp` and `_push`, `plan_renewal` only `_push`), `muted` (Mute all), the older `*_enabled` reminder switches, `new_client_alerts`, `quiet_hours_start` / `quiet_hours_end` and the time zone. |

`Notification.body` is capped to 160 chars by `NotificationsService.createNotification`. The emitters set `Notification.deep_link` with the `tgp://` scheme so the mobile app routes to the right screen.

---

## Emitters

Each emitter lives in `src/notifications/emitters/` and is a self-contained `@Injectable()` service. Callers inject just the emitter they need.

| Emitter file                         | Kind emitted              | Called from                      |
| ------------------------------------ | ------------------------- | -------------------------------- |
| `milestone-reached.emitter.ts`       | `milestone_reached`       | no caller on main (`packages/milestone.service.ts` names it only in a comment) |
| `message-received.emitter.ts`        | `message_received`        | MessagingService, BroadcastDispatcherService |
| `missed-checkin.emitter.ts`          | `missed_checkin`          | no caller on main                |
| `weight-trend-alert.emitter.ts`      | `weight_trend_alert`      | no caller on main                |
| `checkin-submitted.emitter.ts`       | `checkin_submitted`       | no caller on main                |
| `build-week-day-unlocked.emitter.ts` | `build_week_day_unlocked` | no caller on main                |
| `coach-alert.emitter.ts`             | `coach_alert`             | CoachAlertsService, `checkout/dunning-v2/dunning-v2.dispatcher.ts` |
| `booking.emitter.ts`                 | the ten `booking_*` kinds | SchedulingService, `scheduling-session-lifecycle.service.ts`, `jobs/reminder.job.ts`, `jobs/request-expiry.job.ts` |
| `first-payment.emitter.ts`           | `first_payment`           | CoachFirstPaymentService         |

Error handling differs by emitter. The milestone, message, missed check-in, weight trend, check-in and build-week emitters
catch delivery errors and log a warning. `CoachAlertEmitter` returns a delivery result (`inapp` and `push`: `sent`, `skipped`
or `failed`), and CoachAlertsService and the dunning dispatcher await it. `BookingEmitter` returns a `BookingDeliveryOutcome`.
`FirstPaymentEmitter` catches nothing and throws on a bad payload; `CoachFirstPaymentService` awaits it with the purchase
transaction, so its rows commit or roll back with the first-payment ledger row and the `ClientPurchase`.

---

## Email Digest

### How it works

1. `DigestScheduler` fires three cron jobs (UTC times, all configurable via env):
   - Client daily: `CLIENT_DAILY_CRON` (default `0 7 * * *`)
   - Coach daily: `COACH_DAILY_CRON` (default `0 6 * * *`)
   - Weekly (both roles): `WEEKLY_DIGEST_CRON` (default `0 8 * * 0` = Sunday)

2. For each eligible user, `DigestService` calls `claimDigestWindow(userId, kind, windowDate)`. This inserts a row in `NotificationDigestLog` with a unique constraint on `(user_id, digest_kind, window_date)`. If the row already exists the send is skipped — re-running the cron for any reason never produces duplicate emails.

3. `DigestService` builds the template data (check-in counts, streak, weight delta for clients; roster snapshot for coaches) and compiles the Handlebars template.

4. The HTML email is sent via the configured transport (`EMAIL_TRANSPORT`). Its links come from `digest-links.ts`, never from
   `APP_URL` or `CONSOLE_URL`: the open-app link and the signed `/email/unsubscribe?t=` link both use this backend's fixed
   public origin (`DIGEST_PUBLIC_ORIGIN`). The unsubscribe token is signed with a key derived from `RECENT_AUTH_SECRET`;
   without it no link can be made, the user's send is recorded as failed and no digest goes out.

5. On success: `markDigestSent(logId)`. On failure: `markDigestFailed(logId, error)`.

### Privacy rules in digest content

- Client digest: only that client's own data. Coach name uses first name only.
- Coach digest: client display names only (first name). No weight, income, or body metrics from any client. Counts only ("3 clients need check-in this week").

---

## Rate Limiting

`createNotification` with `channel: 'push'` and no transaction keeps **1 row per user per kind (and `throttle_key`) per 60 seconds**,
tracked in an in-process Map (`recentPushes`, one per replica); inside a transaction it does not throttle. Device pushes from
`sendPush` go through `PushDeliveryService` (`push/push-delivery.service.ts`), which never drops a distinct event: repeats in one
conversation collapse within `COLLAPSE_WINDOW_MS` (60 s), and a per-user cap (`USER_WINDOW_MAX` = 8 per `USER_WINDOW_MS` = 10 min)
defers the other pushes until the window has room. Exempt from the cap: an urgent push, a push that bypasses quiet hours as
urgent, and every `booking_*` kind. `pushToUser` pushes do not go through this outbox, so neither the collapse nor the cap applies.

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
| `RECENT_AUTH_SECRET`          | — (required at production boot)        | Key source for the signed digest unsubscribe link; without it no digest is sent |
| `APP_URL`                     | `https://app.thegrowthproject.app`     | Base of the nudge email links (`app_url`, `preferences_url`); not used by digest links |

---

## Tests

| File                                     | What it asserts                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/notification-emitters.spec.ts`     | The seven older emitters (not booking or first payment): kind, recipient, body content and ≤ 160 chars, tgp:// deep link, payload; the milestone emitter does not throw when createNotification rejects |
| `test/notifications.controller.spec.ts`  | Every HTTP endpoint case is a placeholder (its supertest calls are commented out); only the smoke tests run: the app is defined, and on a mocked service the list shape, prefs carry `user_id`, markAllRead returns the count |
| `test/digest.cron.spec.ts`               | Template snapshot (renders, contains fixture data, no emoji, unsubscribe link), idempotency logic (second claim returns false), subject line format (numeric, plural correct) |
| `test/notification-prefs.spec.ts`        | getPreferences defaults, updatePreferences create + partial update, Mute all keeps the in-app row (MUTE-PAY), per-kind channel gate, markRead 404 guard, markAllRead count |

---

## Future Work

- Replace the in-process `createNotification` push throttle Map with Redis sorted sets (`notif:rate:<userId>:<kind>`) when the app scales beyond a single Fly machine.
- Add `GET /notifications/digest-log` (owner-only) to inspect send history for debugging.
- Migrate digest cron to `SchedulerRegistry` dynamic registration so schedules can be changed at runtime without a redeploy.
- Fill the coach digest's Recent wins section (`_buildCoachDigestData` always passes `recentWins: []`).
