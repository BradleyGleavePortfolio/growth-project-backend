# Client onboarding

Status: **draft, docs-only**. Companion to [`README.md`](./README.md),
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md),
[`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md), and
[`retention-progression-system.md`](./retention-progression-system.md).
This spec defines the **product layer** of client onboarding — the
five-step first-win flow that sits on top of the existing mobile
onboarding screens (`audit-mobile.md` §2 lists the 10-step full path
and the 4-step Lean path) and the AI Guide / habit / program
plumbing already in the runtime.

This spec does NOT replace the mobile onboarding screens. It defines
the events those screens fire, the drop-off recovery the backend
must orchestrate, and the acceptance criteria the operator measures
against. The mobile screens remain the single canonical surface; the
runtime PR that lifts this spec adds the event hooks and the
recovery worker.

---

## 1. The problem this spec solves

Today the mobile onboarding flow runs to completion, fires a single
`onboarding_completed` event, and hands the client off to the home
screen. There is no platform-side measurement of where the flow
breaks down, no automated drop-off recovery, no archetype-specific
first-win definition, and no contract between mobile completion and
backend progression-state initialisation.

The result: the operator has no programmatic visibility into
onboarding funnel health and no programmatic lever for recovery. An
incident in PR #100 (which we know about because the audit logs show
a partial-fix shape) had to be reconstructed by reading mobile crash
reports.

This spec installs:

- A **5-step product-layer flow** the mobile onboarding screens emit
  as discrete steps, regardless of whether the user is on the
  10-step full path or the 4-step Lean path.
- A **first-win moment** definition per buyer archetype.
- A **drop-off recovery cascade** at 24h / 72h / 7d.
- A **funnel telemetry contract** the admin Product usage screen
  (`docs/admin/control-room-spec.md` §9) renders.
- **Acceptance criteria** the runtime PR is graded against.

---

## 2. The 5-step product layer

The product layer is a higher-level abstraction over the mobile UI
steps. The mobile flow has 10 (or 4 lean) UI screens; the product
layer has 5 milestones, regardless of UI shape. This is the contract
the funnel measures.

### 2.1 Step 1 — Welcomed

**What it means.** The client has signed in (post-invite-redemption)
and has acknowledged the welcome screen.

**Detection.** The mobile fires `client_onboarding_step_completed`
with `step = 'welcomed'` after the user dismisses the welcome screen.
The backend writes a row to a small `OnboardingProgress` table (see
§5).

**Coach context.** The client is now visible to their coach in the
roster as "in onboarding".

**Out:** the client lands on Step 2.

### 2.2 Step 2 — Goals set

**What it means.** The client has stated their primary goal in a
structured form (weight target + timeframe, or strength target +
timeframe, or habit target + cadence). The goal is durable and is
read by the progression system in
[`retention-progression-system.md`](./retention-progression-system.md) §3.1
when `client.first_goal_hit` evaluates.

**Detection.** The mobile fires `client_onboarding_step_completed`
with `step = 'goals_set'` and the goal payload. The backend
validates the payload against the existing `UserProfile.goal` shape
and rejects malformed payloads (no defaults; the user must answer).

**Why this is durable.** The progression system depends on a
parseable goal. If the goals step is skipped (silent default,
optional field), the `client.first_goal_hit` milestone never fires
and the entire client level path stalls at Practitioner. The
runtime PR enforces non-skipability for the goals step in the
Lean path as well as the full path.

**Out:** the client lands on Step 3.

### 2.3 Step 3 — First measurement

**What it means.** The client has logged their first measurement —
a weight, a body-circumference set, or a baseline strength
performance — depending on the program type the coach (or the
default) assigned.

**Detection.** The mobile fires `client_onboarding_step_completed`
with `step = 'first_measurement'` and the measurement payload. The
backend writes the measurement to the existing measurement table
(`WeightLog` for weight; existing strength benchmark tables for
strength) and fires the corresponding measurement-specific event
per [`data-tracking-contract.md`](./data-tracking-contract.md).

**Why this matters.** A measurement at onboarding is the **anchor**
the progression system measures progress against. Without it, the
"first goal hit" milestone has nothing to compare to. The runtime
enforces non-skipability for the measurement step.

**Out:** the client lands on Step 4.

### 2.4 Step 4 — First habit picked

**What it means.** The client has picked a first daily habit — a
target water intake, a daily 10-minute walk, a daily protein floor,
or a coach-defined habit. The pick lands in the existing `Habit`
table.

**Detection.** The mobile fires `client_onboarding_step_completed`
with `step = 'first_habit_picked'` and the habit id. The backend
writes the `Habit` row.

**Why this matters.** The habit is the **smallest possible daily
contract** the client agrees to. The first-win moment in §3 is
defined as "the client logs the habit on three consecutive days" —
without this step, the first-win has no surface to fire on.

**Out:** the client lands on Step 5.

### 2.5 Step 5 — First program assigned

**What it means.** The coach has assigned the first program (or, in
the absence of an explicit assignment, the platform has assigned
the archetype-default program from
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §2).

**Detection.** The mobile fires `client_onboarding_step_completed`
with `step = 'first_program_assigned'` and the program id. The
backend writes the program assignment per `src/workout/`.

**Why this matters.** The program is the long-arc structure the
coaching relationship is anchored to. Without an assigned program,
the client has no scheduled work to do beyond their daily habit
and the relationship to the coach is fragile.

**Out:** the product-layer onboarding is complete. The runtime
fires `client.onboarding_completed` (the milestone in
[`retention-progression-system.md`](./retention-progression-system.md) §3.1)
and the level transitions Newcomer → Initiate.

---

## 3. The first-win moment

The first-win is **not** a step in the 5-step flow. It is the
**first measurable success** the client experiences after the flow
completes. The platform recognises it and the coach is prompted to
celebrate it.

### 3.1 Definition by archetype

The first-win is defined per the **coach's** archetype (per
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §2),
because the coach's archetype shapes the program and therefore the
shape of an early success.

| Coach archetype | First-win definition |
|---|---|
| solo | The client logs the assigned habit on three consecutive days within the first 7 days. |
| gym | The client completes their first scheduled workout session in full (every set logged). |
| influencer | The client completes the first program block (typically a 4-week starter — see [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §2.3). |
| info_seller | The client completes their first scheduled accountability check-in. |

### 3.2 Detection and surface

A new background worker (call it `first-win-watcher`) runs daily.
For each client whose `client.onboarding_completed` milestone fired
within the last 30 days and whose first-win has not yet fired, the
worker re-evaluates the per-archetype condition. On match:

1. Writes a `MilestoneCompletion` row for `client.first_win_<archetype>`
   (a new family of milestones added to the catalog in
   [`retention-progression-system.md`](./retention-progression-system.md) §3.1).
2. Fires a system message in the coach thread per the existing
   `src/messaging/` shape: "Your client {first_name} just hit their
   first win — {definition}. Consider a brief acknowledgement."
3. Fires a PostHog `client_first_win` event with the archetype and
   the days-from-onboarding-completion delta.
4. Fires an `AuditLog` row `progression.milestone_completed` with
   the first-win milestone id.

The system message is **not** sent to the client directly. The
platform never bypasses the coach for celebration, per the
gamification ethics in
[`retention-progression-system.md`](./retention-progression-system.md) §12.

### 3.3 Why "first-win" and not "first-result"

The doctrine is *outcomes, not engagement* (per
[`retention-progression-system.md`](./retention-progression-system.md) §12.1).
The first-win definitions above are deliberately the smallest
outcome that signals the client is *executing*. They are not the
final outcome (a goal hit, a program completed) — those are
separate milestones. The first-win is the leading indicator that
the executing relationship is real.

### 3.4 Failure mode — first-win not fired

If a client crosses the 30-day window post onboarding without firing
a first-win, the worker:

1. Writes an `AuditLog` row `client.first_win_window_lapsed`.
2. Fires a system message in the coach thread: "Your client
   {first_name} has not yet fired their first-win. They completed
   onboarding {N} days ago. Consider a check-in."
3. Surfaces the client in the AI at-risk detector flag set per
   [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §4.2
   with reason `first_win_window_lapsed`.

The 30-day window is OWNER-tunable via an `OnboardingConfig` table;
the spec recommends 30 because it covers the typical 4-week starter
program window. The OWNER confirms.

---

## 4. Drop-off recovery cascade

The recovery cascade is the platform's response to a client who
starts the 5-step flow and does not finish it within a deadline.
Each stage is automatic and runs in a background worker. Each stage
fires exactly once per client per stage.

### 4.1 Stage 1 — 24-hour reminder

**Trigger:** the client has fired Step 1 (`welcomed`) but has not
fired Step 5 (`first_program_assigned`) within 24 hours.

**Action:**
- Fires a push notification via the existing notifications module:
  "You have {N} steps left to set up. Pick up where you left off."
- The notification deep-links into the onboarding flow at the
  furthest-reached step (the mobile knows this from local state; the
  backend includes the step id in the deep-link payload).
- Fires a PostHog event `client_onboarding_reminder_24h_sent`.
- Fires an `AuditLog` row `client.onboarding_reminder_sent` with
  metadata `{stage: '24h'}`.

**Skip conditions:** the user has push notifications disabled; the
user has emailed support; the user has been suspended.

### 4.2 Stage 2 — 72-hour coach nudge

**Trigger:** the client has not fired Step 5 within 72 hours.

**Action:**
- Fires a system message in the coach thread (existing messaging
  module): "Your client {first_name} has not finished onboarding.
  They reached {furthest_step}. A short personal message often gets
  them across the line."
- The coach can dismiss the nudge or take a "send onboarding nudge"
  action which composes a default coach-message draft for the
  coach to edit. The default copy is archetype-aware per the coach's
  archetype.
- Fires a PostHog event `client_onboarding_coach_nudge_sent`.
- Fires an `AuditLog` row `client.onboarding_coach_nudge_sent`.

**Skip conditions:** the coach has explicitly opted out of
onboarding nudges in their settings (a new coach-side preference);
the client has been reassigned in the last 72 hours.

### 4.3 Stage 3 — 7-day re-engagement email

**Trigger:** the client has not fired Step 5 within 7 days and has
not responded to Stages 1 and 2.

**Action:**
- Fires a re-engagement email (template in `docs/emails/`) with a
  coach-personalised body.
- The email is **not** generated by AI in v1; it is a templated
  email with the coach's name, the client's first name, and the
  furthest-reached step. The runtime author may add an AI-drafted
  variant in a later phase, gated by the AI cost guard.
- Fires a PostHog event `client_onboarding_reengagement_email_sent`.
- Fires an `AuditLog` row `client.onboarding_reengagement_sent`.

**Skip conditions:** the user has unsubscribed from re-engagement
emails (existing email-pref shape); the user has been suspended.

### 4.4 Stage 4 — 14-day flag

**Trigger:** the client has not fired Step 5 within 14 days.

**Action:**
- Surfaces the client in the AI at-risk detector flag set with
  reason `onboarding_lapsed_14d`.
- Surfaces the client in the admin Product usage screen
  (`docs/admin/control-room-spec.md` §9) under "lapsed onboarding"
  with the days-since-Step-1 value.
- The platform does not send another notification or email at this
  stage; it is a quiet flag for the coach and the operator to act
  on.
- Fires an `AuditLog` row `client.onboarding_lapsed_14d`.

### 4.5 Recovery completion

When a flagged client subsequently fires Step 5, the recovery
cascade closes:
- Fires a PostHog event `client_onboarding_recovered` with the
  delay value.
- Fires an `AuditLog` row `client.onboarding_recovered`.
- The client is removed from the at-risk flag set.

---

## 5. Schema additions — Prisma sketch

The runtime PR adds:

```prisma
enum OnboardingStep {
  welcomed
  goals_set
  first_measurement
  first_habit_picked
  first_program_assigned
}

model OnboardingProgress {
  id                          String           @id @default(uuid())
  user_id                     String           @unique
  user                        User             @relation(fields: [user_id], references: [id], onDelete: Cascade)
  step_welcomed_at            DateTime?
  step_goals_set_at           DateTime?
  step_first_measurement_at   DateTime?
  step_first_habit_picked_at  DateTime?
  step_first_program_assigned_at DateTime?
  completed_at                DateTime?
  reminder_24h_sent_at        DateTime?
  coach_nudge_sent_at         DateTime?
  reengagement_email_sent_at  DateTime?
  lapsed_14d_at               DateTime?
  recovered_at                DateTime?
  created_at                  DateTime         @default(now())
  updated_at                  DateTime         @updatedAt

  @@index([completed_at])
  @@index([reminder_24h_sent_at])
  @@index([coach_nudge_sent_at])
}

model OnboardingConfig {
  id                          Int              @id @default(autoincrement())
  reminder_24h_after_hours    Int              @default(24)
  coach_nudge_after_hours     Int              @default(72)
  reengagement_after_days     Int              @default(7)
  lapsed_after_days           Int              @default(14)
  first_win_window_days       Int              @default(30)
  updated_at                  DateTime         @updatedAt
  // Single-row table; OWNER edits via admin endpoint.
}
```

The `OnboardingProgress` columns are denormalised for fast worker
queries; the canonical event log is the PostHog event stream.
Recovery-stage timestamps are nullable so the worker can emit the
"sent at" precisely once.

---

## 6. API surface

```
GET    /api/v1/me/onboarding-progress
       -> OnboardingProgress shape
       Read-only. The mobile uses this to render a progress bar.

POST   /api/v1/me/onboarding-progress/step
       Body: { step: OnboardingStep, payload?: {...} }
       Idempotent on (user_id, step). Setting a later step before an
       earlier one is rejected with 422 step_out_of_order.

POST   /api/v1/coach/clients/:id/onboarding-nudge
       Body: { custom_message?: string }
       The coach-side affordance for stage 2. Idempotent within a
       72-hour window per client.

GET    /api/admin/onboarding-funnel?since_days=30&archetype=
       -> { window, by_step: { ... }, by_archetype: { ... }, drop_offs: [...] }
       OWNER-only. Admin Product usage screen consumer.

PATCH  /api/admin/onboarding-config
       Body: partial OnboardingConfig
       OWNER-only. Audited.
```

All routes follow [`../api-conventions.md`](../api-conventions.md).

---

## 7. Funnel telemetry contract

The PostHog event vocabulary additions are in
[`data-tracking-contract.md`](./data-tracking-contract.md). The
admin Product usage screen renders five funnel cells:

| Cell | Source |
|---|---|
| Welcomed → Goals set | `% of OnboardingProgress with step_goals_set_at within 24h of step_welcomed_at` |
| Goals set → First measurement | same shape, next pair |
| First measurement → First habit picked | same |
| First habit picked → First program assigned | same |
| First program assigned → First-win | `% of clients who fire client.first_win_<archetype> within first_win_window_days` |

The funnel is also sliced by archetype (`?archetype=solo` etc.) and
by signup-cohort (the month the user signed up).

The funnel is rendered against real `OnboardingProgress` rows. There
is no synthetic data, per the doctrine in [`../metrics.md`](../metrics.md).

---

## 8. Audit logging

New `AuditAction` constants:

- `client.onboarding_started` (Step 1 fires)
- `client.onboarding_completed` (Step 5 fires)
- `client.onboarding_reminder_sent` (with stage in metadata)
- `client.onboarding_coach_nudge_sent`
- `client.onboarding_reengagement_sent`
- `client.onboarding_lapsed_14d`
- `client.onboarding_recovered`
- `onboarding_config_changed`

---

## 9. Acceptance criteria

The runtime PR is graded against these acceptance criteria. Each is
a measurable property the admin Product usage screen renders.

1. **Step 5 completion within 48 hours.** The share of admitted
   clients who reach Step 5 within 48 hours of Step 1, in any
   rolling 30-day window, exceeds the OWNER-set threshold.
   Recommend 80%; the runtime author does not invent the threshold.
2. **First-win within 14 days.** The share of clients who fire a
   first-win within 14 days of Step 5, in any rolling 30-day window,
   exceeds the OWNER-set threshold. Recommend 60%.
3. **Recovery efficacy.** The share of flagged-at-Stage-1 clients
   who recover (fire Step 5 after the 24-hour reminder) exceeds the
   OWNER-set threshold. Recommend 30%.
4. **Goal step non-skipability.** Zero `OnboardingProgress` rows
   exist with `step_first_program_assigned_at` set and
   `step_goals_set_at` NULL. Enforced by API validation; the
   acceptance criterion is the absence of violating rows, monitored
   by a daily verification query.
5. **No PII in funnel telemetry.** The PostHog event property bag
   for every onboarding event passes the `AnalyticsService.capture()`
   PII-strip (existing). No event includes name, email, phone, or
   address. Verified by the existing PostHog dispatch test.
6. **Audit completeness.** Every Stage-1/2/3 send action lands an
   `AuditLog` row. Verified by a join test in the runtime PR (every
   PostHog `*_sent` event has a corresponding `AuditLog` action
   within 5 minutes).

---

## 10. Per-archetype default invite-link copy

The product layer fixes the invite-link copy at the platform level;
each archetype gets its own default. The actual strings live in the
email-template module under `docs/emails/`. The default-copy
contracts:

- **solo:** "Join my coaching" — coach name + brief one-line bio.
- **gym:** "Join {GymName}" — gym name + location + amenities (read
  from `CoachOrganization.archetype_notes` and the gym profile).
- **influencer:** Bare brand handle + a single-line offer
  description.
- **info_seller:** "Continue with {CoachName} after {CourseName}" —
  the cross-sell shape.

Each default carries a one-line "what happens next" surface visible
when the link is opened, telling the prospective client that they
are about to be admitted to a coach's roster (not signing up to a
public app). This is the contract that makes the *right-fit member,
not buyer* doctrine honest.

---

## 11. Coach-side consumption

The 5-step flow is the contract the coach console
(`docs/coach-console-integration.md`) consumes. Coach-side surfaces:

- **Coach roster.** Each client row carries an "in onboarding" chip
  with the furthest-reached step until Step 5 fires.
- **Coach inbox.** A new "Onboarding nudges" tab surfaces clients in
  Stage 2 (72h overdue) with a one-click "send nudge" affordance.
- **Coach metrics.** A small "onboarding completion" KPI card on
  the coach mobile dashboard showing the share of admits in the
  last 30 days who reached Step 5.
- **Coach copilot.** Per
  [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §5,
  the copilot surfaces "Clients still in onboarding" with action
  affordances.

---

## 12. Mobile interface contract

The mobile screens already exist (`audit-mobile.md` §2 lists the
10-step full path under `Onboarding/` and the 4-step Lean path under
`OnboardingLean/`). The runtime PR adds the event-firing wires per
§2 — it does not redesign the screens.

The mapping between mobile UI screens and product-layer steps:

| Product step | 10-step full UI screens | 4-step Lean UI screens |
|---|---|---|
| welcomed | Step 1 (welcome) | Lean Step 1 (welcome) |
| goals_set | Step 2 (goals) | Lean Step 1 (combined) |
| first_measurement | Step 3 (measurements) | Lean Step 2 (combined measurement) |
| first_habit_picked | Step 5 (habit picker) — Step 4 is profile bio in the full path | Lean Step 3 |
| first_program_assigned | Step 10 (final review + assignment) | Lean Step 4 |

The mobile flow is responsible for firing each step's
`POST /api/v1/me/onboarding-progress/step` call exactly once per
user per step. The backend rejects out-of-order sends with 422; the
mobile retries via the existing offline-queue shape. The mobile
team is the canonical owner of the per-screen wires; this spec
fixes only the backend contract.

---

## 13. Open questions

1. **48-hour Step-5 acceptance threshold.** §9 declares 80% as a
   recommendation. The OWNER confirms before the admin Product
   usage screen renders the KPI.
2. **First-win window.** §3.4 declares 30 days. The OWNER confirms.
3. **Coach-side opt-out.** §4.2 declares an opt-out for onboarding
   nudges. The OWNER confirms whether the opt-out is per-coach or
   per-org (the gym archetype likely wants org-wide opt-in to
   prevent inconsistent client experiences across sub-coaches).
4. **AI-drafted re-engagement email variant.** §4.3 reserves the
   AI-drafted variant for a later phase. The OWNER confirms whether
   the v1 PR includes the AI variant or defers it.
5. **Lean-path goals payload.** The Lean path combines goals with
   the welcome screen; the spec assumes the Lean Step 1 fires both
   `welcomed` and `goals_set` events. The mobile team confirms the
   sequencing.

These five questions are tracked in the root
[`PERP_HANDOFF.md`](../../PERP_HANDOFF.md) Wave 2 entry as open
decisions for the platform-OWNER and the mobile team.

---

## 14. Out of scope

- **Coach onboarding.** See [`onboarding-coaches.md`](./onboarding-coaches.md).
- **The mobile UI screens themselves.** Owned by `growth-project-mobile`.
- **Re-engagement email copy and template.** Owned by
  [`../emails/`](../emails/) and support copywriting.
- **Push notification rendering.** Owned by the mobile push module.
- **AI-drafted re-engagement variant.** Reserved for a later phase.
- **Public-funnel marketing analytics.** TGP doctrine: clients are
  admitted by a coach, not by a marketing funnel. There is no
  "lead capture" surface to instrument.
