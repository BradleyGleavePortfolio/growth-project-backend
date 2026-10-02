# Clinic engagement (C05 items 6 and 7)

Two scheduled jobs in `src/engagement/`. Both use the same mechanism as every other scheduled job in this repo: a `@nestjs/schedule` `@Cron` plus a Postgres table that rows are claimed from with a conditional UPDATE ("claim-by-write", see `src/packages/drip-dispatcher.cron.ts`). There is no Redis or Bull queue. All state is in the database, so a restart or redeploy loses nothing.

Inputs come from onboarding PR-B (`ClientOnboardingIntake.completed_at`, `first_session_date` = C1, `preferred_training_time` = S2) and from the program assignments it creates (`ClientWorkoutAssignment.scheduled_for`).

## 1. Coach welcome message (`CoachWelcomeService`, every minute)

**What it does.** It sends exactly one message from the client's coach into their existing coach-client thread at onboarding `completed_at + 13 minutes`. The message goes through `MessagingService.sendAsCoach`, which is the same path a coach's own message takes. That path writes the thread row, sends the realtime ping, emits the `message_received` push and in-app notification, and records audit, analytics and PTM signals.

**Scheduling.**

- Each tick looks for intakes completed in the last 48 hours that have no `CoachWelcomeMessageJob` yet.
- It inserts one row per client, with `fire_at = completed_at + 13 min`.
- `CoachWelcomeMessageJob.client_id` is `@unique`, so a client can never have a second job. This holds for a replayed `POST /me/onboarding/complete` (which writes `completed_at` once), for a second replica, and for a restart.
- If the coach's flag is off, the row is written with status `skipped` and reason `coach_disabled`. The same happens if the client completed before the flag was last turned on (`completed_at < enabled_at`), so turning the flag on never sends retroactive welcomes.

**Sending.** Due `pending` rows, and `sending` rows whose claim is more than 5 minutes old (the worker died), are claimed. These conditions are checked again at send time; if any is true, the job is set to `cancelled` with the reason shown:

| Condition                                                                                            | reason           |
| ---------------------------------------------------------------------------------------------------- | ---------------- |
| Client row is gone, `deleted_at` is set, or `deletion_scheduled_at` is set                           | `client_deleted` |
| `User.coach_id` is no longer the job's coach                                                         | `detached`       |
| Either side has blocked the other (checked before the send, and also when `sendAsCoach` returns 403) | `blocked`        |
| The coach's flag has been turned off                                                                 | `coach_disabled` |
| The job is more than 24 hours past `fire_at` (long outage)                                           | `expired`        |

**No duplicates.**

- The rendered body is stamped on the row before the send.
- If an earlier attempt stamped a body, the job first looks for a `CoachMessage` from that coach to that client with that exact body, created since the job was created. If it finds one, it marks the job `sent` and links that message instead of sending again. This covers a worker crash mid-send and a send that threw after the row was written.
- `message_id` is also `@unique`.
- Transient errors are retried after 1, 5, 15 and 60 minutes. After 5 attempts the job is set to `failed`.

**Template.** The template supports two placeholders: `{first_name}` (the client's first name, or "there" if missing) and `{coach_first_name}` (or "your coach" if missing). The code default is generic and names no clinic or coach:

> Hi {first_name}, it's {coach_first_name}. Welcome in. Your plan and targets are ready. Message me here anytime.

The coach's welcome text is runtime data in `CoachWelcomeMessageSetting.template`, set at C04. It is never committed to the repository (code, tests, docs and PR text say "the coach's welcome text"). Validation rules:

- 1 to 1000 characters.
- Only the two placeholders are allowed.
- No stray braces.

### How the operator enables it for one coach

Option A: the operator script. It reads the template from a private file outside the repo and prints only the template's length and a sha256 prefix, never the text.

```
DATABASE_URL=... npx ts-node scripts/set-coach-welcome-message.ts \
  --coach-email <owner coach email> \
  --template-file /path/outside/repo/welcome.txt \
  --enable            # add --dry-run first to validate only
npx ts-node scripts/set-coach-welcome-message.ts --coach-email <email> --show
```

Option B: the owner-only endpoints. They require a JWT with the `owner` role; any other role gets 403.

- `GET /api/admin/coaches/:coachId/welcome-message` returns `{ coach_id, enabled, template, effective_template, default_template, placeholders, enabled_at, updated_at }`.
- `PUT /api/admin/coaches/:coachId/welcome-message` takes `{ enabled?: boolean, template?: string | null }`. Sending `null` restores the default.
- Errors carry a stable `code` and a message that says what to do next: 400 `invalid_template` (with `detail` = `empty`, `too_long`, `unknown_placeholder:<name>` or `unbalanced_braces`) or `nothing_to_update`; 404 `coach_not_found`.
- The audit entry records only `enabled`, `custom_template` and `template_length`, never the text.

Turn the flag on **before** the first client finishes onboarding. Clients who completed earlier are deliberately not welcomed. To stop the job without a deploy, set `COACH_WELCOME_SCHEDULER_ENABLED=false` (`0` and `off` also work; unset = on). Production manages this switch through the launch-flag manifest (`.github/fly-env-desired-state.json`, closed set `true` / `false`); the emergency kill is the `"false"` row in the kill table of `docs/runbooks/launch-flags.md`. Never unset it to stop the job: unset turns it back on.

**Consent and AI.** Only intakes with `completed_at` are scheduled, and onboarding completion requires the D2 box-1 consent on file with its exact text. The message is the coach's welcome text (or the generic default) with the two name placeholders filled in by string replacement. No AI provider is called and no client data leaves the platform, so box 2 (AI processing) is not involved; any later AI use of the thread goes through the #626 egress gate like every other coach message.

**Data minimisation and erasure.** `rendered_body` (it contains the client's first name) is kept only while a send can still be retried or reconciled; every terminal state (`sent`, `cancelled`, `failed`) clears it. Account deletion tombstones the `User` row instead of deleting it, so the FK cascades never fire: every tick (also while `COACH_WELCOME_SCHEDULER_ENABLED` is off: the kill switch stops sends, never erasure), `purgeErased()` deletes the welcome jobs of tombstoned clients and coaches and the welcome setting of a tombstoned coach, and a tombstoned client is never scheduled. A failed sweep is logged and retried on the next tick; it never blocks sends for live clients.

## 2. Workout reminders (`WorkoutReminderService`, every 5 minutes)

**Which days.**

- The first session day (C1).
- Every client-local calendar day that has a `ClientWorkoutAssignment` scheduled.
- Nothing before C1.

**When.** At the client's preferred training time (S2), in their own timezone (`NotificationPreferences.timezone`, which mobile syncs from the device; the default is America/Los_Angeles):

| S2                  | Local time |
| ------------------- | ---------- |
| morning             | 07:00      |
| midday              | 11:30      |
| evening             | 17:00      |
| varies / unanswered | 09:00      |

- The reminder can still go out for up to 3 hours after the slot, so a missed tick catches up. After that, the day is skipped.
- Times are compared as local wall-clock time, so DST shifts the UTC instant, not the local time.

**At most one per day.** The job inserts `WorkoutReminderDelivery (client_id, local_date) @unique` before sending. If the insert loses (another replica, a retry or a restart), nothing is sent. If a push fails, the row is recorded as `failed` and is not retried that day.

**Skipped** when:

- that day's assignment is completed, or a `WorkoutSession` exists on that date;
- the client turned reminders off (`workout_reminder_push = false`; default true; the mobile toggle is Settings > Notifications > Workout reminders);
- the client is muted (`muted`);
- the client is deleted or scheduled for deletion;
- the client is in the Day-10 dunning lockout (only while `FEATURE_DUNNING_V2` is on), because workouts answer 403 `LOCKED_DUNNING` then.

`workout_reminder_inapp` controls only the in-app inbox row.

**Copy.** Roman's butler voice: short, warm, no medical claims, no exclamation marks. The title is "From Roman".

- First day: "Your first session is today. Everything is laid out and ready when you are."
- Plan days rotate deterministically by date (see `workout-reminder.policy.ts`).

To stop the job without a deploy, set `WORKOUT_REMINDERS_ENABLED=false` (`0` and `off` also work; unset = on). Production manages this switch through the launch-flag manifest (`.github/fly-env-desired-state.json`, closed set `true` / `false`); the emergency kill is the `"false"` row in the kill table of `docs/runbooks/launch-flags.md`. Never unset it to stop the job: unset turns it back on. The cadence is fixed at every 5 minutes: the 3-hour send window assumes it, so it is not an env override.

Every tick also deletes the reminder ledger rows of tombstoned clients (erasure backstop, same reason as above), including while `WORKOUT_REMINDERS_ENABLED` is off.

## Data and RLS

Migration `20270213000000_clinic_engagement` is additive and has a `down.sql`. The scheduler runs as service_role. Anonymous access is denied on all three tables by a RESTRICTIVE policy.

| Table                        | Who can SELECT                               |
| ---------------------------- | -------------------------------------------- |
| `CoachWelcomeMessageSetting` | the owner, and the coach for their own row   |
| `CoachWelcomeMessageJob`     | the owner only                               |
| `WorkoutReminderDelivery`    | the owner, and the client for their own rows |

No table has a public write policy. `NotificationPreferences` gains `workout_reminder_push` and `workout_reminder_inapp`, both default true.

`test/rls/clinic-engagement-rls.spec.ts` proves these policies on a real Postgres in the `rls-live-tests` CI job: RLS enabled and forced, the exact policy set, who reads which rows, anon denied, and no INSERT, UPDATE or DELETE for any non-service principal.

## Tests

`test/engagement/`:

- `coach-welcome.service.spec.ts`: scheduling at +13 minutes, idempotency across ticks, replicas and restarts, the default-off flag, no retroactive sends, every cancellation reason, retries, stale-claim reconciliation, and the failure cap.
- `workout-reminder.policy.spec.ts`: slots, timezones, DST fall-back and spring-forward, which days get reminders, and the copy rules.
- `workout-reminder.service.spec.ts`: once per day, skip when logged, opt-out, mute, timezone, DST, deleted clients, and failed pushes.
- `welcome-settings.spec.ts`: template validation and rendering, `enabled_at` semantics, rejections, and the script's argument parser.
