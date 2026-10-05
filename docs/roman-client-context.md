# Roman client context (R3, `ctx-v2`)

Source: `src/roman/context/*`. Tests: `test/roman/roman-client-context.spec.ts`
(personas in `test/roman/fixtures/roman-personas.ts`).

## Scope (owner ruling 2026-09-30 16:31 #6)

Roman sees ALL of the signed-in client's OWN data, strictly scoped to that one
client. Every query carries `user_id = caller` (or `client_id = caller` plus the
current coach for coach-owned rows; `author_id = caller` for posts).

| Block | Source | Window / cap |
|---|---|---|
| `identity`, `profile` | `User` | first name, age, sex, tz, goals, injuries, preferences; no email/phone/DOB/ids |
| `consultation` | `ROMAN_SAFETY_INTAKE_SOURCE` (`RomanConsultationIntakeSource`: the client's own `ClientOnboardingIntake`) | ≤30 Q/A, 80/200 chars; the birth-date answer becomes the whole age only, never the date |
| `safety_intake` | same | `completed` only when all seven screening questions are answered; `clearance_recommended` on any "yes", even on a partial screen; ≤12 screen Q/A (`flagged` marks the triggering ones) |
| `targets`, `macro_method` | `MacroTarget` (current coach) → onboarding fallback | – |
| `today` | `LoggedFoodEntry` | totals + remaining + ≤16 entries (meal, name, kcal, protein) |
| `last_7_days` | `LoggedFoodEntry` | per-day totals + averages |
| `plan` | `ClientWorkoutAssignment` (current coach) | today / next session and completions in the client's local dates; two reads (last 14 local days, newest first, ≤40; today + 14 local days, ascending, ≤30), each cap+1: a hit cap records `plan.history` / `plan.upcoming` in `data_quality.truncated` and the unprovable fields are null |
| `logged_workouts` | `WorkoutSession` | last 8 |
| `weight` | `WeightLog` | 30-day trend |
| `check_ins` | `CheckIn` | last 7 |
| `wearables` | `WearableConnection` (provider, status, last sync ONLY) + `WearableSample` | 7 local days, daily aggregates of STEPS, ACTIVE_ENERGY_KCAL, RESTING_HEART_RATE_BPM, HRV_MS, SLEEP_TOTAL_MIN/SLEEP_DURATION_MIN, SLEEP_EFFICIENCY_PCT, RECOVERY_SCORE, READINESS_SCORE; 7-day averages; last night's sleep. One provider per metric (the client's preference, else the most recently recorded provider: the `resolveBest` policy), never summed across providers. ≤3,000 samples read (cap+1); over that, no totals or averages and `wearables.samples` in `data_quality.truncated`. Never tokens, raw streams or device ids |
| `coach` | `CoachGuideline`, `CoachMessage` (coach_id = current coach, client_id = caller, sender ∈ {coach, client}) | guidelines ≤1,500 chars; last 8 messages BOTH directions, oldest first |
| `community_posts` | `CommunityPost` (author_id = caller, `deleted_at IS NULL`, `visibility='active'`) | last 5: date, scope, title ≤80, body ≤200 |
| `meal_plan` | `DailyMealPlanAssignment` (current coach) | title + items |

Never read: `CoachingSession` (coach private notes), `CommunityWin`,
`BloodworkPanel`, purchases/invoices, any other user's rows. The persona double
proxies those delegates and the suite fails if the builder touches them.

## Budget

- Queries: ≤ `ROMAN_CONTEXT_MAX_QUERIES` (16) per build; 15 s memo per
  (user, local date), invalidated by the write hooks.
- Renderer: target 2,000 tokens, hard cap 3,500 (`estimateTokens` ≈ 4 chars).
  Drop order under the cap, recorded in `data_quality.truncated`:
  `wearables.days` → `community_posts` → `today.entries` →
  `consultation.answers` → `logged_workouts` → `check_ins.notes` →
  `meal_plan.items` → `coach.recent_messages` → `last_7_days.days` →
  `plan.recent_completions` → unflagged safety-screen answers → guidelines cut to 500 chars →
  `profile.free_text` → `coach.guidelines` → `targets.notes` → `check_ins` →
  `upcoming_sessions` → `meal_plan` → `plan.session_exercises` → `weight_trend.points` →
  injuries cut to 60 chars → screen Q/A cut to 80 chars → flagged answers reduced to "Yes".
  The cap is measured on the escaped, wrapped block. Averages, totals, the flagged
  screen questions and `clearance_recommended` (with its instruction) are always kept.
  If nothing fits, rendering throws `RomanContextBudgetError` and the turn runs in
  degraded mode.
- `data_quality.missing` names what the client has not provided
  (`targets`, `plan`, `today_logs`, `intake`, `consultation`, `coach`, `weight`,
  `wearables`), so Roman says so instead of guessing.

## Clearance instruction

When `safety_intake.clearance_recommended` is true the block carries
`ROMAN_CLEARANCE_RECOMMENDED_INSTRUCTION`: keep guidance conservative, use the
screen answers only to steer toward safer, pain-free options inside the plan,
never interpret them medically or name a condition, route intensity/pain/injury
questions to the coach and physician.

`GET /roman/context/me` returns the rendered block, hash and version so a
client can see exactly what Roman saw.
