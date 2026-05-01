# Retention progression system

Status: **draft, docs-only**. Companion to [`README.md`](./README.md),
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md),
and [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md). Defines the
level / milestone / badge ladder for both clients and coaches, the
Charter Members loyal-member program, the yearly-plan upsell path,
and the gamification-ethics statement that gates the runtime.

The progression system is adapted from the Iman Gadzhi
*Digital Launchpad* operator transcript shared with this session. The
adaptation is deliberate: Launchpad is a $37/mo info community where
the progression rewards tenure and content consumption. The Growth
Project is a private high-touch coaching platform where the
progression rewards **client outcomes** (first program completion,
first weight goal, first habit streak) and **coach achievements**
(first client signed, first $1k revenue, first sub-coach hired). The
mechanism is similar; the reinforcement targets are not.

---

## 1. The problem this spec solves

Today the runtime has zero progression structure. A client who
completes a 12-week program sees the same UI on week 13 they saw on
week 1. A coach who signs their tenth client sees the same dashboard
they saw at client one. There is no signal that progress has happened
and no compounding reason to stay.

Per the doctrine *streaks, badges, trophies, and reactions are
excised* (PR #90 removed the prior gamification primitives from the
data model), this spec does not bring those primitives back. Badges
in this spec are **achievement awards** tied to specific outcome
events — they are not daily-streak or social-reaction primitives,
and the spec is explicit about what they are not (§7.1).

The system is built on three claims:

1. **Outcome-anchored reinforcement is durable.** A client who hits
   their first weight goal has a meaningful event the platform can
   recognize. The recognition reinforces the relationship the coach
   has with the client; the badge is an artifact of the coaching
   relationship, not of the platform.
2. **Coach progression is undermodeled.** A coach who hits $1k MRR
   for the first time has a market-shaping event the platform can
   surface to them and to the admin console as an early-success
   signal.
3. **Drip-unlocks are how a high-touch platform expands surface area
   without overwhelming the new user.** A new client does not need
   the AI Guide on day one; they need their first habit and their
   first check-in. A new coach does not need the AI Program Builder
   on day one; they need their first invite link and their first
   client. Drip-unlocking the surfaces against milestone events
   maps capability to readiness.

---

## 2. Mental model — three independent axes

The progression system has three independent axes. A given user is
positioned by all three.

### 2.1 Level (the ladder)

A monotonic, asymmetric ladder of named levels for clients and a
separate ladder for coaches. Each level is reached by accumulating
milestone completions (§3). Levels are named, not numeric, to fit
the brand voice — but the underlying enum is small and stable.

**Client levels:**

| Level | Internal id | What it means |
|---|---|---|
| Newcomer | `client_newcomer` | Just admitted; pre-onboarding. |
| Initiate | `client_initiate` | Onboarding complete, first program assigned. |
| Practitioner | `client_practitioner` | First program completed. |
| Established | `client_established` | First measurable outcome (first goal hit, first 12-week block done). |
| Steward | `client_steward` | First mentor-of-newcomer act (Charter Members eligibility surface — see §9). |
| Charter Member | `client_charter_member` | Admitted to the Charter Members panel. Distinct from Steward; admission is OWNER-controlled. |

**Coach levels:**

| Level | Internal id | What it means |
|---|---|---|
| Founding | `coach_founding` | Stripe-active, profile complete, first invite link generated. |
| Practicing | `coach_practicing` | First client signed and active. |
| Compounding | `coach_compounding` | First $1,000 in cumulative invoiced revenue. |
| Operating | `coach_operating` | First sub-coach hired (gym/influencer/info-seller archetypes only) **or** first 25 active clients (solo archetype). |
| Scaling | `coach_scaling` | First $10,000 in monthly recurring revenue (cross-archetype). |
| Charter Coach | `coach_charter_coach` | Admitted to the Charter Coaches panel. OWNER-controlled. |

The level names are the public surface. The internal ids are the
column values in the schema. Renaming a level is a translation-table
change in the runtime, never a schema migration.

### 2.2 Milestones (the events)

A milestone is a single event the platform can detect. A milestone
completion is a row tying a user to a milestone at a timestamp.
Milestones are the only thing that move a user up a level.

The milestone catalog is fixed at runtime-PR time and lives in a
seed file. Adding a new milestone is a seed-file change plus a
backfill if the milestone is retroactive. Removing a milestone is
not allowed; deprecating one is.

### 2.3 Badges (the artifacts)

A badge is a stable, displayable credential awarded for a specific
milestone (or a specific composition of milestones). Badges are the
artifact a user shows another user — on their coach profile, in
their Charter Members chip, in the admin person profile.

Badges are **not** social-reaction primitives. They are not awarded
by other users; they are awarded by the platform on milestone
completion. The doctrine that streaks/badges/trophies/reactions
were excised (PR #90) addressed the social-reaction shape; this
spec brings back only the **platform-awarded credential** shape.
§7.1 makes the distinction explicit.

---

## 3. Milestone catalog

The catalog is the source of truth for what events progress a user.
The runtime PR ships the catalog as a seed under
`prisma/seeds/milestones.seed.ts`. This section is the contract.

### 3.1 Client milestones

| Milestone id | Trigger | Detection source | Level boundary |
|---|---|---|---|
| `client.onboarding_completed` | Client finishes the 5-step product layer in [`onboarding-clients.md`](./onboarding-clients.md). | Existing onboarding completion event in the mobile app + a backend confirmation. | Newcomer → Initiate |
| `client.first_program_assigned` | Coach assigns the first program. | Existing program assignment in `src/workout/`. | Initiate (no level boundary; informational). |
| `client.first_workout_completed` | Client logs the first set on the first workout. | Existing `WorkoutSession` row. | Initiate (informational). |
| `client.first_food_logged` | First `LoggedFoodEntry` row for the user. | Existing food log. | Initiate (informational). |
| `client.first_weight_logged` | First `WeightLog` row. | Existing. | Initiate (informational). |
| `client.first_habit_completed` | First `HabitLog` row with `completed=true`. | Existing. | Initiate (informational). |
| `client.first_check_in_completed` | First `CheckIn` row. | Existing. | Initiate (informational). |
| `client.first_program_completed` | Client completes a full program block per the program schema. | New event in `src/workout/program-completion.service.ts` (defined in PR #121 row #21). | Initiate → Practitioner |
| `client.first_goal_hit` | Client's stated goal (`UserProfile.goal`) is hit per a deterministic rule. | New service. The rule for weight goals: latest `WeightLog.value` crosses the goal threshold from the goal-set side. The rule for strength goals: a `WorkoutSession` that records a logged set ≥ the goal weight × goal reps. The rule for habit goals: a contiguous N-day window where the habit was completed every day, where N is set on the goal. | Practitioner → Established |
| `client.first_outcome_check_in` | First outcome-style check-in (per PR #121 row #21). | New event in `src/check-ins/`. | Practitioner (informational). |
| `client.first_milestone_celebrated_with_coach` | Coach explicitly acknowledges the milestone in the coach thread. | A new `CoachMessage` action type or a structured field on the message. | Established (informational). |
| `client.invited_a_friend` | A new sign-up redeems an invite link the client shared. | New attribution column on `User` (`invited_by_user_id`) — or, if scoped down, a referral-attribution event reserved for a future commerce-wave feature. | Established → Steward |
| `client.charter_admission` | Platform-OWNER admits the client to Charter Members (§9). | OWNER admin action. | Steward → Charter Member |

### 3.2 Coach milestones

| Milestone id | Trigger | Detection source | Level boundary |
|---|---|---|---|
| `coach.profile_completed` | All required `CoachProfile` fields populated. | Existing service. | (pre-level) |
| `coach.stripe_connected` | `CoachSubscription.status` enters `trialing` or `active`. | Existing webhook. | → Founding |
| `coach.first_invite_link_generated` | First `InviteCode` row. | Existing. | Founding (informational). |
| `coach.first_client_signed` | First active client owned by the coach (per the new ownership pointer in [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §4). | New service. | Founding → Practicing |
| `coach.first_thousand_revenue` | Cumulative `Invoice.amount_paid_cents` (sub-coach-aware per Wave 5) crosses $1,000.00. | Existing `Invoice` mirror + a tracker. Decimal(14,2) end-to-end. | Practicing → Compounding |
| `coach.first_sub_coach_hired` | First active `CoachMembership` of role `SUB_COACH` in the coach's org. | New event from sub-coach hierarchy. | Compounding → Operating (gym / influencer / info_seller archetypes) |
| `coach.first_25_active_clients` | Active client count crosses 25 (solo archetype only). | Computed at the per-membership level. | Compounding → Operating (solo archetype only) |
| `coach.first_10k_mrr` | Org-rolled-up MRR crosses $10,000.00. | Existing `CoachSubscription` mirror, org-rolled-up per [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md). | Operating → Scaling |
| `coach.first_program_template_published` | Coach saves a program template to their library (per PR #121 row #28). | New event. | Practicing (informational). |
| `coach.first_ai_recap_sent` | Coach fires `POST /api/v1/coach/recap/send` for the first time (per [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §4.1). | New event. | Practicing (informational). |
| `coach.charter_admission` | Platform-OWNER admits the coach to Charter Coaches (§9). | OWNER admin action. | Scaling → Charter Coach |

### 3.3 Archetype-conditional milestones

A milestone may be archetype-gated. The seed file marks each
milestone with an optional `archetypes` array; the runtime evaluator
ignores triggers when the user's coach (or, for clients, their
coach's) archetype is not in the list.

The two archetype-gated coach milestones in §3.2:

- `coach.first_sub_coach_hired` — `archetypes = ['gym',
  'influencer', 'info_seller']`.
- `coach.first_25_active_clients` — `archetypes = ['solo']`.

Both move a coach Compounding → Operating; the gating ensures the
"path to Operating" is the right path per archetype.

---

## 4. Schema additions — Prisma sketch

The blocks below are illustrative. The runtime PR lifts them into
`prisma/schema.prisma`. **No migration is implied by this spec PR.**

```prisma
enum ProgressionAxis {
  client
  coach
}

model ProgressionLevel {
  id                          String           @id          // e.g. "client_newcomer"
  axis                        ProgressionAxis
  display_name                String                          // "Newcomer"
  rank                        Int                             // monotonic within axis
  description                 String
  unlocked_features           String[]                        // see §6
  created_at                  DateTime         @default(now())

  @@unique([axis, rank])
}

model Milestone {
  id                          String           @id          // e.g. "client.first_program_completed"
  axis                        ProgressionAxis
  display_name                String
  description                 String
  archetypes                  String[]                        // empty = applies to all archetypes
  awards_badge_id             String?                         // FK to Badge.id when this milestone awards a badge
  level_boundary_to           String?                         // FK to ProgressionLevel.id (the level reached when this milestone fires)
  retired_at                  DateTime?                       // deprecation flag
  created_at                  DateTime         @default(now())

  @@index([axis])
  @@index([level_boundary_to])
}

model MilestoneCompletion {
  id                          String           @id @default(uuid())
  user_id                     String
  user                        User             @relation(fields: [user_id], references: [id], onDelete: Cascade)
  milestone_id                String
  milestone                   Milestone        @relation(fields: [milestone_id], references: [id], onDelete: Restrict)
  completed_at                DateTime         @default(now())
  evidence                    Json             // structured snapshot of the triggering data (e.g. { weight_log_id: "...", program_id: "..." })
  source                      String           // 'auto' | 'admin_grant' | 'backfill'

  @@unique([user_id, milestone_id])             // a milestone fires at most once per user
  @@index([user_id, completed_at])
}

model Badge {
  id                          String           @id          // e.g. "first_program_completed"
  display_name                String
  description                 String
  axis                        ProgressionAxis
  visual_token                String                          // a pointer into a token table; see §11
  retired_at                  DateTime?
}

model BadgeAward {
  id                          String           @id @default(uuid())
  user_id                     String
  user                        User             @relation(fields: [user_id], references: [id], onDelete: Cascade)
  badge_id                    String
  badge                       Badge            @relation(fields: [badge_id], references: [id], onDelete: Restrict)
  awarded_at                  DateTime         @default(now())
  awarded_by_milestone_id     String?                         // FK to MilestoneCompletion.id when auto-awarded
  awarded_by_actor_id         String?                         // FK to User.id when admin-granted

  @@unique([user_id, badge_id])
  @@index([user_id])
}

model UserProgressionState {
  user_id                     String           @id
  user                        User             @relation(fields: [user_id], references: [id], onDelete: Cascade)
  axis                        ProgressionAxis
  current_level_id            String
  current_level               ProgressionLevel @relation(fields: [current_level_id], references: [id], onDelete: Restrict)
  level_reached_at            DateTime
  yearly_plan_active_until    DateTime?
  yearly_plan_auto_promoted   Boolean          @default(false)
  charter_member_admitted_at  DateTime?
  updated_at                  DateTime         @updatedAt
}

model JoiningIncentive {
  id                          String           @id @default(uuid())
  axis                        ProgressionAxis
  archetype                   String?
  cohort_label                String                          // e.g. "Q2_2026_charter_50", set at creation by OWNER
  description                 String
  active_from                 DateTime
  active_until                DateTime
  max_admits                  Int?
  current_admits              Int              @default(0)
  granted_features            String[]                        // unlocked-feature ids granted to admits
  retired_at                  DateTime?
}
```

---

## 5. State machine

The progression state machine is small and one-directional.

```
                                        +-------------------+
                                        | (no level)        |
                                        | new user, no row  |
                                        +---------+---------+
                                                  |
                                  client.onboarding_completed
                                  / coach.stripe_connected
                                                  v
                                        +-------------------+
                                        | level: Initiate   |
                                        | / Founding        |
                                        +---------+---------+
                                                  |
                                       milestone fires with
                                        level_boundary_to set
                                                  v
                                        +-------------------+
                                        | next level        |
                                        +-------------------+

                              +-------- yearly_plan upsell taken? --------+
                              | yes (auto-promote — see §10)              |
                              v                                           |
                +--------------------------------+                        |
                | level immediately advanced to  |                        |
                | Charter-eligible level         |                        |
                +--------------------------------+                        |
                                                                          | no (regular path)
                                                                          v
                                                            +------------------------+
                                                            | level advances by      |
                                                            | milestone completions  |
                                                            +------------------------+
```

**Transitions:**

- A milestone with `level_boundary_to = X` sets
  `UserProgressionState.current_level_id = X` if and only if the
  current level's rank is strictly less than X's rank. Idempotent.
- Levels are forward-only. There is no demotion path. (A coach who
  drops below $10k MRR does not lose their "Scaling" level.)
- Charter admission is the only level transition that does **not**
  fire from a milestone — it is an OWNER admin action that writes a
  `MilestoneCompletion` row with `source = 'admin_grant'` and the
  `*.charter_admission` milestone id, then runs the level
  recomputation.
- Yearly-plan auto-promotion (§10) is a parallel transition that
  jumps the user to the highest non-Charter level on their axis,
  recording `yearly_plan_auto_promoted = true` for downstream
  reporting.

---

## 6. Drip-unlock contract

Each level on each axis carries an array of `unlocked_features`
strings. When a user's level advances, every feature in the new
level's array becomes accessible. When the level does not advance,
the feature is gated.

The feature ids are stable strings the runtime caller checks via a
new `useUnlock(user_id, feature_id)` server-side helper. The helper
is a pure read over `UserProgressionState` + `ProgressionLevel` and
adds no Stripe round-trip. It is **advisory** for UI affordances and
**enforcing** for the specific surfaces listed below.

### 6.1 Client-axis unlocks (illustrative)

| Level | Unlocked features |
|---|---|
| Newcomer | `mobile.basic_logging` (food, water, weight) |
| Initiate | `mobile.habits`, `mobile.programs`, `mobile.fasting`, `mobile.coach_thread` |
| Practitioner | `mobile.recipes_full_library`, `mobile.community_wins_post`, `mobile.ai_guide` |
| Established | `mobile.weekly_report`, `mobile.charter_eligible_chip` |
| Steward | `mobile.charter_apply` |
| Charter Member | `mobile.charter_chat` (the private Charter channel — §9) |

### 6.2 Coach-axis unlocks (illustrative)

| Level | Unlocked features |
|---|---|
| Founding | `coach.invite_link_generation`, `coach.first_program_template` |
| Practicing | `coach.ai_weekly_recap`, `coach.at_risk_alerts` |
| Compounding | `coach.ai_program_builder`, `coach.ai_check_in_summarizer` |
| Operating | `coach.org_dashboard`, `coach.org_copilot_lite` (per archetype) |
| Scaling | `coach.org_copilot_full`, `coach.business_copilot` (PR #126) |
| Charter Coach | `coach.charter_chat`, `coach.advisory_panel_admit` |

### 6.3 Enforcing surfaces

A small fixed set of features are **enforcing** — calling the
endpoint without the unlock returns 403:

- `coach.ai_weekly_recap` — `POST /api/v1/coach/recap/preview` and
  `.../send`.
- `coach.ai_program_builder` — the program-builder endpoints from PR
  #117 RFC.
- `coach.org_dashboard` — `/api/v1/org/me` returns a 404 stub when
  the coach is below Operating, EXCEPT for solo coaches whose org
  is just themselves (always 200).
- `mobile.charter_chat` and `coach.charter_chat` — gated by
  `charter_member_admitted_at != null`.

Every other unlock is **advisory** (UI affordance). The list of
enforcing vs advisory is held under
`docs/product/data-tracking-contract.md` for completeness.

### 6.4 Entitlement-aware unlock

An unlock is gated by **both** the progression level AND the
entitlement set in [`../entitlements.md`](../entitlements.md). A
solo coach at Compounding cannot use the AI program builder if their
`entitlements.products.fitness.status = 'past_due'`. The
`useUnlock()` helper returns false when entitlements deny it,
regardless of level.

---

## 7. Badge taxonomy

### 7.1 What badges are NOT

- Not social-reaction primitives. No user awards a badge to another
  user.
- Not daily streaks. The doctrine excised streaks (PR #90); a daily-
  log streak is not a badge.
- Not visible to other users by default. A badge is visible on the
  awardee's own profile and to their coach (or, for coach badges, to
  their org-OWNER and the platform-OWNER). A badge is not surfaced in
  community feeds.
- Not transferable. A badge belongs to the awardee permanently;
  there is no revocation flow short of platform-OWNER admin override.

### 7.2 The badge catalog

The badge catalog is a strict subset of milestones. Not every
milestone awards a badge; only those whose visibility is meaningful
do.

Client badges (illustrative):

- `client.first_program_completed` → "First program"
- `client.first_goal_hit` → "First goal"
- `client.first_outcome_check_in` → "First outcome check-in"
- `client.invited_a_friend` → "Steward"
- `client.charter_admission` → "Charter Member"

Coach badges (illustrative):

- `coach.first_client_signed` → "First client"
- `coach.first_thousand_revenue` → "First $1,000"
- `coach.first_sub_coach_hired` → "First sub-coach"
- `coach.first_25_active_clients` → "First 25 clients"
- `coach.first_10k_mrr` → "$10K MRR"
- `coach.charter_admission` → "Charter Coach"

The display names render in Inter (per the mobile theme
`docs/QUIET_LUXURY_DOCTRINE.md`); the visual token (a small lockup,
no emoji, no color-screaming icons) is held in the mobile theme
package and is referenced from the badge row by id.

### 7.3 Badge admission rules

- A badge is awarded at most once per user. The `BadgeAward`
  unique key on `(user_id, badge_id)` enforces this.
- A platform-OWNER can grant a badge manually (admin endpoint, gated
  by a new `act:progression_grant_badge` capability — see §13). The
  granting writes a `BadgeAward` row with `awarded_by_actor_id` and
  a corresponding `MilestoneCompletion` row with `source =
  'admin_grant'`. The grant is audited.
- A retired badge stops auto-awarding from new milestone
  completions; existing `BadgeAward` rows are preserved.

---

## 8. Joining incentives

Joining incentives are time-boxed cohorts a user can be admitted to
at signup. They are the runtime contract for "the first 50 to join
get X" on a coach's storefront, applied at the platform layer rather
than the storefront layer.

### 8.1 How they work

- An OWNER creates a `JoiningIncentive` row with a label, a window,
  an optional `max_admits`, and an array of `granted_features` (the
  unlock ids from §6).
- A new user's signup path checks the active incentives and, if one
  matches the archetype + axis + window, admits them by writing the
  granted features into a per-user `granted_features` column on
  `UserProgressionState`. The column is read-side and does not
  short-circuit the level system; it just adds extra unlocks.
- `JoiningIncentive.current_admits` is incremented atomically until
  it reaches `max_admits`. Past the cap, new signups are not
  admitted; they get the standard onboarding.

### 8.2 The yearly-plan auto-promotion incentive

A specific, durable incentive: a coach who upgrades to a yearly plan
**at any time** is auto-promoted to the highest non-Charter level on
their axis, with `yearly_plan_auto_promoted = true` recorded on
`UserProgressionState`.

- The auto-promotion runs in a single transaction with the Stripe
  subscription update webhook handler.
- The promoted level is **not** demoted if the yearly plan is
  cancelled. The doctrine: "we promote on lift, we do not demote on
  drop." Admin can demote manually if necessary; that path lands an
  audit row.
- The promotion writes a `MilestoneCompletion` row for every
  intervening level boundary the user skipped, with
  `source = 'yearly_upsell'`.

The yearly-plan upsell is the single biggest revenue lever on the
platform (per the operator transcript). The implementation contract
above is the integrity check.

---

## 9. Charter Members panel

The Charter Members program is the platform's loyal-member channel.
It replaces what the source transcript called "Grand Visors" — the
brand voice of The Growth Project does not match that name; "Charter
Members" fits.

### 9.1 What it is

- A small, OWNER-curated panel of long-tenured high-outcome clients
  (Charter Members) and high-impact coaches (Charter Coaches) who:
  - Get early access to new features.
  - Get a private channel (mobile + coach console) to give feedback
    directly to the platform-OWNER.
  - Get an "advisory" opt-in: their `User.id` is added to a
    feedback-distribution list for product-roadmap surveys.
  - Get a small visual token on their profile (the Charter badge).
- Admission is **not** automatic. It is OWNER-controlled, with a
  predicate suggesting eligibility (Steward level + N months tenure
  for clients; Scaling level + N months tenure for coaches).

### 9.2 The private channel

The channel reuses the existing `src/messaging/` module. A new
`MessageThread` of type `charter_member` (a new column or a `kind`
enum addition) holds the messages.

- Read access: every active Charter Member or Charter Coach +
  platform-OWNER.
- Write access: same.
- Audit: every write lands a `charter.message_sent` audit row. The
  channel is visible in the admin Audit screen.

The channel is **not** a community space (community spaces are owned
by PR #126). It is an in-app private channel reusing `src/messaging/`.

### 9.3 Admission flow

1. The platform-OWNER opens the admin person profile for an eligible
   user. A "Admit to Charter Members / Charter Coaches" button
   appears when the user's level is Steward (clients) or Scaling
   (coaches), gated by `act:charter_member_admit` capability.
2. The OWNER provides a short admission note.
3. The runtime writes:
   - `MilestoneCompletion` for `*.charter_admission` with
     `source = 'admin_grant'` and the note in `evidence`.
   - `BadgeAward` for the Charter badge.
   - `UserProgressionState.charter_member_admitted_at = now()`.
   - `AuditLog` for `charter.member_admitted`.
   - PostHog `charter_admission`.
4. The user receives a system message in the Charter channel
   welcoming them and a notification on the existing notifications
   surface.

Removal from the panel is a separate OWNER admin action with the
same audit cascade and a `charter.member_removed` audit action.

### 9.4 Charter Members vs Steward

A client at Steward is eligible for Charter Members but is not
admitted. The distinction matters: Steward is an outcome tier
("you mentor a newcomer"); Charter Members is a curated panel
("the OWNER admits you"). A client can be Steward forever without
being admitted. The platform never auto-admits.

---

## 10. Yearly-plan upsell

The yearly-plan upsell is the most important commercial surface of
the progression system. It exists for both clients (where the head
coach offers it) and coaches (where the platform offers it).

### 10.1 Coach yearly-plan upsell

- **Surface:** the existing `MembershipScreen` on coach mobile (per
  `audit-mobile.md` §2). A new "Switch to yearly" affordance gated
  by entitlements and presented to coaches who have been on the
  platform for at least N days (where N is OWNER-tunable; recommend
  at least 14 to avoid early-cancellation churn-risk).
- **Stripe shape:** a `coach_subscription_yearly` price with the
  yearly amount. The switch is a `customer_subscription_update` to
  the new price, end-of-period; the existing `CoachSubscription`
  mirror handles it via the existing webhook.
- **Auto-promotion:** §8.2 above. The coach's level jumps to the
  highest non-Charter level on the coach axis ("Scaling"), with
  every intermediate `MilestoneCompletion` row populated.
- **Refund window:** standard Stripe refund window per
  [`../stripe-setup.md`](../stripe-setup.md). A refund within the
  window cancels the auto-promotion and demotes the coach back to
  their pre-promotion level — this is the single supported demotion
  in the system, and it is gated by an OWNER admin endpoint that
  lands an audit row. Out of the refund window, no demotion.
- **Reporting:** the auto-promotion lands a PostHog
  `coach_yearly_upsell_taken` event with properties
  `{ promoted_from, promoted_to, archetype }` (no PII) and an
  admin-metrics counter `coach_yearly_active_count`.

### 10.2 Client yearly-plan upsell

The client yearly-plan upsell is **owned by the head coach**. The
platform exposes a primitive (a yearly billing flow per
[`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §8) the coach
configures on their offer (per PR #125 commerce wave). This spec
does not invent a per-client yearly upsell at the platform layer.

When a client takes a yearly plan offered by their coach:

- The client's `UserProgressionState.yearly_plan_active_until` is
  set.
- The client is **not** auto-promoted across levels. Client
  progression is outcome-based; promoting on payment would invert
  the doctrine. The client gets a small "Yearly member" chip on their
  profile and the JoiningIncentive feature grants per §8 if any
  apply.

The non-promotion of clients on yearly is the **product
distinction** between the client and coach axes: coaches are
promoted because their commercial commitment to the platform is the
relevant signal; clients are not, because their outcome with the
coach is the relevant signal.

---

## 11. Visual tokens

The mobile theme owns the visual representation of badges and
levels. This spec references tokens by id; the mobile theme defines
the styling.

- Per the brand voice (`docs/QUIET_LUXURY_DOCTRINE.md` in
  `growth-project-mobile`), badges are rendered as small typographic
  marks in Inter, no emoji, no color-screaming icons. A badge token
  is a string id resolved by the mobile theme's `theme.badges[id]`
  registry.
- Levels are similarly rendered as small typographic marks.

The Wave 4 mobile-mirror PR (separate repo) defines the registry. This
spec defines the contract: the schema holds id strings; the mobile
client renders them.

---

## 12. Gamification ethics

This section is the contract a platform-OWNER, a runtime engineer, a
support operator, and an admin auditor are held to.

### 12.1 What we optimize for

- **Outcomes.** Client levels move on goals hit, programs completed,
  and outcome check-ins, not on session length, app-open count, or
  content consumption. Coach levels move on revenue and roster
  growth, not on dashboard-refresh frequency or AI-call count.
- **Coach-mediated relationship.** A milestone reaches the client
  through the coach (the system message lands in the coach thread,
  the coach has an opportunity to celebrate). The platform never
  bypasses the coach to congratulate the client directly except for
  Charter Members admission, which is OWNER-mediated.

### 12.2 What we do NOT optimize for

- **Daily-streak engagement.** The doctrine excised streaks. The
  progression system does not bring them back. A client who logs
  every day for 100 days does not get a "100-day streak" badge.
- **Social-comparison reactions.** No leaderboards, no ranks, no
  reactions. Per the doctrine, ranked competition is not part of the
  brand voice.
- **Frequency-driven loops.** No notification scheme that pings the
  user "you're close to your next badge" with a quantified
  countdown. Notifications fire on milestone completion only — not
  on milestone proximity.
- **Pay-to-progress.** Money cannot purchase a badge or a level. The
  yearly-plan auto-promotion is the only money-shaped lever and it
  is bounded to the coach axis (where commercial commitment IS the
  signal); §10.2 makes the explicit choice that the client axis is
  outcome-only.

### 12.3 What we test

The runtime PR includes:

- A jest test that asserts every `Milestone.id` in the seed has at
  least one of (level_boundary_to, awards_badge_id) set —
  milestones with neither effect are dead seed and get rejected at
  test time.
- A jest test that asserts every `unlocked_feature` string in
  `ProgressionLevel.unlocked_features` is in a known feature
  registry — typo-resistance.
- A jest test that asserts no milestone exists with id beginning
  `streak.`, `daily.`, or `consecutive.` — a doctrine integrity
  guard.

### 12.4 Operator override

The platform-OWNER can:

- Grant a milestone manually (admin endpoint, audited).
- Grant a badge manually (admin endpoint, audited).
- Demote a level manually (admin endpoint, audited; see §10.1 refund
  window).
- Retire a milestone (seed-file change, audited).
- Retire a badge (seed-file change, audited).

There is no operator path to bulk-grant; a bulk-grant is a one-shot
script under `scripts/`. Bulk operations fall under the existing
admin GDPR-style rate-limiting and audit pattern.

---

## 13. Admin console surfaces

### 13.1 Person profile additions

- A "Progression" tab on the person profile (per
  `docs/admin/control-room-spec.md` §7) showing:
  - Current level + level-history timeline (one row per
    `MilestoneCompletion` with `level_boundary_to` set).
  - Open milestones (the union of milestones not yet completed,
    archetype-filtered).
  - Badge wallet (every `BadgeAward` for the user).
  - Charter status (admission timestamp, removal timestamp).
- A "Grant milestone" / "Grant badge" / "Demote level" affordance
  gated by `act:progression_grant_badge` /
  `act:progression_grant_milestone` / `act:progression_demote_level`.

### 13.2 Coaches table additions

- A "Level" column showing the coach's current level chip.
- A filter chip for Charter Coaches.

### 13.3 New report manifest entries

- `progression_completions_by_cohort.csv` — one row per
  `MilestoneCompletion` joined to user, archetype, and signup-cohort.
  CSV-only export; no synthetic data.
- `charter_panel_roster.csv` — current Charter Members + Charter
  Coaches with admission timestamp and admitting actor.

### 13.4 New advisory capability matrix entries

| Capability | Endpoints it implies | UI affordance gated |
|---|---|---|
| `view:progression_admin` | `/api/admin/progression/*` (list / inspect) | Renders Progression tab on person profile |
| `act:progression_grant_milestone` | `/api/admin/users/:id/progression/milestones` (POST) | Grant milestone button |
| `act:progression_grant_badge` | `/api/admin/users/:id/progression/badges` (POST) | Grant badge button |
| `act:progression_demote_level` | `/api/admin/users/:id/progression/level/demote` (POST) | Demote button |
| `act:charter_member_admit` | `/api/admin/users/:id/charter/admit` (POST) | Admit-to-Charter button |
| `act:charter_member_remove` | `/api/admin/users/:id/charter/remove` (POST) | Remove-from-Charter button |

---

## 14. API surface

```
GET    /api/v1/me/progression
       -> { axis, current_level, badges, recent_milestones, unlocks }
       The single discovery endpoint a mobile client hits on app boot.

GET    /api/v1/coach/clients/:id/progression
       Coach-scoped read of a client's progression. Reuses
       sub-coach-hierarchy ownership scoping per [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §10.

POST   /api/v1/charter/messages       (gated by `mobile.charter_chat` / `coach.charter_chat`)
GET    /api/v1/charter/messages

POST   /api/admin/users/:id/progression/milestones
       Body: { milestone_id, evidence_note }
       OWNER-only. Idempotent on (user_id, milestone_id).

POST   /api/admin/users/:id/progression/badges
       Body: { badge_id, evidence_note }
       OWNER-only.

POST   /api/admin/users/:id/progression/level/demote
       Body: { reason, target_level_id }
       OWNER-only. The only path that decreases a level.

POST   /api/admin/users/:id/charter/admit
       Body: { axis, note }
       OWNER-only. Cascades per §9.3.

POST   /api/admin/users/:id/charter/remove
       Body: { reason }
       OWNER-only.

POST   /api/admin/incentives
       Body: { axis, archetype?, cohort_label, active_from, active_until, max_admits?, granted_features }
       OWNER-only. Creates a JoiningIncentive row.

PATCH  /api/admin/incentives/:id
       Body: { active_until?, max_admits?, retired_at? }
       OWNER-only.
```

All `/api/admin/*` routes are class-gated by `@Roles('owner')` per
[`../api-conventions.md`](../api-conventions.md). All
`/api/v1/charter/*` routes are gated by the membership in
`charter.member_admitted_at` and reject otherwise.

---

## 15. Audit logging

New `AuditAction` constants the runtime PR adds:

- `progression.milestone_completed` (auto)
- `progression.milestone_granted` (admin)
- `progression.badge_awarded` (auto)
- `progression.badge_granted` (admin)
- `progression.level_advanced` (auto)
- `progression.level_demoted` (admin)
- `progression.yearly_upsell_auto_promoted`
- `progression.feature_unlock_blocked` (when an enforcing surface
  refuses access — landed for forensic reads)
- `charter.member_admitted`
- `charter.member_removed`
- `charter.message_sent`
- `incentive.created`
- `incentive.retired`
- `incentive.user_admitted`

Every row carries `tenant_coach_id` (the user's coach for client
events; the user's org-OWNER for coach events) and the relevant
membership / org id in metadata.

---

## 16. Telemetry

Every audit action has a corresponding PostHog event per
[`data-tracking-contract.md`](./data-tracking-contract.md). Event
properties carry the milestone id, badge id, level id, archetype,
and (for coach axis) MRR-bucket-only — never raw revenue values, to
preserve the no-PII invariant.

Aggregate counters in `/api/admin/metrics?since_days=30`:

```ts
{
  progression: {
    client_levels: { newcomer: number, initiate: number, practitioner: number, established: number, steward: number, charter_member: number },
    coach_levels: { founding: number, practicing: number, compounding: number, operating: number, scaling: number, charter_coach: number },
    milestone_completions_in_window: number,
    badges_awarded_in_window: number,
    yearly_upsells_in_window: number,
    charter_admits_in_window: number
  }
}
```

The progression KPIs surface on `docs/admin/control-room-spec.md` §3
Overview as new KPI cards.

---

## 17. Migration strategy

The progression system is **additive**. There is no existing
progression state to migrate.

- The seed file ships with the milestone catalog and the level/badge
  definitions.
- Every existing user gets a `UserProgressionState` row at level
  `client_newcomer` / `coach_founding` on backfill.
- A one-shot script under
  `scripts/backfill-progression-from-events.ts` walks every existing
  user's history (food logs, weight logs, programs, invoices) and
  fires retroactive `MilestoneCompletion` rows for any milestone
  whose trigger condition is already met. The retroactive rows have
  `source = 'backfill'` and `completed_at` set to the historical
  event timestamp, NOT to the backfill run timestamp.
- The level recomputation runs after the backfill. Most users land
  at a non-Newcomer / non-Founding level immediately.

The backfill is **idempotent** on `(user_id, milestone_id)` and
re-running on top of an already-backfilled user is a no-op.

---

## 18. Open questions

1. **Charter Members tenure threshold.** §9.1 declares a tenure
   threshold for eligibility. The actual N (months) is OWNER-set;
   the schema does not encode it.
2. **MRR-bucket boundaries.** §16 declares MRR-bucket-only event
   properties. The actual bucket boundaries are
   [`../metrics.md`](../metrics.md) responsibility, not this spec's.
3. **Goal-hit detection on weight goals — directionality.** §3.1
   spells out a directional rule for `client.first_goal_hit`. A
   client whose goal is "lose 10 lbs from 200 to 190" hits the
   milestone when `WeightLog.value <= 190`. A client whose goal is
   "gain 10 lbs from 140 to 150" hits when `value >= 150`. The
   runtime author confirms the goal direction is detected from
   `UserProfile.goal` shape — the spec recommends adding an explicit
   `goal_direction` enum to `UserProfile` to remove the inference.
4. **Yearly-plan refund-window demotion.** §10.1 says the only
   supported demotion is on a yearly refund within the Stripe
   window. The OWNER may want zero demotions; the spec defaults to
   "demote on refund" because not demoting creates a gameable
   path (buy yearly, refund in window, keep the level). The OWNER
   confirms the choice.
5. **Charter Members visibility.** Whether Charter status is visible
   to the user's coach. The spec recommends yes (the coach should
   know their client is a Charter Member because it shapes the
   coaching relationship); the alternative is no (Charter is a
   confidential platform-OWNER relationship). The OWNER confirms.

These five questions are tracked in the root
[`PERP_HANDOFF.md`](../../PERP_HANDOFF.md) Wave 2 entry as open
decisions.

---

## 19. Out of scope

- **Mobile rendering of badges, levels, Charter chat.** Owned by
  Wave 4 in `growth-project-mobile`.
- **Social-reaction primitives.** Excised by doctrine.
- **Daily-streak primitives.** Excised by doctrine.
- **Leaderboards / public ranks.** Excised by doctrine.
- **Audio / video Charter calls.** Out of scope; Charter is text
  channel only in v1.
- **Per-archetype level rename.** A future product brief may want
  archetype-specific level names ("First gym session" vs "First
  workout"). Not v1; level names are global.
- **Predictive next-milestone notifications.** Excised by §12.2.
