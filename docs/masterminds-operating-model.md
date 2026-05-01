# Masterminds + IRL Events Operating Model

Status: **Draft — spec only.** No runtime code, no schema migrations,
no flags shipped with this PR. This document is the product /
operations / commercial spec for layering paid IRL masterminds on top
of the existing per-seat coach SaaS, in the style of high-ticket
operator-training programs (Quantum-style operator schools, Iman
Gadzhi-style agency masterminds, Hormozi-style "$36k club" mentor
days). It is the single source of truth that downstream
implementation PRs (schema, BFF endpoints, console surfaces, billing
SKUs, runbooks) will reference.

Read first: the repo root [`README.md`](../README.md) for stack,
roles (`OWNER`, `COACH`, `STUDENT`), `CoachSubscription`,
`Invoice`, `PaymentFailure`, `MessageDraft`, `ActivityEvent`,
`AuditLog`, the `BILLING_ENFORCEMENT` flag, and the `entitlements`
read shape. Then [`docs/entitlements.md`](./entitlements.md) for the
`fitness_only` / `finance_only` / `performance_os` bundle and how
`status` collapses across products. This spec extends those two
without contradicting either.

> Out of scope for this PR: the marketing site (`new-website` is
> intentionally untouched), the Stripe dashboard configuration, any
> change to existing entitlement shapes, and any change to existing
> route contracts.

---

## 0. TL;DR — How to run masterminds for this SaaS business

A direct answer to "how do mentors charging $30k/seat for IRL
training days bolt onto this product without breaking it." Everything
below in §1–§14 is the long form; this section is the operating
recipe.

### 0.1 Phased model

| Phase | When | Cohort size | Price band (per seat) | Format | Pre-req | What's being sold | What's being learned |
|---|---|---|---|---|---|---|---|
| **Phase 0 — Pre-launch (Founder Council)** | Now → first 10 paying coaches | 6–10 | $0 (founding) or 50% off SaaS for life | 2-day in-person, founder-led | Hand-picked invite | Co-design + scar tissue | We learn what coaches actually do; they get the founder's ear |
| **Phase 1 — Beta cohort** | First 30 paying coaches | 12–15 | $4,950 deposit + $4,950 on arrival | 2-day workshop, recorded | Active SaaS coach, ≥ 5 active clients | The operating-system playbook | Setup, niche, offer, first 10 clients |
| **Phase 2 — L2 "Operator School"** | After 30+ paid coaches | 25–40 | $12k–$15k | 3-day, quarterly, regional | L1 SaaS active ≥ 60 days, 10+ clients, churn <8%/mo | Repeatable client engine | Marketing system, sales script, retention loop, hiring assistant #1 |
| **Phase 3 — L3 "Mastermind"** | After ≥ 8 L2 alumni hit $20k MRR | 15–25 | $30k–$36k | 4-day, twice a year, flagship venue + monthly virtual + 1:1 | L2 graduate, $15k+ MRR, NPS-vetted | Scaling to a real coaching business | Team build, P&L, brand, second coach, exit options |
| **Phase 4 — Flagship Annual** | Year 2 | 100–250 | $5k–$10k all-cohort ticket | 3-day, alumni + invited prospects | Any paying coach, plus invited guests | Brand, recruiting top of funnel | Networking, big-stage proof, partner pitches |

The unlock condition is the previous tier's *outcome metric*, not
attendance. A coach is allowed into L3 because they have built a
real business at L2, not because they wrote a check. Gate
enforcement is operational at first (OWNER review of an
application), then mechanical once we have enough signal in
`metrics`.

### 0.2 The seven-line operating loop

1. SaaS subscription is the qualification funnel for a paid
   mastermind seat. (You cannot buy L2/L3 without an active L1.)
2. Mastermind seats are the qualification funnel for the next
   higher mastermind. (L3 is closed to non-L2 alumni.)
3. Every IRL event has a pre-work pack and a post-event sprint
   inside the existing app, so we get adoption telemetry and the
   coach gets retention.
4. Every event leaves behind 1 implementation-checklist artifact
   per attendee, surfaced in the coach console as their "operator
   plan."
5. Mastermind tier is mirrored as an entitlement bundle modifier,
   never as a separate role. Role stays `COACH`; tier rides
   alongside the existing `CoachSubscription`.
6. Revenue is split across a recurring SaaS line and an event
   line, both Stripe-mirrored. The event line is non-recurring and
   is *never* required for app access.
7. Cancellation of the SaaS subscription does not refund the
   event. Cancellation of the event before the cutoff date does
   not cancel the SaaS subscription.

### 0.3 First decisions to make once before any code lands

- Pricing: deposit floor, refund cutoff, transferability, payment-plan
  terms, taxes inclusive vs. exclusive. (§7.4)
- Entitlements: do alumni keep mastermind benefits forever, or only
  while subscription is active? Default: alumni status is permanent;
  curriculum *access* requires active SaaS. (§5.2)
- Capacity: who decides if a cohort is full and overflows to the next
  one? OWNER-only, with audit. (§4.3)
- Compliance: who can see attendee email lists, dietary info, room
  assignments? OWNER + a named events-admin role mapped to OWNER for
  now. (§12)
- Refund authority: who can issue an event refund? OWNER, and every
  refund writes an `AuditLog` row with the cohort id. (§7.4)

---

## 1. Strategic intent

The product today sells one thing: a per-seat coach SaaS
subscription, mirrored from Stripe. The mastermind program adds a
second, higher-margin product line that does *not* replace the SaaS
— it depends on it.

### 1.1 Why bolt masterminds onto the SaaS at all

- **The platform is the qualification mechanism.** Mentors selling
  $30k seats today screen by interview; we can screen by usage,
  retention, and revenue signal that we already collect.
- **The platform is the implementation surface.** Hormozi-style
  "intensive day" programs bleed value within 60 days because
  attendees go home with a binder. Here, attendees go home with a
  filled-in console: pre-loaded clients, scheduled check-ins,
  templated content, billing connected.
- **The platform is the retention surface.** Once an attendee's
  business is *running on* the SaaS, churn in the SaaS is correlated
  with churn in the mastermind — and visible to us in
  `CoachSubscription.status`, `ActivityEvent`, and `metrics`.
- **The platform is the post-event accountability surface.**
  Accountability pods, sprint check-ins, and challenge tie-ins all
  live in surfaces we already have or have natural extensions of
  (`messaging`, `community`, `lessons`, `nudges`, `check-ins`,
  `habits`, `notifications`).

### 1.2 What we are not building

- We are not becoming an event-management product. Eventbrite,
  Hopin, Whova, Cvent already exist; we integrate, we do not
  re-implement.
- We are not becoming an LMS. We have `lessons` for in-app
  curriculum delivery; the high-ticket curriculum lives there.
- We are not becoming a CRM for the events team. We expose the
  attendee + payment + attendance state via OWNER-only admin
  endpoints; the events team can push to a real CRM.
- We are not building white-label / multi-tenant in v1. The
  white-glove branded-instance path (§9) is a roadmap entry, not a
  Phase 1 deliverable.

### 1.3 Non-goals (intentionally deferred)

- International tax handling, multi-currency, EU VAT MOSS — Stripe
  Tax handles the easy 80%; the rest waits until we have a
  non-trivial EU cohort. (§7.4)
- Live attendance via biometrics / NFC / facial recognition — manual
  check-in by event-staff is fine for ≤ 100 seats. (§4.5)
- Per-event branded mobile app builds — branded *instance* (web
  console + email) is the v1 of white-glove; per-event app is not.
  (§9)

---

## 2. Tier model

### 2.1 The three SaaS tiers and where masterminds attach

The existing platform recognises one paid tier (the per-seat coach
SaaS) and one bundle SKU (`performance_os` = fitness + finance). For
the mastermind program we introduce three explicit *operator tiers*
on top of the existing `CoachSubscription`. The role is still `COACH`
— see §5.2 for why.

| Tier | Internal id | What it is | Includes | Does **not** include |
|---|---|---|---|---|
| **L1 — SaaS only** | `tier_l1` | Today's product. Per-seat coach subscription. | App access, coach console BFF, invite link, AI assistant, billing surface, basic templates, public help, email onboarding sequence. | Any IRL event, any private community, any 1:1 OWNER time. |
| **L2 — Operator School** | `tier_l2` | Quarterly 3-day workshop + 12 weeks of structured online curriculum + cohort accountability pod. | Everything in L1 + L2 curriculum unlocked in `lessons` + L2 cohort space in `community` + L2 challenge templates + 1 included event seat per quarter. | The flagship 4-day mastermind, 1:1 OWNER time, white-glove branded instance. |
| **L3 — Mastermind** | `tier_l3` | Twice-a-year flagship 4-day + monthly virtual half-day + 1:1 quarterly with OWNER (or designated mentor) + private operator network. | Everything in L2 + L3 curriculum + L3 cohort space + concierge setup + priority support SLA + branded-instance roadmap seat (§9). | A second L3 seat for a partner / co-founder (sold separately). |

Bundle interaction with `entitlements`: L2 and L3 are
*entitlement-bundle modifiers*. They do not change
`active_products` or `bundle` (those stay
`fitness` / `finance` / `performance_os`). They surface in the
admin shape as a new sibling block — `mastermind_tier` — that the
OWNER console renders as a chip next to the plan chip. The shape is
specified in §5.2.

### 2.2 Buy paths and gates

- L1 is sold via the existing Stripe Checkout / coach-billing surface.
  No change.
- L2 is sold via an **application**. Application is gated on
  `tier_l1.status in ('active','trialing','grandfathered')`. (§3)
- L3 is sold via an **invitation**. Invitation requires
  `tier_l2 in ('alumni','active')` plus an OWNER review of the
  applicant's cohort metrics. (§3)

L2 and L3 buy flow is **never** self-serve checkout. The
application creates a `cohort_application` row and, if approved,
issues a *deposit invoice* that can be paid through Stripe's
existing customer-portal flow. Final balance is invoiced at T-30
days from the event. (§7.4)

### 2.3 Tier downgrade and lapse semantics

| State | Effect on app access | Effect on community | Effect on cohort seat | Effect on alumni status |
|---|---|---|---|---|
| L1 cancels | Loses app access per `BILLING_ENFORCEMENT` | Loses cohort space access | Cohort seat held until refund cutoff, then forfeit | Alumni status preserved |
| L2 lapses (subscription cancels) | Per `BILLING_ENFORCEMENT` | L2 cohort space goes read-only | Future seat invitations paused | `alumni:l2` preserved |
| L3 lapses | Per `BILLING_ENFORCEMENT` | L3 cohort space goes read-only | Future flagship seat paused; can re-up at any time | `alumni:l3` preserved |
| OWNER-suspended | All access suspended | All cohort spaces suspended | Future seats blocked; existing seat reviewed | Status frozen, not lost |
| GDPR scheduled | All access suspended (existing behavior) | All cohort spaces suspended | Pending seat reviewed for refund per §7.4 | Status preserved until `deleted_at` |

Default policy: alumni is **forever**, but live curriculum access
follows the active subscription. We surface alumni in the OWNER
console regardless of subscription state so the events team can
re-engage past attendees.

---

## 3. Application + qualification funnel

The funnel runs in five stages, all OWNER-visible. Each stage is a
state on a single `cohort_application` record.

```
INTERESTED → APPLIED → SCREENED → APPROVED → DEPOSIT_PAID → CONFIRMED
                                          ↘ WAITLISTED ↗
                                          ↘ REJECTED
                                          ↘ WITHDRAWN
```

### 3.1 Stage definitions

- **INTERESTED.** A coach hits "I'm interested in L2/L3" in the
  console. We capture user id, tier, source, and a free-text
  motivation. No commitment. Drives marketing list segmentation.
- **APPLIED.** Coach completes the structured application. We
  collect goals, current MRR band, team size, niche, prior coaching
  experience, prior masterminds attended, biggest current bottleneck,
  whether they're using the SaaS today. The form is the primary
  human-judged signal, supplemented by automatic fields below.
- **SCREENED.** Events admin reviews. We auto-attach a
  *qualification snapshot*: `tier_l1.status`, days since signup,
  active client count, retention proxy (% clients with
  `last_activity_at` ≤ 30d), refund history, support-ticket count,
  feature-flag adoption. This is a derived view; it never becomes a
  source of truth.
- **APPROVED.** Events admin approves. The system issues a *deposit
  invoice* via Stripe with a per-cohort price id and the application
  id in `metadata.tgp_cohort_application_id`. Approval expires if
  the deposit is not paid within `deposit_window_days` (default 7).
- **DEPOSIT_PAID.** Stripe webhook flips the row. The seat is held;
  the cohort capacity counter increments. Coach receives the welcome
  pack (§4.1) and is auto-added to the cohort space (§5.4).
- **CONFIRMED.** The full balance has been paid (T-30 from event by
  default; see §7.4 for the exact invoicing schedule). The seat is
  fully booked and the attendee appears on the venue / ops list.
- **WAITLISTED.** Cohort is at cap; we hold the application and
  promote when a seat frees. Waitlist promotion happens FIFO unless
  OWNER overrides, with audit.
- **REJECTED / WITHDRAWN.** Terminal states. A rejected applicant
  may re-apply for a future cohort; the previous decision is
  retained for context but does not auto-bind the next decision.

### 3.2 Application snapshot fields

Captured at application time, stored verbatim on the application
row. These are the fields the events team sees on the screening
view:

- Identity: `user_id`, email, full name, phone (E.164), country.
- Business: niche, current MRR band (one of
  `<2k`, `2k-5k`, `5k-10k`, `10k-20k`, `20k-50k`, `50k+`), client
  count band, team size, years coaching, prior masterminds.
- Fit: 1-paragraph "what would you do if this 10x'd your business",
  1-paragraph "what's blocking you", deal-breakers (dietary,
  accessibility, travel constraints).
- Logistics: travel from city, can-attend dates, partner attending
  (yes/no, name).
- Consent: marketing-photos consent, recording-consent for cohort
  spaces, code-of-conduct acceptance.
- System-attached snapshot: see §3.3.

### 3.3 Auto-attached qualification snapshot

Computed once at SCREENED time, stored as JSON on the application.
Recomputed only on explicit OWNER request. This is intentionally not
live — we do not want the screening view to drift while a reviewer
is mid-decision.

```json
{
  "computed_at": "2026-05-01T12:00:00Z",
  "tier_l1": { "status": "active", "started_at": "..." },
  "saas_age_days": 142,
  "active_client_count": 38,
  "client_30d_active_pct": 0.71,
  "client_lapsed_30d_count": 4,
  "refund_count_lifetime": 0,
  "support_tickets_30d": 2,
  "billing_state": "active",
  "last_failed_payment_at": null,
  "feature_adoption": {
    "messaging_used_30d": true,
    "ai_assistant_used_30d": true,
    "habits_used_30d": false,
    "check_ins_used_30d": true
  }
}
```

The snapshot draws from the `metrics` counter shape and from
`ActivityEvent`. It is **not** a green-light; it is context.

### 3.4 Decision rubric

Events admin records on the application:

- A **band** verdict: `strong_yes`, `yes`, `borderline`, `no`,
  `strong_no`.
- A **reason** free-text.
- Optional: `defer_to_cohort_id` if rerouting to a later cohort.

Borderline verdicts trigger a 15-minute video call (handled outside
the app) before final decision. Strong-no requires a second
reviewer.

---

## 4. IRL event lifecycle

A cohort's lifecycle has five phases; each is a discrete operations
checklist with corresponding software surfaces.

### 4.1 T-90 to T-31: Build-up

- **T-90 day open.** Cohort row created (`cohort` record, §5.3).
  Capacity, venue placeholder, dates, price ids set. Seat count
  starts at 0.
- **Marketing/recruiting.** Outside the app surface — email lists,
  invite drops, founder content.
- **Application intake.** §3.
- **Pre-work pack.** As applications hit DEPOSIT_PAID, attendees
  are auto-enrolled in a `lessons` track flagged for that cohort.
  Pre-work has a completion bar that the events team can see.
- **Logistics intake.** Dietary, accessibility, room sharing
  preferences, T-shirt size, emergency contact. PII-tier; OWNER-only
  read; attendee can edit.

### 4.2 T-30 to T-1: Lock-in

- **Final balance invoice** (§7.4).
- **Travel + venue confirmations** sent (existing notifications
  surface).
- **Attendee app readiness check.** Console flags any attendee
  whose SaaS isn't healthy (past_due, deleted_at scheduled,
  archived). OWNER reviews each flag; either resolves or removes the
  attendee with refund per policy.
- **Roster freeze.** T-7. After roster freeze, additions go to next
  cohort or are OWNER-overrides with audit.

### 4.3 Days T0..T(n): The event

- **Check-in.** Each attendee marked `arrived` by the events admin
  in the cohort console. Check-in writes an `ActivityEvent`
  (`mastermind.attendee_checked_in`) with cohort id and day number.
- **Session attendance.** Per-session attendance is captured per
  day, not per session, in v1. Per-session can come later.
- **In-event content drops.** Each session unlocks the next
  `lessons` module for the cohort.
- **Daily 1:1 / pod assignments.** Stored as cohort-scoped
  schedule rows; not a generic scheduling product.
- **Compliance.** Photo/video consent already collected; on-site
  staff has access to the consent column on the roster.

### 4.4 T+1 to T+30: Implementation sprint

- **30-day sprint** opens automatically T+1. Lives as a structured
  set of `lessons` + `habits` + `check-ins` for the cohort.
- **Accountability pod** assignments persist; pods get a private
  cohort sub-space (§5.4).
- **OWNER / mentor office hours** — schedule rows surfaced in
  console; not built in v1, just placeholder.
- **Daily nudges** wire through the existing nudges/notifications
  modules with a cohort-scoped template id.

### 4.5 T+31 to T+90: Compounding

- **Implementation checklist** is the artifact every attendee
  leaves with. Surfaced in the coach console as the operator plan;
  attached to the cohort and to the user. (§5.6)
- **Adoption metrics** roll up into the OWNER metrics dashboard,
  scoped to the cohort. (§5.8)
- **Re-engagement decision.** At T+90 the events admin reviews
  cohort health and flags candidates for the next tier (L2 → L3).

---

## 5. Product surfaces (spec, no code)

The platform-side product surfaces required to operate the
mastermind program. Each surface lists: shape, owner, route prefix,
auth model, audit surface, dependencies. **None of this lands in
this PR.** It is the contract every implementation PR resolves
against.

### 5.1 Surface inventory

| Surface | Section | New? | OWNER-visible | Coach-visible | Mobile-visible |
|---|---|---|---|---|---|
| Mastermind tier on the user | §5.2 | new | ✅ | ✅ (own) | ✅ (chip) |
| Cohort | §5.3 | new | ✅ | partial (own cohorts) | partial (own cohorts) |
| Cohort application | §5.3 | new | ✅ | partial (own apps) | submit-only |
| Cohort space (community) | §5.4 | extends `community` | ✅ | ✅ (members) | ✅ (members) |
| Curriculum library (L1/L2/L3) | §5.5 | extends `lessons` | ✅ | ✅ (entitled) | ✅ (entitled) |
| Implementation checklist | §5.6 | new | ✅ | ✅ (own) | ✅ (own) |
| Concierge setup tracker | §5.7 | new | ✅ | partial (own) | — |
| Cohort metrics dashboard | §5.8 | extends `metrics` | ✅ | partial (own cohort) | — |
| Branded-instance request | §5.9 | new | ✅ | request-only | — |
| Hiring / team support tracker | §5.10 | new | ✅ | partial (own) | — |
| Marketing-support tracker | §5.11 | new | ✅ | partial (own) | — |
| Event roster export | §5.12 | new | ✅ | — | — |
| Event payment object | §5.13 | extends billing | ✅ | partial (own) | — |
| Operator handoff packet | §5.14 | new | ✅ | view (own) | — |

Auth model conventions: `OWNER` = always; `coach` = own data;
`mobile` = mobile contract (subset of coach).

### 5.2 `mastermind_tier` on the user

A sibling block to the existing `entitlements` shape, attached to
record-level admin endpoints alongside it. Source of truth: a new
`MastermindMembership` table (Phase 2 migration, not in this PR).

```ts
{
  current_tier: 'tier_l1' | 'tier_l2' | 'tier_l3' | 'none',
  alumni: Array<'tier_l1' | 'tier_l2' | 'tier_l3'>,
  active_cohorts: Array<{ cohort_id, role: 'attendee'|'staff', day_index }>,
  upcoming_cohorts: Array<{ cohort_id, status, deposit_paid, full_balance_due_at }>,
  last_event_at: string | null,
  flags: {
    branded_instance: boolean,
    concierge_setup_complete: boolean,
    priority_support: boolean,
  }
}
```

**Why not introduce a new role.** Roles are
`OWNER`, `COACH`, `STUDENT`. Tier is *what* a coach is on, not *who*
they are. Reusing the role hierarchy for tier would explode the auth
matrix; a sibling block is the smaller change.

**Display rules.**
- `current_tier=none` and `alumni=[]` → no chip.
- `current_tier=l3` and `alumni includes l2` → render `L3` chip,
  hover shows L2 alumni.
- Console uses `mastermind_tier` only for chip + filter; gating
  decisions still flow through `entitlements` for SaaS access and
  through `MastermindMembership` for cohort-scoped access.

### 5.3 Cohort + application

**Cohort row** — created by OWNER. Fields:

- `id` (slug, e.g. `l3-2026q3-malibu`)
- `tier` (`tier_l2` | `tier_l3`)
- `display_title`, `subtitle`
- `start_at`, `end_at`, `tz`, `venue_name`, `venue_addr`,
  `city`, `country`
- `seat_capacity`, `waitlist_capacity`
- `deposit_price_id`, `balance_price_id`, `currency`
- `deposit_amount_cents`, `balance_amount_cents`
- `deposit_window_days`, `refund_cutoff_at`
- `status` (`drafting`, `open`, `closed`, `running`,
  `wrap_up`, `archived`)
- `application_form_version`
- `created_by`, `published_at`, `archived_at`
- `notes` (private OWNER-only)

**Application row** — created on coach action. Fields:

- `id`, `user_id`, `cohort_id`
- `state` (see §3.1)
- `applied_at`, `screened_at`, `decided_at`, `decided_by`
- `band`, `reviewer_notes`
- `application_payload` (the structured form; §3.2)
- `qualification_snapshot` (§3.3)
- `deposit_invoice_id`, `balance_invoice_id`
- `withdrawn_reason`
- `linked_audit_log_ids` (list of `AuditLog.id`)

Routes (planned, not yet implemented):
- `POST /api/cohorts/:id/applications` (coach)
- `GET /api/cohorts/:id/applications/me` (coach)
- `GET /api/admin/cohorts` / `:id` / `:id/applications` (OWNER)
- `POST /api/admin/cohorts` (OWNER)
- `POST /api/admin/cohorts/:id/applications/:appId/screen` (OWNER)
- `POST /api/admin/cohorts/:id/applications/:appId/decision` (OWNER)
- `POST /api/admin/cohorts/:id/applications/:appId/issue-deposit-invoice` (OWNER)

Audit: every state transition writes an `AuditLog` row whose action
is `cohort.application.<from>_to_<to>` and whose metadata captures
`cohort_id`, `application_id`, `band`, `decided_by`. The OWNER
audit-log read surface already exists.

### 5.4 Cohort space (community extension)

Reuse `community.controller.ts` patterns with a cohort-scoped
sub-resource. New shape, no rebuild:

- A `community_space` row keyed by `(scope='cohort', scope_id=cohort_id)`.
- Members are application records in `DEPOSIT_PAID` or `CONFIRMED`
  state, plus OWNER + assigned mentor + assigned events admin.
- Pods are sub-spaces inside the cohort space, scope
  `pod:<cohort_id>:<pod_id>`. Pod membership is OWNER-managed.
- Read-only modes: lapsed L2/L3 retain read access for 30 days post
  lapse, then read-only-archived.
- Posting is rate-limited per the existing throttler.

### 5.5 Curriculum library (lessons extension)

Reuse `lessons.controller.ts`. New `tier` and `cohort_scope` fields
on lesson modules:

- `tier` ∈ `{ tier_l1, tier_l2, tier_l3 }` — gates by membership.
- `cohort_scope` optional — when set, the module is private to a
  specific cohort (used for pre-work and event-day session unlocks).
- `release_at` — when the module flips visible. Daily drips
  during the event use this.

Existing `LessonCompletion` row carries through; cohort-scoped
modules show in the cohort metrics dashboard (§5.8).

### 5.6 Implementation checklist (operator plan)

A new surface attached to the user *and* the cohort.

```ts
{
  user_id,
  source_cohort_id,
  template_version,
  items: [
    {
      id, title, category,
      target_at, completed_at?, evidence_url?,
      requires: 'self_attest'|'console_action'|'metric_threshold',
      status: 'todo'|'in_progress'|'done'|'blocked',
      blocker_note?
    }
  ],
  generated_at,
  last_reviewed_at
}
```

Three categories of item:
- **self_attest** — coach ticks the box.
- **console_action** — gated on a real action in the console
  (e.g., "send your first templated welcome message" — verified by
  an `ActivityEvent`).
- **metric_threshold** — gated on a counter (e.g.,
  "30 active clients").

Surfaces in the coach console as "My Operator Plan." Surfaces in
the OWNER cohort dashboard as a stacked completion chart per cohort.

### 5.7 Concierge setup tracker

L3-only by default. Owned by the events team (mapped to OWNER for
auth in v1). A linear checklist that tracks the white-glove setup
work:

```
[ ] kickoff call scheduled
[ ] niche & offer page reviewed
[ ] Stripe configured & test charge
[ ] welcome message templates installed
[ ] first 10 clients imported / invited
[ ] AI assistant guidelines populated
[ ] first 30-day check-in cadence set
[ ] first nudge campaign live
[ ] handoff sign-off
```

Each row references either an action in the coach console or an
external task. Concierge completion sets
`mastermind_tier.flags.concierge_setup_complete = true` on the
attached user record.

### 5.8 Cohort metrics dashboard (metrics extension)

Extend the existing OWNER-only `/api/admin/metrics` with a
cohort-scoped variant: `/api/admin/cohorts/:id/metrics`. Counters:

- `applications_received`, `_screened`, `_approved`, `_rejected`,
  `_waitlisted`, `_withdrawn`
- `seats_filled`, `seats_capped`, `waitlist_depth`
- `deposit_paid_count`, `balance_paid_count`,
  `refund_issued_count`, `refund_amount_cents`
- `attendance_day_1_count` … `attendance_day_n_count`
- `pre_work_completion_pct`, `post_event_sprint_completion_pct`
- `attendees_l1_active_at_t_minus_30`, `_at_t_plus_30`,
  `_at_t_plus_90`
- `attendees_lapsed_post_event_count`
- `nps_score`, `nps_response_count`

Adoption-loop counters from existing metrics
(`messaging_used`, `ai_used`, `check_ins_completed`,
`habits_logged`, `lessons_completed`) gain a cohort dimension when
the user is a cohort member.

### 5.9 Branded-instance request (white-glove path roadmap)

L3-only. A request is an artifact, not a build. Fields:

```ts
{
  user_id, cohort_id, requested_at,
  brand_name, brand_color, brand_logo_url,
  custom_domain_request,
  scope_requested: ['mobile_app'?, 'coach_console'?, 'invite_landing'?, 'emails'?],
  ops_estimate_status: 'unestimated'|'estimated',
  ops_estimate_weeks?: number,
  decision: 'pending'|'committed'|'rejected'|'deferred',
  decision_notes?
}
```

The request goes into a backlog visible to OWNER; nothing self-
serves. The point in v1 is to *capture demand* without committing.
v1 of branded instance is web-console + email theming only;
per-event mobile builds explicitly stay out.

### 5.10 Hiring / team support tracker

L2/L3 deliverable. Tracks the coach's hiring pipeline as a roadmap
item, not a recruiting tool. Fields:

- `role_target` (e.g., "client success", "content manager", "second
  coach")
- `target_start_at`
- `interview_pipeline_stage`
- `tools_set_up` (JD posted, ATS, contract template, payroll set up)
- `attached_lessons` (curriculum modules unlocked)
- `mentor_review_at`

We do not run interviews. We hand the coach the playbook and the
cadence and capture progress for the cohort metrics dashboard.

### 5.11 Marketing support tracker

Same shape as §5.10 for marketing assets:

- `current_funnel_stage`
- `attached_assets` (landing page draft, email sequence draft, ad
  set draft) — pointers, not stored content
- `next_review_at`
- `mentor_owner`

### 5.12 Event roster export

OWNER-only export endpoint
(`GET /api/admin/cohorts/:id/roster.csv`) returning the venue/ops
list: name, email (when consent allows), phone, dietary,
accessibility, T-shirt size, room-pref, photo-consent flag.
Audit-logged. Row count and column set are documented in the
runbook (§13.1).

### 5.13 Event payment object (billing extension)

Mirror events into the existing billing surface without disturbing
the recurring SaaS surface.

- `EventInvoice` row mirrored from Stripe with
  `kind in ('event_deposit','event_balance','event_addon','event_refund')`
  and `cohort_id`, `application_id` in metadata.
- `event_invoice` is **never** read by `SubscriptionGuard`. SaaS
  access continues to flow only from `CoachSubscription`.
- A coach-visible "My Events" billing tab lists their event
  invoices alongside the existing subscription invoices, clearly
  segmented.
- Refunds write an `AuditLog` row referencing the application id
  and cohort id.

### 5.14 Operator handoff packet

A serialised export of one coach's operator state at a moment in
time, for OWNER-to-events-team handoff or for a coach who needs a
single artifact to reference. Bundle:

- `mastermind_tier` snapshot
- Implementation checklist (§5.6) state
- Concierge tracker (§5.7) state
- Hiring / marketing trackers (§5.10, §5.11)
- Last 90 days of `ActivityEvent` summary
- Last 90 days of cohort dashboard slice
- Subscription mirror summary

Format: JSON + a generated PDF. OWNER-only export, audit-logged.

---

## 6. Curriculum spec

The curriculum is what the coach actually *learns*. The platform
delivers it through `lessons` + `community` + `nudges`. Specified
here so the events team and the mentor can build the modules without
reinventing the structure.

### 6.1 L1 — SaaS-native foundations (always available)

Free with subscription. No event. Roughly 10 modules.

1. Why a coaching business is an asset, not a job
2. Niche, ICP, transformation
3. Setting up the SaaS — pre-templated checklist
4. Your first 10 clients (referral + audit + invite-link mechanics)
5. Setting up Stripe + pricing
6. Onboarding cadence and the welcome message system
7. Check-in rhythm and adherence loops
8. The retention conversation
9. The cancellation conversation
10. The first review milestone

### 6.2 L2 — Operator School (3-day workshop + 12-week curriculum)

Pre-work (4 modules):
- Your numbers — MRR, ARPC, churn, refunds, CAC
- Brand voice exercise
- Existing-client audit — who pays you and why
- Founding-offer rewrite

Event days (3):
- **Day 1: The operating system.** Niche, offer, pricing tiers,
  first 90-day client journey. Working session: rewrite your offer.
- **Day 2: The marketing engine.** Content cadence, funnel, ad
  basics, partnerships, referrals, lead capture. Working session:
  publish 1 thing live.
- **Day 3: The retention engine.** Check-in cadence, AI assistant
  usage, content library, win-stream, churn diagnostics. Working
  session: install the cadence in your console.

Post-event sprint (12 weeks of weekly modules):
- W1–W4: install offer, pricing, first 30 days of cadence
- W5–W8: install marketing engine, run first ad / first partner
  drop / first content series
- W9–W12: hire-or-not decision, first VA, first SOPs

### 6.3 L3 — Mastermind (4-day flagship + monthly + 1:1)

Pre-work (6 modules):
- Updated numbers (MRR, churn, CAC, payback, gross margin)
- Org chart (current + 12-month target)
- 12-month plan
- Brand audit
- Top 5 clients and why
- Pre-flight call with mentor (45 min)

Event days (4):
- **Day 1: The business as an asset.** Strategic positioning,
  category, moat. Mentor-led teardowns.
- **Day 2: People.** First hire, second hire, second coach, manager.
  Salary bands, equity, contractor-vs-employee, comp design.
- **Day 3: Brand + distribution.** Long-form content, owned media,
  partner cohorts, second product line, geography expansion.
- **Day 4: Capital.** Pricing the business, owner pay, taxes,
  retirement, exit options, partner buyout. Integration day —
  attendees write their 12-month plan.

Cadence after the event:
- Monthly virtual half-day (mentor-led, themed)
- Quarterly 1:1 with OWNER or designated mentor
- Twice-a-year flagship in-person
- Always-on cohort space

### 6.4 Coach business operating system (the through-line)

Independent of tier, the curriculum teaches one operating system,
labelled "the coach OS" internally:

1. **Decide.** What the business is, who it serves, what it costs.
2. **Set up.** Console, Stripe, templates, AI guidelines, first
   nudge.
3. **Acquire.** Invite link, referrals, partnerships, content, ads.
4. **Onboard.** Welcome cadence, first check-in, first goal.
5. **Retain.** Cadence, content, AI assistant, win stream, audits.
6. **Operate.** Numbers review, support tickets, churn diagnostics.
7. **Scale.** Hire, SOP, second coach, second product, brand.

The curriculum modules in §6.1–§6.3 attach to one of these seven
stages. The implementation checklist (§5.6) inherits the same
seven categories so the coach sees one mental model end to end.

### 6.5 Revenue / ops workshop spec

Run twice in each L2 (Day 1 morning + Day 3 afternoon) and three
times in each L3 (Day 1, Day 3 morning, Day 4 morning).

Workshop unit:
- 90 minutes
- 15 min teach, 45 min build, 30 min review
- Each attendee leaves the room with the artifact entered in the
  console

Mandatory artifacts captured in the console:
- Pricing page draft (lessons module)
- 30-day cadence (check-ins + habits + nudges template applied)
- Welcome message set (`MessageDraft` rows)
- First-month review template

### 6.6 Implementation sprint spec (T+1 to T+30)

A 30-day sprint runs immediately after every L2 / L3 event.
Components:

- 1 daily nudge (cohort-templated)
- 1 weekly 60-min cohort call (live, recorded into the cohort
  community space)
- 1 weekly check-in with pod members
- The implementation checklist (§5.6) progress bar in the console
- Mentor pings on-block items at the end of each week

### 6.7 Accountability pod spec

Pods = 4–6 attendees per cohort. Same pod for the duration of the
program. Pod gets:

- A private sub-space in the cohort community
- A weekly 60-min call (member-run, lightweight agenda template)
- A shared "win" stream wired into the existing community wins
- Optional pod-internal challenge templates from the existing
  challenge surfaces

---

## 7. Commercial model

### 7.1 SKUs

| SKU id | Tier | Cadence | Price band (USD) | Stripe price kind |
|---|---|---|---|---|
| `saas_l1_monthly` | L1 | monthly | existing | recurring |
| `saas_l1_annual` (future) | L1 | annual | TBD | recurring |
| `mastermind_l2_deposit` | L2 | per cohort | ~$4.95k | one_time |
| `mastermind_l2_balance` | L2 | per cohort | ~$10k | one_time |
| `mastermind_l3_deposit` | L3 | per cohort | ~$10k | one_time |
| `mastermind_l3_balance` | L3 | per cohort | ~$20–25k | one_time |
| `mastermind_addon_partner_seat` | L2/L3 | per cohort | 50% of full | one_time |
| `mastermind_addon_concierge_extra` | L3 | per coach | TBD | one_time |
| `flagship_annual_ticket` | flagship | per event | ~$5k–$10k | one_time |

L2 / L3 totals are reached via deposit + balance, not as a single
checkout. This:

- protects cash flow (deposit at approval, balance at T-30)
- gives a clean refund cutoff
- keeps Stripe Tax line items simple
- never blocks SaaS subscription writes regardless of event balance
  state

### 7.2 Margin posture

Working assumption (illustrative, not a commitment):
- L2 cohort target: 25 seats × $15k = $375k revenue
- L2 venue + travel + ops + materials: ~$60k
- L2 mentor + speaker + delivery: ~$45k
- L2 net before founder time: ~$270k
- L2 contribution to platform development: 100% of net (Phase 1)

L3 multipliers are higher because of mentor + venue. We model L3 at
~50% gross margin and accept that.

### 7.3 Discounts and comps

- **Founding cohort comp.** First L2 / L3 cohort can have up to 30%
  comped seats at OWNER discretion; comps are full-experience seats
  and write the same `cohort_application` rows; the deposit/balance
  invoices are issued at $0.
- **Partner seats.** A second seat at 50% off for a partner /
  co-founder. Both seats are full attendees.
- **Alumni reactivation.** L3 alumni returning to the next L3
  receive 25% off the deposit.
- **Public discount codes.** Not supported in v1. The application
  is the gate.

### 7.4 Refunds, cutoffs, and authority

- **Deposit refund window.** 14 days from deposit payment, or T-60,
  whichever is sooner.
- **Balance refund window.** Up to T-30 (pre-balance-invoice). After
  that, the balance is non-refundable; deposit is non-refundable.
- **Transfer to next cohort.** Allowed once per attendee per tier
  with no fee, up to T-30. After T-30 it's at OWNER discretion.
- **Force-majeure refund.** OWNER may approve a full refund for
  serious illness, bereavement, etc. Audited.
- **Refund authority.** OWNER only. Every refund writes an
  `AuditLog` row.
- **Tax.** Stripe Tax for US sales tax + EU VAT MOSS. Prices stated
  exclusive in marketing surfaces unless local law forces inclusive.

### 7.5 Revenue recognition

- L1 SaaS: recognised over the subscription period (no change).
- L2/L3 deposit: recognised at the event start date (deferred until
  then).
- L2/L3 balance: recognised at the event start date.
- 12-week post-event sprint: revenue is part of the event price; we
  do not split rev rec across the sprint.

### 7.6 Bookings vs revenue

OWNER metrics dashboard distinguishes:
- **Bookings** = cohort dollars committed (deposit + balance amount,
  net of refunds), recognised when invoiced.
- **Revenue** = cohort dollars earned, recognised at event-start.
- **Cash** = stripe-mirrored payments received this month.

Surface the three separately so we don't confuse a strong-quarter
bookings number for revenue.

---

## 8. Marketing + recruiting spec

In-app surfaces only; brand marketing is outside this repo.

- A **/me/upgrade-to-l2** placeholder route in the coach console
  surfacing the L2 pitch, calendar of cohorts, and the application
  CTA.
- A **/me/upgrade-to-l3** placeholder, gated on `tier_l2` alumni or
  active.
- A **post-event share kit** surfaced in the cohort space: photo
  pack, quotes, a one-pager attendees can post.
- A **referral mechanism** — a coach who refers a paying L2/L3
  attendee gets a 10% discount on their next renewal (existing SaaS
  renewal discount mechanic, reused).
- An **invite-only segment** for the OWNER-curated invite list to L3.

The marketing site (`new-website`) is intentionally **not** modified
by this PR; that surface owns its own funnel and links into these
backend-served upgrade routes.

---

## 9. White-glove branded-instance path

**Status: roadmap, not v1.**

L3-only flag. A branded instance means the coach's clients see the
console + emails + invite landing under the coach's brand, on a
custom domain. It does **not** mean a separate database or a
separate deploy.

Phase 9.A (request capture only — Phase 1 of this spec):
- L3 attendees can submit a branded-instance request (§5.9)
- OWNER reviews and queues
- No actual theming ships

Phase 9.B (theming layer — Phase 2 of this spec):
- Email templates accept brand tokens (logo, color, brand name)
- Coach console accepts a brand-scoped theme via a per-coach config
- Invite landing accepts the same brand tokens
- A custom-domain CNAME mapping is supported via the existing
  `PUBLIC_INVITE_BASE_URL`-style variable, made per-coach

Phase 9.C (deeper isolation — Phase 3, big lift, only if customer
demand justifies it):
- Per-tenant CoachSubscription enforcement boundary
- Per-tenant Sentry / PostHog projects
- Per-tenant audit log scoping
- Per-tenant export & GDPR contracts

We do **not** build a separate mobile app per coach in v1 of any
phase. The mobile app stays unbranded for app-store reasons; the
client-side branding is on the web + email surfaces only.

Compliance surface is unchanged: GDPR, audit, account lifecycle, and
the `entitlements` shape continue to be scoped to `User`.

---

## 10. Hiring + team support

Mastermind deliverable, not a recruiting product. Spec lives in
§5.10. Curriculum side: §6.4 stage 7 (Scale).

Lever points the program teaches:
- First VA in 30 days (L2)
- First client-success role in 90 days (L2 → L3)
- Second coach in 6–9 months (L3)
- Manager / director role in year 2+ (L3 alumni)

What the platform does:
- Tracks the role pipeline as state on the user.
- Unlocks the relevant `lessons` modules per stage.
- Surfaces it in the coach's operator plan and in the cohort
  dashboard so the mentor sees who's stuck.
- Does **not** run job postings, ATS, payroll, or contract
  signature. Those go to existing tools.

---

## 11. Post-event software adoption loop

The whole program is structurally designed so the IRL day amplifies
*platform usage*, not the reverse. Every event session terminates in
an action that lives inside the existing modules:

| Session → | leaves behind |
|---|---|
| Niche / offer | a published offer module entry |
| Welcome cadence | populated `MessageDraft` rows |
| Check-in rhythm | scheduled `check-ins` |
| Habits | populated `habits` |
| AI assistant | filled-in coach guidelines (`CoachGuideline`) |
| Content engine | first lesson published |
| Marketing engine | first nudge campaign live |
| Hiring | role-pipeline tracker filled |

The **adoption metric loop** measures, per cohort:
- T-7 vs T+30: did each module's usage increase?
- Per-attendee scorecard: which of the 7 stages are "in motion"?
- Cohort heatmap: which sessions actually drove adoption?

If a session does not drive adoption, the curriculum re-prioritises
or rewrites it. This is the feedback loop that turns a $30k mentor
day into a recurring data signal.

---

## 12. Compliance and risk

### 12.1 Data + privacy

- **PII surface area expands** to include phone, dietary,
  accessibility, room-share, emergency contact, photo consent,
  recording consent. All OWNER-only; coach can read/edit own.
- **GDPR scrub** semantics extend: an attendee's
  `cohort_application`, `EventInvoice`, and roster row are
  PII-scrubbed at the same time as the user (§ existing GDPR
  process). Cohort historical aggregates remain (numbers only).
- **Photo / video consent** — captured at application; written into
  the roster CSV; the events team must filter on it before any post-
  event share. Required field in the events runbook.
- **Recording consent** — capturing audio of the cohort space and
  in-person sessions requires explicit opt-in at application; opt-
  out attendees are excluded from the recordings. Logistically
  enforced; not a software gate in v1.

### 12.2 Operational risk

- **Event cancellation.** Force-majeure clause in T&C. Refund per
  §7.4. Operator runbook (§13.2) covers comms, refunds, rescheduling.
- **Attendee misconduct.** Code-of-conduct accepted at application.
  OWNER may eject an attendee mid-event with no refund; AuditLog
  row mandatory.
- **Mentor unavailability.** Quarterly check on mentor coverage;
  fallback mentor list maintained outside the app.
- **Capacity overrun.** OWNER may override seat cap with audit;
  hard cap is the venue's stated max minus 10% buffer.

### 12.3 Financial risk

- **Refund liability.** Carry deposit + balance as deferred revenue
  until event-start. Track refund liability separately; do not net
  against revenue.
- **Chargeback.** Treat any event chargeback the same as the
  existing Stripe `payment_failed` flow; an event chargeback does
  *not* affect SaaS subscription state.
- **Currency.** USD is canonical. Other currencies set via Stripe;
  bank conversion runs at Stripe's rate; we do not promise a fixed
  rate.

### 12.4 Regulatory

- **FTC endorsement guidelines.** Earnings claims published in
  marketing must come with disclaimers; the operator runbook (§13.3)
  documents the approved phrasing.
- **EU VAT.** Stripe Tax handles MOSS. Operator quarterly check.
- **Health claims.** L1 fitness coaching curriculum stays inside
  the existing posture (no medical claims). Keep this in cohort
  briefings.

---

## 13. Operator runbooks (placeholders)

These runbooks land as separate docs once the surfaces in §5 are
implemented. Listed here so reviewers can see the operations surface
the program implies.

### 13.1 Cohort operations runbook

- Open a cohort (owner action checklist)
- Roster freeze + ops-list export
- Day-of check-in process
- Daily attendance review
- Post-event close-out (sprint open, dashboard review, T+90 review)
- Roster CSV column reference (§5.12)

### 13.2 Cohort cancellation / rescheduling runbook

- Force-majeure declaration steps
- Comms templates (existing notifications / emails surfaces)
- Refund batch process (Stripe + AuditLog)
- Reschedule to next cohort transfer process

### 13.3 Marketing / earnings claims runbook

- What can be said publicly (income disclaimers, % outcomes)
- Approved testimonials and the consent ledger
- Photo / video usage guardrails

### 13.4 Refund + dispute runbook

- Refund decision tree
- Stripe refund workflow + AuditLog requirements
- Chargeback handling (Stripe dispute response template)
- Communication to coach (templated)

### 13.5 Branded-instance request triage runbook

- Backlog review cadence
- Estimation worksheet
- Decision communication
- Customer expectation setting

### 13.6 Attendee misconduct + ejection runbook

- Code-of-conduct reference
- Decision authority (OWNER + 1 reviewer)
- Communication templates
- Refund posture (none by default)
- Audit + community space removal

### 13.7 Operator handoff runbook

- When to package a handoff packet (§5.14)
- What goes in / what's redacted
- Receiving-side checklist
- Audit + retention policy

---

## 14. Phasing + decision log

### 14.1 Phase 1 — this spec only (now)

- Spec doc lands (this PR).
- No schema, no code, no flag.
- Events team can run a Founding Cohort manually (Phase 0 in §0.1)
  using the existing platform plus spreadsheets.

### 14.2 Phase 2 — minimum viable cohort surface

- `cohort` + `cohort_application` schema
- OWNER admin endpoints for cohort + application CRUD
- Stripe `EventInvoice` mirror with `cohort_id` metadata
- `mastermind_tier` block on admin endpoints
- Cohort space in `community` (read-only at first)
- Pre-work module support in `lessons`
- AuditLog actions for the whole application state machine
- Operator runbook §13.1 published
- Smoke + e2e additions

Acceptance: a real Beta cohort can be operated end-to-end from the
console without spreadsheets.

### 14.3 Phase 3 — implementation sprint + dashboard

- Implementation checklist surface (§5.6)
- Cohort metrics dashboard (§5.8)
- Concierge tracker (§5.7)
- Post-event sprint automations
- Operator handoff packet (§5.14)
- Runbooks §13.2, §13.4, §13.7 published

Acceptance: an L2 cohort runs end-to-end with no spreadsheet work,
and we can ship an L3 cohort in the same shape.

### 14.4 Phase 4 — branded instance + scale

- Branded-instance theming (§9 phase 9.B)
- Hiring + marketing trackers (§5.10, §5.11)
- Flagship event SKU
- International pricing + tax review

### 14.5 Decisions captured

- L2/L3 are bundle modifiers, not roles. (§5.2)
- Event invoices never gate SaaS access. (§5.13, §7.4)
- Alumni status is permanent; live curriculum access requires
  active subscription. (§2.3)
- Mobile remains unbranded across all branded-instance phases. (§9)
- Refund authority is OWNER-only with audit. (§7.4)
- Cohort capacity overrides require OWNER + audit. (§4.3)
- Per-event mobile builds are out of scope indefinitely. (§9)
- We do not become an event-management or LMS product. (§1.2)

### 14.6 Open questions for the next review

- Annual L1 SKU pricing — defer until L2 is running.
- Family / partner cohort pricing for L3 (§7.3) — confirm before
  first L3.
- Whether the flagship annual is open to non-paying coaches (with a
  ticket price) or remains alumni-only — likely hybrid; confirm
  before promoting.
- Whether the recording of cohort sessions becomes part of the
  L1/L2 curriculum after a cohort wraps — default no for the first
  3 cohorts so attendees pay for live-only-access.
- Whether post-event sprint opens to non-attendees as a paid
  product — explicitly **no** in Phase 1; revisit post-Phase 4.

---

## Appendix A — surface-to-module mapping

For implementation PR authors. Each surface in §5 lands closest to
the existing module that owns the relevant pattern.

| Surface | Closest existing module | Touch type |
|---|---|---|
| `mastermind_tier` block | `src/admin/entitlements/` | sibling type, new service |
| Cohort + application | new `src/masterminds/` module | new module |
| Cohort space | `src/community/` | extends |
| Curriculum library | `src/lessons/` | extends with `tier`, `cohort_scope` |
| Implementation checklist | new sub-module under `src/masterminds/` | new |
| Concierge tracker | new sub-module under `src/masterminds/` | new |
| Cohort metrics | `src/analytics/`, `src/admin/` | extends |
| Branded-instance request | new sub-module under `src/masterminds/` | new |
| Hiring/marketing trackers | new sub-module under `src/masterminds/` | new |
| Roster export | `src/admin/` | extends |
| Event payment object | `src/billing/` | extends mirror |
| Operator handoff packet | `src/admin/` | new endpoint |

## Appendix B — naming + ids

- Cohort id: `<tier>-<yyyy>q<n>-<city-slug>`, e.g.
  `l3-2026q3-malibu`.
- Application id: `coh_<cohort_id>_<short_user_hash>`, deterministic.
- Pod id: `pod_<cohort_id>_<n>`.
- Event invoice metadata: `tgp_kind`, `tgp_cohort_id`,
  `tgp_application_id`.
- AuditLog actions:
  `cohort.created`,
  `cohort.published`,
  `cohort.application.submitted`,
  `cohort.application.screened`,
  `cohort.application.approved`,
  `cohort.application.rejected`,
  `cohort.application.waitlisted`,
  `cohort.application.withdrawn`,
  `cohort.application.deposit_invoice_issued`,
  `cohort.application.deposit_paid`,
  `cohort.application.balance_invoice_issued`,
  `cohort.application.balance_paid`,
  `cohort.application.refund_issued`,
  `cohort.attendee.checked_in`,
  `cohort.attendee.removed`,
  `cohort.attendee.transferred`,
  `cohort.branded_instance.requested`,
  `cohort.branded_instance.decision`.

## Appendix C — what does **not** change

- Existing roles (`OWNER`, `COACH`, `STUDENT`).
- Existing `CoachSubscription` shape and the `BILLING_ENFORCEMENT`
  flag.
- Existing entitlements read shape and the
  `fitness_only`/`finance_only`/`performance_os` bundle.
- Stripe webhook idempotency and the `StripeProcessedEvent` table.
- AuditLog append-only convention.
- GDPR scrub policy and the `deletion_scheduled_at` grace window.
- Smoke contract (`scripts/smoke.ts`).
- The mobile app contract.
- The coach-console BFF contract (`src/v1/`).
- The marketing site (`new-website`, intentionally untouched).
