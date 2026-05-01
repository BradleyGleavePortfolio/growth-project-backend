# Gap map — coach-experience wave (rows #30–#37)

> **TL;DR — Do we have this already?**
> No. The eight items in this wave are not implemented and not
> spec'd anywhere else in the repo as of `main` at the time this
> file was authored. The closest existing artefacts are the four
> in-flight draft PRs #117 / #118 / #119 / #120 and the
> just-landed-in-draft PR #121. This file maps each new row to
> the nearest existing artefact so a reviewer can see, at a
> glance, **what is reused, what is forward-compatible, and what
> is genuinely new**.

This file is the answer to the reviewer question: "before we
write nine more specs, are we sure we don't already have this?"
It exists so the answer is one click away from each handoff
brief and from the wave index in
[`./expansion-wave-coach-experience.md`](./expansion-wave-coach-experience.md).

---

## How to read this map

For each row #30–#37 the table below records:

- **Row.** The roadmap number.
- **Closest existing artefact.** The nearest existing module,
  table, doc, or draft PR that touches the same problem space.
- **What is reused.** What this wave *does not* re-derive — the
  contract surface, schema convention, or runtime path the new
  spec inherits from the existing artefact.
- **What is genuinely new.** What this wave *adds* on top — the
  net-new tables, routes, jobs, or operator surfaces that would
  not exist without this wave.
- **Why a separate spec.** Why the new work cannot be folded
  into the existing artefact as a section.

## The map

### Row #30 — Coach-created challenges

- **Closest existing artefact.** PR #121 spec `outcome-check-ins.md`
  (#21) and `program-templates.md` (#28); the merged `Habit` /
  `HabitLog` family (`prisma/schema.prisma:530`,
  `prisma/schema.prisma:541`); the existing `CommunityWin` row
  (`prisma/schema.prisma:711`).
- **What is reused.** The check-in field-types vocabulary
  (`number`, `scale`, `boolean`, `text`, `image`) defined in spec
  #21; the per-kind validator pattern from PR #117 §3; the
  `acted_by_member_user_id` Team Mode hook from PR #118.
- **What is genuinely new.** A `CoachChallenge`,
  `CoachChallengeMetric`, `CoachChallengeParticipation`, and
  `CoachChallengeSubmission` family; a coach-facing CRUD API; a
  participant-facing submission API with idempotent per-period
  upserts; a finance-vertical metric-adapter shape (so a finance
  coach can run a "save $X this month" challenge with the same
  primitives a fitness coach uses for "10k steps a day").
- **Why a separate spec.** Challenges have their own state
  machine (draft / open / running / closed / archived), their own
  participation envelope (private vs invitation vs public), their
  own moderation surface, and their own leaderboard projection
  (#31). Folding into spec #21 would couple the periodic check-in
  rhythm to the competitive surface; folding into spec #28 would
  conflate a *program* (per-client, sequential) with a
  *challenge* (cohort, simultaneous).

### Row #31 — Public/private leaderboards

- **Closest existing artefact.** PR #121 spec
  `public-coach-profile.md` (#27); the merged `CommunityWin` row
  (`prisma/schema.prisma:711`); PR #120 platform-readiness lane
  03 (security/RBAC/tenancy) and lane 04 (data lifecycle).
- **What is reused.** The public-surface posture from #27 (cache
  + abuse rate-limits + GDPR scrub semantics); the federation
  envelope shape from `src/admin/federation/`.
- **What is genuinely new.** A `LeaderboardSnapshot` projection
  table; a participant `display_handle` separate from
  `User.email`; a per-leaderboard visibility enum
  (`private` / `link` / `public`); an abuse/moderation surface
  (block, takedown, freeze) with audit-log entries; a snapshot
  rebuild job (idempotent, source-of-truth `CoachChallengeSubmission`
  rows).
- **Why a separate spec.** Public leaderboards have abuse and
  privacy concerns that the public coach profile (#27) does not:
  per-user identifiable participation, opt-in display handle,
  takedown workflow. Folding into #27 would conflate "discover
  this coach" (marketing) with "rank against peers" (community).

### Row #32 — Profile pictures / avatar media

- **Closest existing artefact.** PR #117 RFC §8 (Supabase Storage
  prefix per coach, mime allow-list); PR #121 spec
  `public-coach-profile.md` (#27) which already references a
  coach avatar URL field; the merged `User` row
  (`prisma/schema.prisma:108`).
- **What is reused.** The mime allow-list and the per-actor
  Supabase Storage prefix from PR #117 §8; the public-surface
  cache posture from #27.
- **What is genuinely new.** A `UserAvatar` row (or three
  columns on `User` — see §10.A vs §10.B in the spec) with
  derived-thumbnail keys; an upload endpoint with size + mime
  validation and image-bomb defense; a derive-thumbnails job;
  an "avatar removed by operator" audit action;
  retention/scrub coverage in `audit-and-gdpr.md`.
- **Why a separate spec.** PR #117 §8 covers *coach asset
  ingestion* (PDFs / sheets / videos for the AI Program Builder),
  not user-identity media. The mime allow-list overlaps; the
  rate-limit and the scrub posture do not. Folding into PR #117
  would couple two unrelated rollouts.

### Row #33 — Coach content boards

- **Closest existing artefact.** PR #117 RFC §3 (`CoachAsset` /
  `CoachAssetChunk`); the merged `Lesson` row
  (`prisma/schema.prisma:554`); PR #121 spec `program-templates.md`
  (#28).
- **What is reused.** The `CoachAsset` shape and the Supabase
  Storage prefix from PR #117 §8; the coach-private vs
  platform-curated split from spec #28; the existing `Lesson`
  schema (a content-board "lesson card" is a thin client view
  over `Lesson`).
- **What is genuinely new.** A `ContentBoard` and
  `ContentBoardItem` family that *organizes* assets and lessons
  into a coach-curated reading list (newsletters, link bundles,
  PDF packs, video playlists); per-board visibility
  (private / clients-only / public); a per-item view-counter
  projection; a newsletter-style "send to all assigned clients"
  fan-out hook (deferred to row #36 wiring).
- **Why a separate spec.** PR #117 ingests assets so the AI
  Program Builder can *draft programs from them*. Content boards
  surface the same assets *to clients as a curated library*.
  Different consumers, different visibility model, different
  abuse surface. Folding into PR #117 would couple drafting and
  distribution.

### Row #34 — Coach-created regimens / programs

- **Closest existing artefact.** PR #121 spec `program-templates.md`
  (#28); the merged `WorkoutRoutine` (`prisma/schema.prisma:463`),
  `MealPlan` (`prisma/schema.prisma:624`), `Lesson`
  (`prisma/schema.prisma:554`), and `CoachGuideline`
  (`prisma/schema.prisma:732`) families; PR #117 RFC §12
  (publishing workflow).
- **What is reused.** The clone-into-`WorkoutRoutine` /
  `MealPlan` / `Lesson` transactional publish path from spec
  #28; the per-kind validator family from PR #117 §3; the
  `acted_by_member_user_id` Team Mode hook from PR #118.
- **What is genuinely new.** A `Regimen`, `RegimenWeek`, and
  `RegimenBlock` family that orchestrates *templates* across
  multiple weeks (a regimen is a 12-week program; a template is a
  one-week building block). A regimen `state` enum
  (draft / published / archived). A versioning convention
  (publishing a new version creates a new row; assignments pin a
  version).
- **Why a separate spec.** Spec #28 introduces the *template*
  primitive (a single reusable program shape). A regimen is a
  *sequence* of templates with progression rules. Folding into
  #28 would conflate the building block with the orchestration.

### Row #35 — Per-client regimen assignment

- **Closest existing artefact.** PR #121 spec `program-templates.md`
  (#28) §"Clone transaction"; the merged `MealPlan.client_id` /
  `WorkoutRoutine.client_id` foreign keys; the merged
  `ClientCoachConsent` row (`prisma/schema.prisma:918`).
- **What is reused.** The clone-transaction shape from #28; the
  consent gate from `ClientCoachConsent`; the existing
  per-client foreign keys on the workout/meal/lesson families.
- **What is genuinely new.** A `RegimenAssignment` row that pins
  a specific regimen *version* to a client with a start date,
  optional end date, and an active-vs-archived state; an "advance
  one week" cursor (or a derived computation off start date) so
  client-side reads of "what is this client doing this week"
  are O(1); a transactional unassign that does not delete prior
  client data; a per-assignment audit envelope.
- **Why a separate spec.** Spec #28 defines clone *into* a
  client. Assignment defines the durable relationship between a
  client and a regimen *version* over time, including
  re-assignment, pause, and migration to a new version. Folding
  into #28 would conflate one-shot clone with ongoing
  assignment.

### Row #36 — Messaging + progress visibility

- **Closest existing artefact.** The merged `messaging` module
  (`src/messaging/README.md`) and `CoachMessage`
  (`prisma/schema.prisma:661`); the merged `coach` module
  (`src/coach/README.md`) and the timeline / alerts / roster
  surface; PR #121 specs `at-risk-detector.md` (#22),
  `weekly-recap.md` (#23), and `outcome-check-ins.md` (#21).
- **What is reused.** The existing `CoachMessage` schema and
  realtime ping; the existing roster + timeline surface; the
  field-types vocabulary from spec #21; the at-risk score from
  spec #22.
- **What is genuinely new.** A `ProgressSignal` projection that
  collapses adherence (regimen, check-ins, content viewed,
  challenge submissions, weight log, fasting log) into one
  per-client envelope a coach reads from a single endpoint; a
  message-deep-link convention (a `CoachMessage` carries an
  optional `subject_kind` + `subject_id` so a coach can DM
  "hey, I noticed you skipped this content" with a link); a
  per-client visibility setting (the client controls what a
  coach can see in the progress envelope, with a default
  derived from `ClientCoachConsent`).
- **Why a separate spec.** The existing messaging module is a
  thin chat surface; the existing coach surface is a thin
  roster. The progress envelope joins them and adds a privacy
  axis the existing modules do not have.

### Row #37 — L2 / L3 tiering and white-glove

- **Closest existing artefact.** The merged `entitlements`
  read model (`docs/entitlements.md`) and
  `src/admin/entitlements/`; the merged billing module
  (`src/billing/README.md`); PR #120 platform-readiness lane 05
  (billing/packaging); PR #117 §15 (cost controls); PR #121
  spec `revenue-dashboard.md` (#29).
- **What is reused.** The entitlement read shape
  (`active_products`, `bundle`, `overall`, `products`,
  `account_suspended`); the Stripe price-id env-var family
  (`STRIPE_PRICE_ID_FITNESS`, `STRIPE_PRICE_ID_FINANCE`); the
  webhook mirror tables; the OWNER admin federation envelope.
- **What is genuinely new.** A first-class **tier** axis
  (`L1` / `L2` / `L3`) layered *above* the existing per-product
  status; a tier-gated feature matrix (challenges quotas,
  content-board byte ceilings, regimen counts, white-glove
  intake hours, marketing support credits, hiring/team support
  credits, branded-instance flag); a per-tier override table
  (the additive Phase-2 shape sketched in
  `docs/entitlements.md` §"Phase 2") that this spec lifts to a
  concrete migration plan; an OWNER-only "promote to L3"
  workflow with audit and a credit-allowance ledger; the
  branded-instance subdomain + theming surface as a
  forward-compat hook (no DNS work in this spec).
- **Why a separate spec.** The entitlement read model is
  cross-product (fitness vs finance) on a single axis; tiering
  is *orthogonal*: an account can be L2-fitness or L3-bundle.
  Folding tier into the existing read model without a spec
  would require touching every consumer (admin console,
  mobile, BFF) without a migration plan; the spec exists so the
  migration *is* the plan.

---

## Platform-readiness coverage (PR #120 crosswalk)

Every row in this wave maps onto one or more of the 11
platform-readiness lanes from PR #120. The mapping below is the
"read these lane briefs before scoping the runtime PR" list for
each row.

| Row | Lane(s) | Why |
|---|---|---|
| #30 challenges | 01, 03, 04, 11 | Feature flag (entitlements gate quota); RBAC (coach-private write, public read); GDPR scrub for participants who delete their account; release/QA gates for the new state machine. |
| #31 leaderboards | 01, 03, 04, 06, 10 | Feature flag (visibility default); RBAC (display-handle authz); GDPR (display-handle scrub on account delete); observability (snapshot job heartbeat); analytics (leaderboard view event). |
| #32 avatar | 03, 04, 06 | RBAC (other coaches cannot read raw upload paths); GDPR (avatar bytes scrubbed on account delete); observability (upload error rate). |
| #33 content boards | 01, 03, 04, 11 | Feature flag (visibility default per board); RBAC (board owner only writes); GDPR (board contents scrubbed on coach delete); release gates for the per-client fan-out. |
| #34 regimens | 01, 03, 07, 11 | Feature flag (publish gate); RBAC (own regimens only); migration safety (additive only, FKs concrete); release gate for the publish-transaction surface. |
| #35 assignment | 01, 03, 04, 07, 11 | Feature flag (rollout default off); RBAC (consent gate); GDPR (assignment archived on client delete, not hard-deleted); migration safety (assignment row is additive); release gate for re-assignment. |
| #36 messaging+progress | 01, 03, 04, 10 | Feature flag (per-client visibility default); RBAC (client controls visibility axis); GDPR (progress envelope is a projection, scrubbed when sources are scrubbed); analytics (message-with-deep-link event). |
| #37 tiering L2/L3 | 01, 05, 11 | Feature flag (L2/L3 features default off until tier set); billing/packaging (the spec *is* the packaging change); release gate for the tier-promotion workflow. |

---

## Existing-PR crosswalk (one-line answer to "do we have this already?")

| Row | "Do we have this?" | Closest in-repo artefact |
|---|---|---|
| #30 challenges | No. | PR #121 specs #21, #28; merged `Habit` / `HabitLog`; merged `CommunityWin`. |
| #31 leaderboards | No. | PR #121 spec #27 (public coach profile); merged `CommunityWin`. |
| #32 avatar | No. (One field on `User` is referenced by spec #27 but no upload pipeline exists.) | PR #117 §8; PR #121 spec #27. |
| #33 content boards | No. (Coach assets are ingested for AI; not surfaced to clients as a library.) | PR #117 §3, §8; merged `Lesson`. |
| #34 regimens | No. (Templates are spec'd in #28; multi-week orchestration is not.) | PR #121 spec #28; merged `WorkoutRoutine` / `MealPlan` / `Lesson`. |
| #35 assignment | Partial. (`MealPlan.client_id` and `WorkoutRoutine.client_id` exist but a durable assignment row over time does not.) | PR #121 spec #28 §"Clone transaction"; merged `ClientCoachConsent`. |
| #36 messaging+progress | Partial. (`CoachMessage` exists; a progress envelope and a deep-link convention do not.) | Merged `src/messaging/`; PR #121 specs #21, #22, #23. |
| #37 tiering L2/L3 | Partial. (Per-product status exists; a tier axis above it does not; per-tier override table is sketched but not migrated.) | Merged `docs/entitlements.md`; merged `src/admin/entitlements/`; PR #120 lane 05. |

---

## What this wave deliberately does **not** add

To keep the wave reviewable, the following items are explicitly
out of scope and parked for later waves (#38+):

- **Coach-to-coach community.** Any cross-coach interaction
  surface (forums, DMs, follower graphs).
- **Live events / streaming.** Any real-time content (live
  classes, group calls). Content boards in #33 are durable
  artefacts only.
- **Affiliate / referral programs.** Out of scope; these
  belong in a billing-side spec.
- **Custom domain / white-label DNS.** Row #37 reserves the
  branded-instance flag and the subdomain shape; the DNS work
  itself is parked.
- **Mobile push fan-out.** Out of scope for this wave;
  parking-lot row #07 in PR #119's roadmap.
- **Group programs (cohort-based regimens).** Parking-lot row
  #09 in PR #119's roadmap. Row #34 here is single-client
  assignment; row #09 is the group variant.

---

## See also

- [`./expansion-wave-coach-experience.md`](./expansion-wave-coach-experience.md)
  — the wave index that ties these rows to their roadmap
  numbers.
- [`./expansion-roadmap.md`](./expansion-roadmap.md) — the
  parent roadmap (PR #119).
- [`./expansion-roadmap-addendum.md`](./expansion-roadmap-addendum.md)
  — rows #21–#29 (PR #121).
- [`./platform-readiness/README.md`](./platform-readiness/README.md)
  — cross-cutting lanes (PR #120).
- [`../entitlements.md`](../entitlements.md) — the existing
  entitlement read model that row #37 lifts to include a tier
  axis.
