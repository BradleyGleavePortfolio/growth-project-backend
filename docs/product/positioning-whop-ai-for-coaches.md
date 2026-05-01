# Positioning — Whop AI for coaches

Status: **draft, docs-only**. Companion to
[`README.md`](./README.md). Locks the brand frame the rest of Wave 2
depends on. Every spec in this directory inherits the four-archetype
model and the AI roadmap defined here.

This file does not authorize any marketing copy on `new-website`. It
is the internal product positioning the engineering, support, and
admin-console surfaces are aligned against.

---

## 1. The frame

The Growth Project is **Whop AI for coaches** — a platform where a
single operator (the head coach, the gym owner, the influencer, the
info-seller) runs a coaching business that scales beyond what a single
human could deliver, with sub-coaches doing the per-client work and AI
doing the operational work the head coach used to do alone.

Two halves of the frame matter equally:

- **Whop angle.** A single command surface for storefronts, offers,
  payments (Stripe Connect / MoR), affiliates, and community — the
  one-stop-shop a coaching operator otherwise stitches together from
  Stripe, Calendly, Skool, Trainerize, Loom, and a Notion dashboard.
  The commerce layer is owned by PR #125 (`docs/architecture/expansion
  -roadmap-addendum-commerce.md`); Wave 2 does not respec it.
- **AI angle.** What turns Whop-for-coaches into *Whop AI* is not a
  chat widget. It is the AI weekly recap, the AI at-risk client
  detector, the AI program builder, the AI check-in summarizer, and
  the AI coaching copilot that sits behind every coach action and
  removes the manual rollup work that kills coach margin past 30
  clients. §6 spells out the four-phase AI roadmap.

The "with sub-coach hierarchy" suffix is not optional. It is the
single feature that makes the platform usable past 30 clients per head
coach and is the reason gyms and influencers can adopt the platform at
all. The schema and RBAC for it are in
[`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md).

### 1.1 What we are not

We are not a fitness app. We are not a community platform. We are not
a CRM. We are not a course platform. We are a **coaching operating
system** — the layer underneath those, where the head coach runs the
business and the sub-coaches run the clients.

The corollary: a "free tier consumer-grade fitness tracker" is not on
the roadmap. The CEO doctrine is *right-fit member, not buyer* —
clients are admitted by a coach, not by a marketing funnel. This is
the constraint that makes the progression system in
[`retention-progression-system.md`](./retention-progression-system.md)
shape the way it does (outcome-based, not tenure-based).

---

## 2. The four buyer archetypes

Each archetype is a real persona the platform is sold to. They share
the same underlying schema, RBAC, and admin surface; they differ in
**defaults**, **expected ARPU**, **expected sub-coach count**, and
**expected client count**. Onboarding ([`onboarding-coaches.md`](./onboarding-coaches.md))
branches on archetype to pre-fill the first program template, the
default offer pricing, and the suggested invite-link copy.

The archetype is a column on `CoachOrganization` (see
[`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §3). It is set
at organization creation and is editable by OWNER from the admin
console only — not by the coach themselves — to prevent
self-reclassification gaming the default rules.

### 2.1 Solo trainer

| Property | Value |
|---|---|
| Description | An independent personal trainer or nutrition coach with their own client roster, no employees. |
| Typical client count | 0–50 |
| Typical sub-coach count | 0 (organization is just the head coach) |
| Default tier on signup | L1 (per [`../entitlements.md`](../entitlements.md)) |
| Expected ARPU | One platform seat per head coach. No internal billing split. Stripe subscription on the head coach. |
| Default first program template | "Foundation strength" — 8 weeks, 3 sessions/week, intermediate progression. Source: existing `src/workout/` seed routines. |
| Default offer pricing | Monthly recurring, single tier, paid via the head coach's storefront (PR #125). |
| Default invite-link copy | "Join my coaching" — no sub-coach branding. |
| Onboarding telemetry weighting | Heavy emphasis on time-to-first-client (see [`onboarding-coaches.md`](./onboarding-coaches.md) §4). |

### 2.2 Gym

| Property | Value |
|---|---|
| Description | A physical-location operator (single location or a small chain) with multiple trainers as sub-coaches. The gym owner is the head coach; the trainers are sub-coaches. |
| Typical client count | 100–1000 |
| Typical sub-coach count | 3–20 |
| Default tier on signup | L2 (the gym buys the higher seat tier; sub-coaches inherit entitlements from the org per [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §6). |
| Expected ARPU | One platform seat at gym tier + per-sub-coach add-on (Flow A) **or** an internal-split arrangement (Flow B). Default at signup: Flow A. Switching is OWNER-initiated only. |
| Default first program template | "12-week strength + conditioning block" — 4 sessions/week, with a sub-coach-assignable variant. |
| Default offer pricing | Monthly recurring at a per-location rate, with a multi-month discount. Stripe Connect destination is the gym's account. |
| Default invite-link copy | "Join {GymName}" — sub-coach name appended after assignment. |
| Onboarding telemetry weighting | Time-to-first-sub-coach-invited as the primary metric, time-to-first-client secondary. |

### 2.3 Influencer

| Property | Value |
|---|---|
| Description | A creator with a large public audience monetizing through one or more coaching offers, typically with a small sub-coach team handling per-client delivery. |
| Typical client count | 200–5000 |
| Typical sub-coach count | 2–10 |
| Default tier on signup | L2, with an upsell path to L3 around the 200-client mark. |
| Expected ARPU | One platform seat at influencer tier + per-client overage above a tier-defined ceiling. Flow B (internal split) is the typical billing arrangement so the influencer brand owns the customer relationship. |
| Default first program template | "Body recomposition starter" — 4 weeks, optimized for high-conversion first-program completion. |
| Default offer pricing | Tiered (entry / standard / premium), each with its own Stripe price; the highest tier includes 1:1 sub-coach time. |
| Default invite-link copy | Bare brand handle — invites flow from the public storefront, not from a coach-specific link. |
| Onboarding telemetry weighting | Time-to-first-storefront-published. Storefront is the funnel; sub-coaches and clients arrive after. |

### 2.4 Info-seller / coach

| Property | Value |
|---|---|
| Description | An established information-product operator (a course, a paid newsletter, a mastermind) wanting to extend a transactional course relationship into a recurring coaching relationship. |
| Typical client count | 100–2000 |
| Typical sub-coach count | 0–5 |
| Default tier on signup | L2. |
| Expected ARPU | Mixed — recurring coaching subscription on the head coach plus a typically-larger one-time course revenue stream the platform does not bill. |
| Default first program template | "Accountability container" — 4 weeks of structured habit and check-in cadence rather than a strength block; the course covers the content, the platform covers the accountability. |
| Default offer pricing | Recurring at a fraction of the course price (e.g. course $1500 one-time, coaching $150/month). |
| Default invite-link copy | "Continue with {CoachName} after {CourseName}" — invite-link copy is the cross-sell. |
| Onboarding telemetry weighting | Time-to-first-course-graduate-converted. The conversion event is the cross-sell from course to coaching. |

### 2.5 Archetype-aware defaults — implementation notes

Archetype is read by:

- **Coach onboarding** ([`onboarding-coaches.md`](./onboarding-coaches.md))
  to choose the program template, offer scaffold, and invite copy.
- **Admin console Coaches table** (`docs/admin/control-room-spec.md` §4)
  to render an archetype chip.
- **Admin metrics rollups** (`docs/metrics.md`) for archetype cohort
  breakdowns under `?archetype=...`.
- **Pricing logic** (PR #125 commerce wave) for the per-archetype tier
  ceiling at sign-up.
- **Progression system** ([`retention-progression-system.md`](./retention-progression-system.md))
  for archetype-conditional milestone definitions (e.g. "first
  storefront published" milestone is influencer-only; "first sub-coach
  hired" milestone is gym/influencer/info-seller-only, never solo).

The archetype enum is **closed**: `solo`, `gym`, `influencer`,
`info_seller`. A future archetype addition is an OWNER-only schema
migration. There is no "other" bucket — if a coach does not fit, the
operator picks the closest match and notes the deviation in
`CoachOrganization.archetype_notes`.

---

## 3. Competitive landscape

This section is internal product positioning. It is the answer to
"why TGP and not X" the coach hears in onboarding, the support
operator hears on a downgrade call, and the admin console operator
sees as a churn-reason chip. It is not marketing copy.

| Competitor | What they do well | What they do not do | Where TGP wins |
|---|---|---|---|
| **Whop** | One-stop-shop for digital products; storefront, checkout, affiliate, community. | No coaching primitives — no client roster, no check-ins, no programs, no sub-coach hierarchy with delegated client ownership. | TGP layers coaching primitives (client roster, programs, check-ins, AI rollups) on the same one-stop-shop shape. The Wave 2 sub-coach hierarchy is the pivot Whop will not build. |
| **Trainerize** | Mature programming and tracking. Wide trainer adoption. | Single-trainer model — no native head-coach / sub-coach hierarchy with delegated billing. No commerce layer (no storefront, no offers). AI is a thin chat veneer over a non-AI product. | TGP is the substrate underneath what a Trainerize-using coach already does, plus the commerce + sub-coach + AI layers. |
| **MyFitnessPal** | Best-in-class consumer food database. | Consumer-only. No coaching surface. | Not a competitor at the platform layer; we use OpenFoodFacts + USDA in `src/food/` for the same role. |
| **Healthie** | EHR-grade clinical practice management; the operator-grade UX our admin console is modeled on. | Clinical-first, coach-third. Pricing assumes reimbursable practice. No commerce, no sub-coach hierarchy, no AI program builder. | TGP is Healthie's UX rigor applied to a coaching-first billing model with commerce + sub-coach + AI. |
| **Practice Better** | Solid practice management for nutrition coaches. | Same constraints as Healthie at smaller scale. | Same as Healthie. |
| **Skool** | Community-as-a-product, with light gamification. | No coaching primitives, no programs, no sub-coach hierarchy, no commerce beyond a single recurring price. The AI is a chat widget, not an operator copilot. | TGP's progression system ([`retention-progression-system.md`](./retention-progression-system.md)) is outcome-based, not tenure-based; that is the difference between *rewarding presence* and *rewarding results*. |
| **Kajabi / Teachable** | Course-platform tooling for info-sellers. | Course-first; coaching is an afterthought. No client roster as a first-class object. | TGP's info-seller archetype is the cross-sell from course to coaching the course platform structurally cannot do well. |

The pattern: every competitor wins at one corner of the
commerce / coaching / community / AI matrix. TGP is the single seam
that ties the four together for a coaching operator. The sub-coach
hierarchy is the irreducible feature; without it, the corners stay
disconnected and the operator is back to a stitched stack.

---

## 4. The "AI" angle — what makes us *Whop AI*

A chat widget is not a moat. The four AI surfaces below are the moat.
They are the ones a coach cannot get from Whop, Trainerize, Healthie,
or Skool, and they are the ones whose unit economics improve as the
sub-coach roster grows (more rollups, more recaps, more at-risk
detection).

All AI calls in the platform run through the existing
`AiGuardrailsService` and use the `sonar-pro` Perplexity model — never
`sonar`, per the operator constraints in
[`../../PERP_HANDOFF.md`](../../PERP_HANDOFF.md). Cost ceilings, deny-
list scrubbing, calorie-floor checks, and AI-tell scrubs are inherited
from the existing AI plumbing in `src/ai/` (PR #80 and successors).

The four surfaces:

### 4.1 AI Weekly Recap

A one-screen synthesis the coach reads on a Monday morning that
replaces the manual roster-walk. For each client: progress vs goal,
adherence, last check-in summary, last logged outcome, and a
suggested coach action. The coach approves or edits before sending.

- **Source data.** The existing `ClientAIContext` aggregator (PR #80)
  produces the per-client structured context the recap is built from.
  Wave 2 does not change the aggregator; it adds a 7-day-window read
  shape per client.
- **Endpoint.** `POST /api/v1/coach/recap/preview` (new in the runtime
  PR that lifts this spec) returns a recap draft. The coach edits and
  fires `POST /api/v1/coach/recap/send` to deliver.
- **Cost shape.** Per-client recap is a single `sonar-pro` call. A
  100-client roster is 100 calls a week, capped per the existing AI
  cost guard in `src/ai/`.
- **Spec home.** Owned by PR #121 row #23 (in
  [`../../docs/architecture/expansion-roadmap-addendum-pre-work.md`](../architecture/expansion-roadmap-addendum-pre-work.md)).
  Wave 2 references it; the runtime contract is owned by #121.

### 4.2 AI At-Risk Client Detector

A read-side service that flags clients whose recent signal pattern
predicts churn, based on a deterministic rule engine (no ML in v1)
that surfaces:

- last logged-food recency exceeds threshold,
- last weight-log recency exceeds threshold,
- check-in adherence below threshold,
- AI chat sentiment of last interactions trending negative,
- subscription is `past_due` per [`../entitlements.md`](../entitlements.md).

Each rule produces a `flag_reason` string visible to the coach. The
flags are surfaced in the existing `/coach/alerts` endpoint and on
the admin Coaches table as an `at_risk_client_count` chip.

- **Spec home.** Owned by PR #121 row #22. Wave 2 references it.
- **Org awareness.** When sub-coach hierarchy is live, the flag is
  scoped to the `CoachMembership` that owns the client; head coaches
  see all flags across their org, sub-coaches see only their own
  clients' flags. RBAC details in [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §7.

### 4.3 AI Program Builder

A coach-facing program-authoring tool. The coach describes the client
("44-year-old, two sessions a week, knee surgery six months ago, goal
to deadlift 2x bodyweight") and the builder produces a draft program
the coach edits and saves. Drafts go through the same guardrails as
chat (calorie floor, banned-substance, no-medical-advice).

- **Spec home.** Owned by PR #117 RFC. Wave 2 references it as the
  Phase-2 entry point on the coach mobile and admin console; the
  runtime contract is owned by #117.

### 4.4 AI Check-in Summarizer

A read-side service that turns a long-form coach-client check-in
transcript (text or transcribed audio) into a structured summary:
goals progressed, blockers raised, agreed actions, next-check-in
date. The coach reviews and accepts; the summary lands as a row on
the existing `CheckIn` model.

- **Spec home.** Reuses the `CheckIn` schema in `src/check-ins/`. The
  summarizer endpoint is new (`POST /api/v1/check-ins/:id/summarize`)
  and is part of PR #121 row #21's outcome-check-in expansion.
- **Audio path.** Audio transcription is out of scope for v1; the v1
  summarizer takes text input only. A future audio-input path is a
  separate Phase-3 brief — see §6.3.

---

## 5. AI coaching copilot — the unifying surface

The four AI surfaces above are **operator tools** the coach uses
explicitly. The copilot is the **passive layer** they all sit on.

The copilot is a single coach-mobile screen
(`audit-mobile.md` §2 lists `AIGuideScreen` as already shipped — this
is the same surface, scope-extended) that presents the coach with:

- "What needs your attention" — the at-risk flags from §4.2.
- "What you said you would do" — open coach commitments scraped from
  the last week of `CoachMessage` rows and the last accepted recap
  edits.
- "What changed" — clients who hit a milestone (per
  [`retention-progression-system.md`](./retention-progression-system.md)),
  clients who started a new program, clients whose subscription
  status flipped.
- "What I drafted for you" — recap drafts, check-in summaries,
  program-builder drafts pending coach approval.

The copilot is read-only on the AI side — it never autosends anything.
Every send is a coach action that lands an audit row. The copilot's
job is to remove the manual scanning step, not the decision step.

The copilot is **archetype-aware**. A solo trainer's copilot
de-emphasizes sub-coach rollups; a gym's copilot foregrounds
per-sub-coach performance; an influencer's foregrounds storefront
funnel metrics; an info-seller's foregrounds course-graduate
conversion.

---

## 6. The four-phase AI roadmap

Each phase is a coherent runtime release. Phase 1 is shippable on
top of the existing `src/ai/` plumbing with zero new infrastructure.
Phase 4 requires the sub-coach hierarchy from Wave 2 to be live.

### 6.1 Phase 1 — recap and risk

- AI Weekly Recap (§4.1) — per PR #121 row #23.
- AI At-Risk Detector (§4.2) — per PR #121 row #22.
- No schema additions. Both endpoints are reads over existing tables.
- Acceptance: median coach adoption (defined as "fired the recap
  preview at least once in a 14-day window") above the threshold the
  admin console renders on the Product usage screen
  (`docs/admin/control-room-spec.md` §9).
- Out of scope: program builder, check-in summarizer, copilot.

### 6.2 Phase 2 — authoring and summarization

- AI Program Builder (§4.3) — per PR #117 RFC.
- AI Check-in Summarizer (§4.4) — text-only.
- Schema additions: a small `AIProgramDraft` table (per #117 RFC),
  a `CheckInSummary` row attached to `CheckIn`. Both append-only.
- Cost guard. The program-builder call is the most expensive single
  AI call in the platform; it is rate-limited per coach per day in
  the existing `UserThrottlerGuard` configuration.
- Acceptance: program-builder coach-edit-rate (the share of
  AI-drafted programs the coach edits before saving) is the integrity
  check. If the rate falls below a low threshold, the coach is
  saving the AI output blind and the surface is degraded — operator
  alert.
- Out of scope: copilot, audio summarizer.

### 6.3 Phase 3 — copilot and audio

- AI Coaching Copilot (§5) as a unified mobile screen.
- Audio input on the check-in summarizer (Whisper or equivalent;
  cost-shaped).
- Schema additions: a small `CopilotSurface` row per coach for the
  feed shape; a `CheckInAudioAttachment` for the recording.
- Out of scope: org-level rollups, business-strategy AI.

### 6.4 Phase 4 — org rollups and business copilot

Available only after sub-coach hierarchy ([`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md))
is live in runtime. The phase replaces the per-coach copilot with an
**org copilot** for head coaches.

- Org rollup tiles in the copilot — sub-coach performance,
  per-sub-coach revenue contribution, sub-coach client churn.
- AI Business Copilot — proactive recommendations on offer pricing,
  sub-coach load balancing, archetype-specific marketing language.
  Owned by PR #126 engagement-wave's Business Copilot brief; Wave 2
  cross-references it.
- Acceptance: head-coach adoption of the org copilot above the
  threshold rendered on the admin console, scoped to gym +
  influencer + info-seller archetypes (solo trainers do not need an
  org copilot by definition).

---

## 7. Pricing posture

This section is the contract the commerce wave (PR #125) and the
sub-coach billing flows ([`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §8)
inherit. It is not the price list — actual prices are owned by the
OWNER and live in the Stripe dashboard.

- Three tiers: **L1** (solo / starting), **L2** (typical operator),
  **L3** (high-roster / org). Tier definitions live in
  [`../entitlements.md`](../entitlements.md). Wave 2 does not change
  the tier enum; it changes which entitlements live in which tier
  (specifically, sub-coach seats and progression unlocks live in L2+).
- Tier upgrades on **org features** (more than 1 sub-coach, more than
  N clients, AI program builder access) are gated by entitlement
  inheritance per [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §6.
- Yearly upgrade with auto-promotion to the "Founder" Charter Members
  tier (see [`retention-progression-system.md`](./retention-progression-system.md) §10)
  is the single Wave-2 pricing surface change. The runtime contract
  for the auto-promotion is owned by [`retention-progression-system.md`](./retention-progression-system.md) §10.

There is no free tier. There is no consumer SKU. The CEO doctrine on
right-fit member is non-negotiable.

---

## 8. Compliance, ethics, and the AI-tell scrub

Wave 2 inherits the existing operator constraints in full:

- **Calorie floor and banned-substance guardrails** — per
  `AiGuardrailsService` in `src/ai/`.
- **AI-tell scrub** — per the existing scrub in `src/ai/` that strips
  "As an AI language model" and similar tells from `sonar-pro`
  outputs. New AI surfaces in §4 inherit the scrub at the controller
  layer; no surface bypasses it.
- **No medical advice** — the AI surfaces produce coaching guidance,
  never medical guidance. The `no-medical-advice` deny-list applies.
- **Audit on AI write** — every AI surface that *creates* a row
  (recap sent, program saved, summary accepted) lands an `AuditLog`
  row through `AuditService.write`. Reads (recap preview, at-risk
  query) do not. The new audit actions are listed in
  [`data-tracking-contract.md`](./data-tracking-contract.md) §3.

The progression system in
[`retention-progression-system.md`](./retention-progression-system.md)
makes its own gamification ethics statement (§12 of that file). It
is the explicit choice that the platform's addiction loops are aimed
at *learning and outcomes* — not at session frequency or content
consumption — and the ethics statement is the contract the
runtime engineer is held to.

---

## 9. Out of scope (this file)

- The schema and RBAC for sub-coach hierarchy. See
  [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md).
- The progression system level definitions, milestones, and badges.
  See [`retention-progression-system.md`](./retention-progression-system.md).
- The client and coach onboarding flows. See
  [`onboarding-clients.md`](./onboarding-clients.md) and
  [`onboarding-coaches.md`](./onboarding-coaches.md).
- The PostHog event taxonomy additions. See
  [`data-tracking-contract.md`](./data-tracking-contract.md).
- The commerce / storefront / Stripe Connect runtime. PR #125.
- The community spaces / events / replays runtime. PR #126.
- The AI Program Builder runtime contract. PR #117.
- The Team Mode permission scaffolding ADR. PR #118.

This file is the frame; the rest of Wave 2 is the build.
