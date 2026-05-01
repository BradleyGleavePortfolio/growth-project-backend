# Coach onboarding

Status: **draft, docs-only**. Companion to [`README.md`](./README.md),
[`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md),
[`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md),
[`retention-progression-system.md`](./retention-progression-system.md),
and [`onboarding-clients.md`](./onboarding-clients.md). This spec
defines the **6-step coach setup flow**, the archetype-specific
templates, and the time-to-first-client targets the runtime PR is
graded against.

The coach onboarding flow is the product the coach buys. A coach who
takes longer than a week to sign their first client is a coach we
have failed to onboard, regardless of how well the platform performs
in week 4. The flow is therefore designed for a single first-week
outcome: the coach has a working storefront-or-invite-link, a default
program, and at least one paying client.

---

## 1. The problem this spec solves

The current coach onboarding is a thin shell. A new coach signs up,
hits the coach mobile dashboard, and has to figure out (a) Stripe
connection, (b) program authoring, (c) invite link generation, (d)
how to get clients to the link, and (e) how the first session works
— with no platform-side guidance and no time-to-value measurement.

The result: anecdotally (per the operator transcript), coaches drop
out before signing their first client at meaningful rates, and the
platform has no visibility into where the drop-off happens.

This spec installs:

- A **6-step setup flow** the coach mobile renders as a sequenced
  task list in the existing `CoachHomeScreen`.
- **Archetype-specific templates** — the first program template, the
  first offer scaffold, and the first invite-link copy come pre-
  filled per the coach's archetype.
- A **median time-to-first-client target** the runtime PR is graded
  against.
- A **per-step funnel telemetry contract** the admin Product usage
  screen renders.

The coach flow is intentionally heavier than the client flow (six
steps versus five) because the coach is configuring a product, not
just a relationship.

---

## 2. The 6-step setup flow

### 2.1 Step 1 — Welcomed

**What it means.** The coach has signed in (post-OWNER-provisioning
or post-RoleSelection self-promote, per `audit-mobile.md` §2.4) and
has acknowledged the welcome screen.

**Detection.** The mobile fires `coach_onboarding_step_completed`
with `step = 'welcomed'`. The backend writes a row to
`CoachOnboardingProgress` (§5).

**Out:** the coach lands on the dashboard with the setup task list
showing 1 of 6 complete.

### 2.2 Step 2 — Profile completed

**What it means.** The coach has completed the required fields on
`CoachProfile`: business name, profile photo, bio, archetype-aware
specialty (e.g. "strength + conditioning" for solo, "trainer roster"
for gym, etc.).

**Detection.** The mobile fires `coach_onboarding_step_completed`
with `step = 'profile_completed'`. The backend validates the
required fields against an archetype-specific schema and rejects
incomplete submissions (no defaults; the coach must answer).

**Why this matters.** The profile is what the prospective client
sees on the invite landing page (per `docs/invite-landing.md`). A
half-built profile signals an unprepared coach and depresses
invite-redemption.

**Out:** the coach lands on Step 3.

### 2.3 Step 3 — Stripe connected

**What it means.** The coach has completed Stripe Checkout for the
platform subscription. `CoachSubscription.status` is `trialing` or
`active`.

**Detection.** The Stripe webhook
(`customer.subscription.created` or `.updated`) fires; the existing
handler in `src/billing/webhook/` writes the `CoachSubscription`
mirror; an additional service hook writes
`CoachOnboardingProgress.step_stripe_connected_at = now()`.

**Why this matters.** Without an active subscription, the coach
cannot publish an invite link, generate a program, or send a
message to a client. The runtime gates Steps 4–6 on this step
having fired.

**Sub-coach exemption.** A sub-coach in a Flow B org per
[`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §8.2 does
**not** establish their own Stripe subscription; the head coach
pays. For sub-coach onboarding, this step is replaced by
`step_membership_redeemed_at` and is satisfied by the act of
redeeming the `CoachInvite` token. The flow then has 5 steps for a
sub-coach, not 6.

**Out:** the coach lands on Step 4.

### 2.4 Step 4 — First program template

**What it means.** The coach has either (a) saved the archetype-
default program template into their library, (b) imported an
existing program from a CSV / json shape per a future import
contract, or (c) authored a program from scratch (the slow path).
The default — option (a) — is the recommended path and is one click
from the mobile setup task list.

**Detection.** The mobile fires `coach_onboarding_step_completed`
with `step = 'first_program_template'` and the
`workout_routine_id`. The backend writes the program reference.

**Why this matters.** The program is what the coach assigns to the
client at Step 5 of the client onboarding flow
([`onboarding-clients.md`](./onboarding-clients.md) §2.5). Without
at least one program in the coach's library, the client onboarding
cannot complete. The two flows are causally chained.

**Default templates by archetype:**

| Archetype | Default first program | Source |
|---|---|---|
| solo | "Foundation strength" — 8 weeks, 3 sessions/week | Existing `src/workout/` seeds. |
| gym | "12-week strength + conditioning" — 4 sessions/week, sub-coach-assignable | Existing seeds + per-sub-coach assignment notes. |
| influencer | "Body recomposition starter" — 4 weeks, optimized for high first-program completion rate | Existing seeds. |
| info_seller | "Accountability container" — 4 weeks of habit cadence + check-ins | New template; see §3 below. |

The default templates already exist in the seed except for the
info-seller template, which is added by the runtime PR. None of the
templates are AI-generated; they are author-vetted seeds.

**Out:** the coach lands on Step 5.

### 2.5 Step 5 — First invite link generated

**What it means.** The coach has generated their first invite link
or storefront URL. For solo and info-seller archetypes this is an
`InviteCode` row; for gym and influencer archetypes the recommended
path is a storefront URL (per PR #125 commerce wave) but an invite
link is still permitted as a fallback.

**Detection.** The mobile fires `coach_onboarding_step_completed`
with `step = 'first_invite_link_generated'` and the invite-code id.
The backend writes the link reference.

**Why this matters.** Without an invite link or storefront URL, the
coach has no surface to share with a prospective client. The link
is the funnel.

**Out:** the coach lands on Step 6.

### 2.6 Step 6 — First client signed

**What it means.** A first client has redeemed the invite link (or
storefront offer) and has been admitted to the coach's roster as an
active client.

**Detection.** The existing `coach.first_client_signed` milestone
in [`retention-progression-system.md`](./retention-progression-system.md) §3.2
fires when the first active client lands. The handler writes
`CoachOnboardingProgress.step_first_client_signed_at = now()` and
fires the level transition Founding → Practicing.

**Why this matters.** First client signed is the only step that
unambiguously means the coach is in business. Every other step is
preparatory.

**Out:** the product-layer onboarding is complete. The runtime
fires `coach.onboarding_completed` (a new milestone in the catalog
per [`retention-progression-system.md`](./retention-progression-system.md) §3.2)
and the coach copilot surfaces a "what next" affordance pointing at
the Compounding-level milestones.

---

## 3. Archetype-specific templates

The Step-4 default templates are pre-filled by the runtime per the
coach's archetype. The runtime PR ships a new `CoachTemplate` table
or an additive shape on the existing `WorkoutRoutine` model — the
spec recommends a separate `CoachTemplate` table to avoid
overloading the existing roster shape.

### 3.1 Schema sketch

```prisma
enum CoachTemplateKind {
  workout_routine
  habit_set
  check_in_template
  offer_scaffold
  invite_link_copy
}

model CoachTemplate {
  id                          String           @id @default(uuid())
  archetype                   String
  kind                        CoachTemplateKind
  reference_id                String                          // FK into the kind-specific table
  display_name                String
  description                 String
  default_for_archetype       Boolean          @default(false)
  retired_at                  DateTime?
  created_at                  DateTime         @default(now())

  @@index([archetype, kind, default_for_archetype])
}
```

The `reference_id` points into the kind-specific table:
- `workout_routine` → `WorkoutRoutine.id`
- `habit_set` → a denormalized json shape on a new `HabitSet` table
- `check_in_template` → `CheckInTemplate.id` (per PR #121 row #21)
- `offer_scaffold` → an offer template reference (per PR #125)
- `invite_link_copy` → an `InviteCopyTemplate.id` (new, simple table
  with `body` and `subject` columns)

The runtime author may decide to inline some of these as JSON on
`CoachTemplate` for simplicity; the spec does not require separate
tables for kinds whose payload is small.

### 3.2 Pre-fill flow

When a coach lands on Step 4:

1. The coach's archetype is read from `CoachOrganization.archetype`.
2. The `CoachTemplate` table is queried for
   `(archetype = X, kind = workout_routine, default_for_archetype = true,
   retired_at IS NULL)`.
3. The result is shown as a one-tap "Save this template to my
   library" affordance with a preview of the full program.
4. The coach can preview, edit, or replace.

The same pre-fill flow drives Step 5 (invite link copy) and the
post-onboarding nudge to define a first habit set.

### 3.3 OWNER-managed templates

Templates are seeded at runtime-PR time. The OWNER can author new
templates via an admin endpoint, mark a template as
`default_for_archetype` (replacing the previous default; the
previous default is auto-`retired_at`), or retire a template
outright. Audited.

---

## 4. Time-to-first-client target

The single most important metric for the coach onboarding flow is
the **median days from Step 1 to Step 6**. The runtime PR is graded
against this metric.

### 4.1 The target

Median time-to-first-client < 7 days for the solo archetype. <14
days for gym, influencer, info-seller (the larger archetypes have
longer lead times because their first client is preceded by
sub-coach hiring, storefront publishing, or course-graduate
identification).

These targets are recommendations, not OWNER-set thresholds. The
admin Product usage screen renders the median; the OWNER decides
whether the running median is acceptable.

### 4.2 Drop-off detection

A coach who has fired Step 1 but not Step 6 within the archetype-
specific target window is flagged in the at-risk coach list (a new
flag set on the admin Coaches table). The flag is **not** about
churn risk on the coach's subscription; it is about delayed
activation.

A flagged coach receives:
- A push notification on day {target_window/2} pointing at the next
  unfinished step.
- An OWNER-side notification on day {target_window} via the
  admin-mobile companion (if deployed) OR via the admin console
  per `docs/admin/control-room-spec.md` §4.

### 4.3 Recovery

When the flagged coach subsequently fires Step 6, the recovery
fires:
- A PostHog event `coach_onboarding_recovered` with the delay value.
- An `AuditLog` row.

The coach is not "rewarded" for recovery; the platform is. The
recovery telemetry is the operator's tool, not the coach's.

---

## 5. Schema additions — Prisma sketch

```prisma
enum CoachOnboardingStep {
  welcomed
  profile_completed
  stripe_connected
  first_program_template
  first_invite_link_generated
  first_client_signed
}

model CoachOnboardingProgress {
  id                                String           @id @default(uuid())
  user_id                           String           @unique
  user                              User             @relation(fields: [user_id], references: [id], onDelete: Cascade)
  step_welcomed_at                  DateTime?
  step_profile_completed_at         DateTime?
  step_stripe_connected_at          DateTime?
  step_first_program_template_at    DateTime?
  step_first_invite_link_generated_at DateTime?
  step_first_client_signed_at       DateTime?
  completed_at                      DateTime?
  reminder_d2_sent_at               DateTime?
  reminder_d5_sent_at               DateTime?
  flagged_lapsed_at                 DateTime?
  recovered_at                      DateTime?
  created_at                        DateTime         @default(now())
  updated_at                        DateTime         @updatedAt

  @@index([completed_at])
  @@index([flagged_lapsed_at])
}
```

The reminder cadence is shorter than the client cadence (2 days,
5 days) because the coach has paid and the platform has higher cost
of inaction. Cadence is OWNER-tunable via `OnboardingConfig` per
[`onboarding-clients.md`](./onboarding-clients.md) §5.

---

## 6. API surface

```
GET    /api/v1/me/coach-onboarding-progress
       -> CoachOnboardingProgress shape
       Read-only. The mobile uses this to render the setup task list.

POST   /api/v1/me/coach-onboarding-progress/step
       Body: { step: CoachOnboardingStep, payload?: {...} }
       Idempotent on (user_id, step). Out-of-order sends are rejected
       with 422 step_out_of_order.

POST   /api/v1/me/coach-onboarding/template-prefill
       Body: { kind: CoachTemplateKind }
       OWNER-or-coach-self. Returns the archetype-default template
       reference, ready to import into the coach's library.

GET    /api/admin/coach-onboarding-funnel?since_days=30&archetype=
       -> { window, by_step, by_archetype, drop_offs }
       OWNER-only.

POST   /api/admin/coach-templates
       Body: { archetype, kind, reference_id, display_name, description, default_for_archetype }
       OWNER-only.

PATCH  /api/admin/coach-templates/:id
       Body: { default_for_archetype?, retired_at? }
       OWNER-only.
```

---

## 7. Funnel telemetry contract

PostHog events (per [`data-tracking-contract.md`](./data-tracking-contract.md)):

- `coach_onboarding_step_completed` — fired once per step
  (idempotent on `(user_id, step)`).
- `coach_onboarding_completed` — fired when Step 6 fires.
- `coach_onboarding_reminder_sent` — fired by the recovery worker.
- `coach_onboarding_flagged_lapsed` — fired when the at-risk window
  exceeds the archetype target.
- `coach_onboarding_recovered`.
- `coach_template_prefilled` — fired when the coach accepts the
  archetype-default template.
- `coach_template_authored` — fired when the coach authors a
  template instead of accepting the default.

The admin Product usage screen renders six funnel cells (one per
step pair) and the time-to-first-client distribution histogram per
archetype.

The `coach_template_authored` vs `coach_template_prefilled` ratio is
a leading indicator of "the default templates are not good enough"
— a high author-rate suggests the defaults are being rejected and
the OWNER should refresh the seed.

---

## 8. Audit logging

New `AuditAction` constants:

- `coach.onboarding_started`
- `coach.onboarding_completed`
- `coach.onboarding_reminder_sent`
- `coach.onboarding_flagged_lapsed`
- `coach.onboarding_recovered`
- `coach.template_prefilled`
- `coach.template_authored`
- `coach.template_archetype_default_changed`
- `coach.template_retired`

---

## 9. Acceptance criteria

1. **Step 6 within 7 days (solo).** Median solo-archetype time from
   Step 1 to Step 6, in any rolling 30-day window, < 7 days.
2. **Step 6 within 14 days (other archetypes).** Median for gym /
   influencer / info-seller, in any rolling 30-day window, < 14
   days.
3. **Stripe-gating integrity.** Zero `CoachOnboardingProgress` rows
   with `step_first_client_signed_at` set and
   `step_stripe_connected_at` NULL (sub-coach exemption excluded).
4. **Profile non-skipability.** Zero `CoachOnboardingProgress` rows
   with `step_first_program_template_at` set and
   `step_profile_completed_at` NULL.
5. **Template prefill rate.** Share of coaches who accept the
   archetype-default template (vs author from scratch) > OWNER-set
   threshold. Recommend 70%; below this the defaults are likely
   wrong.
6. **No PII in funnel telemetry.** Same invariant as
   [`onboarding-clients.md`](./onboarding-clients.md) §9.5.
7. **Audit completeness.** Every reminder send lands an `AuditLog`
   row. Verified by the same join test as
   [`onboarding-clients.md`](./onboarding-clients.md) §9.6.

---

## 10. Sub-coach onboarding

A sub-coach (per [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md))
goes through a **modified 5-step variant** of this flow.

### 10.1 The 5-step variant

| Step | Behavior |
|---|---|
| welcomed | Same. |
| profile_completed | Same. |
| membership_redeemed | Replaces `stripe_connected`. Fires when the `CoachInvite` is redeemed. |
| first_program_template | Same. |
| first_client_signed | A sub-coach's first client signed is fired when a head-coach-reassigned client lands or when an invite redemption attributes the client to the sub-coach. |

The dropped step (Stripe connection) is dropped because Flow B
(internal split) is the typical sub-coach billing arrangement —
sub-coaches do not have their own Stripe subscription.

### 10.2 Detection

The runtime PR adds a discriminator on `CoachOnboardingProgress`:
`is_sub_coach: boolean`. The reminder cadence and acceptance
criteria are evaluated against the appropriate variant.

### 10.3 Head-coach orchestration

A head coach onboarding a sub-coach receives a derived task list:
"You have invited {SubCoachName}. They are at step {N} of 5. {Send
nudge | Reassign clients | Mark complete}."

The nudge fires the same reminder shape as Stage 1 of the coach
recovery cascade, but via a coach-thread system message rather than
a push notification (since the sub-coach is logged in as a coach,
not a client).

---

## 11. Coach-side surface — the setup task list

The mobile renders the 6-step (or 5-step variant) flow as a sequenced
task list on `CoachHomeScreen` (per `audit-mobile.md` §2.6). The
list is **persistent** until completed; completing every step removes
the list and unhides the regular dashboard widgets.

### 11.1 List shape

```
+------------------------------------------------------------+
|  Setup — 4 of 6                                            |
|  [✓] 1. Welcome                                            |
|  [✓] 2. Complete your profile                              |
|  [✓] 3. Connect Stripe                                     |
|  [✓] 4. Save your first program                            |
|  [ ] 5. Generate your first invite link        [Generate]  |
|  [ ] 6. Sign your first client                             |
+------------------------------------------------------------+
```

The list is rendered server-driven from
`GET /api/v1/me/coach-onboarding-progress`; the mobile does not
compute step-completion state locally.

### 11.2 Affordances

Each unfinished step has a primary affordance:

| Step | Affordance |
|---|---|
| 1 | Auto-completes on welcome dismissal. |
| 2 | Deep-links into the profile editor. |
| 3 | Deep-links into Stripe Checkout (existing flow). |
| 4 | One-tap "Save default template" + "Customize" alternative. |
| 5 | One-tap "Generate invite link" + storefront-publish alternative for gym/influencer. |
| 6 | (no direct affordance) — surfaces tips: share the invite, customise the link, etc. |

### 11.3 Skip / hide

A coach cannot skip the list. The list is dismissible only by
completing step 6. (The coach can hide the list temporarily; it
returns on the next session.)

---

## 12. Open questions

1. **Sub-coach onboarding flow length.** §10 declares 5 steps. The
   OWNER may want 4 (collapsing welcomed + membership_redeemed into
   one). The mobile team confirms.
2. **Profile required fields per archetype.** §2.2 says "archetype-
   aware specialty". The OWNER provides the per-archetype required-
   fields list; the spec defaults the runtime author to the existing
   `CoachProfile` shape.
3. **Storefront URL vs invite link at Step 5.** Whether gym /
   influencer archetypes are required to publish a storefront URL
   (per PR #125) at Step 5 instead of an invite link. The spec
   declares storefront recommended, invite-link permitted; the
   OWNER may want to enforce storefront for those archetypes once
   PR #125 is live.
4. **Median time-to-first-client thresholds.** §9.1 and §9.2 are
   recommendations. The OWNER confirms.
5. **Template prefill rate threshold.** §9.5 recommends 70%. The
   OWNER confirms.

These five questions are tracked in the root
[`PERP_HANDOFF.md`](../../PERP_HANDOFF.md) Wave 2 entry.

---

## 13. Out of scope

- **Client onboarding.** See [`onboarding-clients.md`](./onboarding-clients.md).
- **Storefront publishing flow.** Owned by PR #125.
- **Stripe Connect onboarding for Flow B head coaches.** Owned by
  PR #125.
- **Public marketing site for coaches.** Out of platform scope; the
  coach is responsible for traffic to their invite link / storefront.
- **AI-generated coach profile bio.** A future Phase-2 surface;
  excluded from v1 to keep the AI surface scope-bounded per
  [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §6.
- **Coach mobile UI screens themselves.** Owned by `growth-project-mobile`.
- **Coach-help content.** Owned by [`../help/`](../help/) (the
  public self-serve help surface added in PR #103).
