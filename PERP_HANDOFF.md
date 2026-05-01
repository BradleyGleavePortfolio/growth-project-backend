# Perplexity Computer — handoff log

This file is updated by every Computer session that does substantive
work in this repo. New sessions should read it top-to-bottom before
touching anything. The most recent session is at the top.

---

## Session 2026-05-01 (late PDT) — Wave 2 rewards layer (follow-up)

**Goal:** layer tonight's OWNER decisions onto the Wave 2 retention
engine. The Wave 2 subagent built an outcome-anchored engine
(milestones, levels, badges, schema, state machine) but did not
include the reward content the OWNER had not yet decided. After the
subagent completed, the OWNER and operator hashed out the coach
tenure ladder, the coach achievement track, the three-track client
model, the Year One golden-ticket cross-coach exception, and the
tier-overlap upsell policy. This follow-up commits those decisions as
a new doc that layers on top of the engine without contradicting it.

**Status:** docs-only, draft, NOT MERGED. Same branch as the main
Wave 2 PR (`docs/wave-2-product-specs`, PR #132). Single follow-up
commit on top of the subagent's work.

### What was done

| File | Action | Lines |
|---|---|---:|
| `docs/product/retention-progression-rewards.md` | New | ~720 |
| `docs/product/retention-progression-system.md` | Edit — added forward-pointer to rewards layer at top | +18 |
| `docs/product/README.md` | Edit — reading order updated to eight files; rewards layer slotted between engine and onboarding | +12 |
| `PERP_HANDOFF.md` | Edit — this entry | (this) |

### What's locked in the rewards layer

**Coach Track A — tenure ladder (M1–M36):**

- M1: 30-min onboarding call with TGP team
- M3: up to 20 qualifying leads from TGP funnel (capped, with anti-broken-promise wording)
- M6: mastermind invite (quarterly, 8–12 coaches max per cohort)
- M9: "Coach Spotlight" on TGP site + email blast + social
- M12: done-for-you funnel audit + tier-aware annual upgrade offer (OS-only → 2 months free; OS+team → 1 month free + quarterly biz review with OWNER; white-glove → custom outcome, no discount)
- M18: priority feature requests channel + quarterly 1-on-1 with OWNER
- M24: lifetime locked pricing AND lifetime referral revshare (20% recurring on referrals who stay >90 days)
- M36: in-person retreat invite (annual, ~20 coaches max, hybrid cost model deferred)

**Coach Track B — achievement ladder (composite milestones):**

First Win (1 client) → Trusted (10 retained >60d) → Builder (25 active OR $5K MRR) → Operator (50 active OR $10K MRR OR first sub-coach) → Authority (100 active OR $25K MRR) → Top Performer (top 10 retention 90d) + Comeback Coach + Referrer.

**Tier-overlap policy (OWNER decision):** a coach who earns Authority **but pays for OS-only or OS+team** receives a one-time "taste" of the next tier (free quarterly exec review with OWNER) as a soft upsell. White-glove + Authority gets a personal acknowledgement only — OWNER offers bespoke perks privately at their discretion. The system never feels like clawback; the achievement track is a generous, irreversible status; the pricing tier is what was paid for; when they overlap, we pull the coach toward the next tier.

**Client Track 1 — Consistency:** Showing Up (7d) → Locked In (30d) → Disciplined (90d) → Relentless (180d) → Year One (365d). All same-coach scoped except Year One. Streaks computed internally but NOT surfaced numerically to UI — preserves the PR #90 doctrine that excised streak counters.

**Client Track 2 — Outcome:** OS-app-specific milestones (Fitness, Finance, future) reward shareable milestone reels (auto-compiled before/after the client posts to their own social, tagging coach — free reach for both sides) and coach voice-message prompts.

**Client Track 3 — Community:** same-coach cohort contributions (Helper, Cheerleader, Cohort Lead, Ambassador). Depends on a cohort feed surface in mobile (Wave 4); deferral handled via §7 Open question 4 in the rewards doc.

**Year One — the one cross-coach exception (OWNER decision):** clients who hit 365 days **with their coach** AND have an "activity marker" (active in 4 of the last 8 weeks; threshold confirmed in §7 Open question 5) receive: (1) golden ticket to a premium TGP retreat as an upsell offer, NOT a free retreat, (2) admission to a private cross-coach Year One chat channel moderated by TGP team, status only — no comp data shared, no client poaching, coaches do not have visibility, (3) special social cue on profile and cohort feed. Charter Members rules apply; both badges can be held simultaneously.

### What clients explicitly do NOT get

- No free months. Client pays the coach, not TGP — free months would cut into coach revenue.
- No discounts.
- No refunds-as-reward.
- No cross-cohort comparisons (except Year One channel).
- No streak counters surfaced to UI.

### Engine extensions introduced (no migrations in this PR — spec only)

- `RewardKind` enum with 18 cases (11 coach-only, 7 client-only).
- `RewardCatalog` (rows are seedable / OWNER-editable).
- `RewardGrant` (state machine: pending_delivery → delivered → redeemed | expired | revoked).
- `RewardOverlapPolicy` (the one place achievement and pricing tier interact).
- `CompositeMilestoneRule` with discriminated-union AST (`and` / `or` / `count_active_clients` / `mrr_cents` / etc.). Evaluation cadence: event / cron_daily / cron_weekly.
- `LeadAllocation` (Month-3 reward attribution table).

### 10 deferred decisions (logged in `retention-progression-rewards.md` §7)

1. Lifetime-locked-pricing terms when TGP raises base prices in year 3+ (recommendation: lock current rate, allow new SKUs to scale).
2. Mastermind cadence + host (recommendation: quarterly, OWNER for first 4 cohorts).
3. Retreat cost model (recommendation: hybrid — TGP covers venue+content, coach pays travel + nominal seat fee).
4. Cohort feed UX in mobile (recommendation: full feed; Track 3 lands v2 if deferred).
5. Year One "activity marker" threshold (recommendation: 4 of 8 weeks active).
6. Year One golden ticket: single-redemption or annual-recurring (recommendation: single per milestone, refires on renewal to Year Two).
7. Top Performer reward content (recommendation: free month of OS sub + leaderboard placement on coach directory + optional shoutout).
8. "Qualifying lead" definition for Month-3 (recommendation: archetype/niche match + geo target if specified + no other coach grant in past 90d).
9. Tier-overlap exec-review-taste copy (drafted by OWNER, not engineering).
10. Charter Members vs Year One relationship (locked: a user can hold both; UI surfaces them as two separate badges).

### Cross-repo touchpoints surfaced by the rewards layer

- `growth-project-mobile` Wave 4 PR #98 — Track 3 Community requires a cohort feed; if that surface is not in Wave 4 v1, Track 3 ships v2 (engine and Tracks 1+2 are unaffected).
- `tgp-finance-app` Wave 5 PR #109 — sub-coach-aware MRR is the source for `mrr_cents` composite expressions; the existing `finance-org-roll-ups.md` contract is the consumer.
- `growth-project-backend/docs/admin/control-room-spec.md` (Wave 1 PR #130) — new capabilities `act:reward_revoke`, `act:year_one_moderation`, plus admin console screens for `RewardCatalog`, `RewardOverlapPolicy`, `JoiningIncentive` editors.
- `growth-project-backend/docs/admin/data-feed-rfc.md` (Wave 3 PR #131) — the `retention_90d` leaderboard for Top Performer is a candidate for the §org observe family in the data-feed RFC.

### What the next Computer should know

1. **The rewards layer is reward-content-editable without schema migrations.** OWNER decisions (e.g. "actually let's make M9 a video walkthrough instead of a written spotlight") are catalog-row edits, not Prisma changes.
2. **Adding a new reward kind requires a Zod schema** (per `RewardKind`). The runtime PR is responsible for that validator + the `@SkipDecimalNormalisation()` decorator on the lifetime-pricing-lock payload (per `tgp-finance-app/docs/billing/sub-coach-billing-split-spec.md`).
3. **The doctrine alignment with `retention-progression-system.md` §7.1** (no streak counters, no social-reaction primitives) is preserved by computing streaks internally but presenting milestone names. Verify in code review that no UI surface ever displays a numeric streak count.
4. **The achievement track and the pricing tier interact in exactly one place** (`RewardOverlapPolicy`). Everywhere else they are independent. Code review should reject any new place where they are coupled.
5. **The Day-1 implementation order in §11 of the rewards doc is the recommended commit sequence** for the runtime PR. Step 5 (tenure cron + per-kind dispatchers) is feature-flag gated per kind — the system can ship to production with all kinds disabled, then incrementally enable.
6. **The Year One golden ticket is the only cross-coach surface in the entire client experience.** Any future code that adds another cross-coach surface must justify the boundary breach in its PR description and add a new audit-action constant for it.
7. **The OWNER's lifetime-locked-pricing promise at M24 is a binding record via the rendered `lock_terms_md` in the `RewardGrant.payload`.** Audit rows are permanently retained. Treat this as a legal-grade artifact in the runtime PR.

---

## Session 2026-05-01 (mid-PDT) — Wave 2 product specs

**Goal:** spec the next product layer on top of the Wave 1 admin
console (PR #130) — Whop-AI positioning, sub-coach hierarchy,
retention progression, and the onboarding flows that tie them
together. Docs only. Strict no-runtime-touch.

**Status:** docs-only, **draft, NOT MERGED**. Sits alongside PR
#130 (Wave 1) as a peer wave. User instruction: stay unmerged
tonight; build to one-click-to-merge state.

### What was done

Created branch `docs/wave-2-product-specs` from `main`. Added a new
directory `docs/product/` containing seven spec files. Created the
root `PERP_HANDOFF.md` (this file) — there was no prior handoff log
on `main`; the Wave 1 session in `wave-context/PERP_HANDOFF.md` was
authored against the `docs/admin-console-canonical` branch (PR #130)
and has not landed on `main`. This file is the canonical handoff log
going forward; the Wave 1 entry below preserves the prior content
verbatim for traceability.

| File | Lines | Purpose |
|---|---:|---|
| `docs/product/README.md` | 120 | Index, reading order, cross-refs |
| `docs/product/positioning-whop-ai-for-coaches.md` | 431 | Brand frame, four buyer archetypes (solo / gym / influencer / info_seller), competitive landscape, four-phase AI roadmap, the AI coaching copilot |
| `docs/product/sub-coach-hierarchy.md` | 1074 | Largest spec. `CoachOrganization` + `CoachMembership` schema, four-role enum (`OWNER`, `HEAD_COACH`, `SUB_COACH`, `ASSISTANT`), entitlement inheritance, two billing flows (Flow A separate billing, Flow B internal split via Stripe Connect), `/api/v1/org/*` and `/api/admin/orgs/*` API surface, audit, three-step migration strategy |
| `docs/product/retention-progression-system.md` | 937 | Outcome-anchored level/milestone/badge ladder for clients (Newcomer→Charter Member) and coaches (Founding→Charter Coach). Drip-unlock contract. Charter Members panel (replaces Iman's "Grand Visors"). Yearly-plan auto-promotion. Gamification ethics statement |
| `docs/product/onboarding-clients.md` | 574 | 5-step product layer on top of the existing 10-step + 4-step Lean mobile flows. First-win moment per archetype. 24h / 72h / 7d / 14d drop-off recovery cascade. Acceptance criteria |
| `docs/product/onboarding-coaches.md` | 568 | 6-step coach setup flow. Archetype-specific templates. Time-to-first-client targets (<7d solo, <14d others). 5-step variant for sub-coaches |
| `docs/product/data-tracking-contract.md` | 404 | Single canonical event registry (~70 new events) tying Wave 2 to existing `src/analytics/events.ts` + `AuditLog`. Property catalog, forbidden-property deny-list, audit pairings |

Total Wave 2 docs added: **4,108 lines** across 7 files. None of them
modify runtime, schema, env, or CI.

### Key product decisions made (locked in spec)

1. **Four-archetype enum is closed.** `solo`, `gym`, `influencer`,
   `info_seller`. No "other" bucket. Archetype is set at org
   creation and editable only by platform-OWNER (not the coach
   themselves) to prevent self-reclassification gaming the default
   rules.

2. **Sub-coach hierarchy is a two-level model: organizations +
   memberships.** A `CoachOrganization` holds one or more
   `CoachMembership` rows with role enum `OWNER` / `HEAD_COACH` /
   `SUB_COACH` / `ASSISTANT`. Solo trainers are an organization of
   one (degenerate case). The model preserves the existing single-
   coach runtime as a migrate-in-place case (see §12 of
   `sub-coach-hierarchy.md`).

3. **Two billing flows, A is the default, switching is one-way at a
   time.** Flow A (separate): each coach has their own
   `CoachSubscription`. Flow B (internal split): head coach pays
   platform a higher fee + pays sub-coaches via Stripe Connect
   transfers tracked in a new `CoachOrgTransfer` table. Switching
   from A to B requires Stripe Connect onboarded; B to A requires
   each sub-coach to establish their own subscription. Detailed
   refund-cascade rules (head-coach refund → sub-coach pro-rata)
   are owned by Wave 5 in `tgp-finance-app`.

4. **Cross-org client reassignment is OUT OF SCOPE for v1.** A
   client is admitted to one org via invite redemption and stays
   there. Cross-org moves require manual platform-OWNER
   intervention.

5. **Progression is outcome-anchored, not tenure-anchored.** Client
   levels move on goals hit + programs completed (not on session
   frequency or app-open count). Coach levels move on revenue +
   roster growth. The Iman Gadzhi Digital Launchpad transcript was
   the source; the adaptation is deliberate. See §12 of
   `retention-progression-system.md` for the gamification ethics
   statement.

6. **Streaks, daily-login badges, leaderboards, and social-reaction
   primitives stay excised** (PR #90 doctrine). The badges in this
   spec are platform-awarded credentials for specific milestones
   (e.g. "First $1,000"), not social-reaction shapes. §7.1 of
   `retention-progression-system.md` makes the distinction explicit.

7. **Charter Members panel replaces "Grand Visors."** Brand voice
   alignment. Admission is OWNER-curated (not auto), eligibility
   surface is Steward (clients) / Scaling (coaches). Channel reuses
   `src/messaging/`; it is NOT a community space (PR #126 owns
   community).

8. **Yearly-plan upsell auto-promotes coaches but NOT clients.**
   Coach commercial commitment IS the relevant signal; client
   outcomes are. The non-promotion of clients is the product
   distinction between the two axes. The only money-shaped lever in
   the system.

9. **First-win moment is archetype-specific.** Solo: 3-day habit
   streak. Gym: first full workout session. Influencer: first
   program block completed. Info-seller: first accountability
   check-in. The platform recognises it; the coach is prompted to
   celebrate it. The platform never bypasses the coach to
   congratulate the client directly.

10. **PostHog never receives raw revenue, body text, or PII.** All
    money is bucketed (`<100`, `100-500`, `500-2000`, `>2000`). All
    body text is bucketed (`<50`, `50-200`, etc.). All target ids
    that would reveal sensitive targeting are HMAC-hashed. The
    existing PII deny-list is extended in §5 of
    `data-tracking-contract.md`. `AuditLog` remains the
    authoritative record; PostHog is the funnel and cohort tool.

### Placeholder content (intentional, all justified)

These items are listed as placeholder-or-deferred so a future
runtime author or operator does not assume they were forgotten.
Each has a noted reason and a noted next step.

1. **Default seat caps per archetype per tier.** §6.3 of
   `sub-coach-hierarchy.md` lists illustrative numbers (gym L2: 5
   sub-coaches; gym L3: 25; influencer L2: 3; etc.). The actual
   numbers are OWNER-set in the entitlement-set table at runtime.
   The spec deliberately does not invent prices or seat counts. The
   OWNER must set them before the gym/influencer archetype goes
   live.

2. **Default first-win window.** §3.4 of `onboarding-clients.md`
   declares 30 days. OWNER-tunable via `OnboardingConfig`. The
   actual value is OWNER-set; 30 is a recommendation that covers
   the typical 4-week starter program window.

3. **Reminder cadence values.** §4.1–§4.4 of `onboarding-clients.md`
   declare 24h / 72h / 7d / 14d. §4.2 of `onboarding-coaches.md`
   declares D2 / D5. All values are OWNER-tunable via
   `OnboardingConfig`. The spec does not propose fixed cadences;
   the recommendations above are the defaults the runtime ships
   with and the OWNER overrides.

4. **MRR / amount / token / body-length bucket boundaries.** Listed
   in §4 of `data-tracking-contract.md`. Boundaries are
   illustrative coarse buckets; the OWNER may want different
   bucket boundaries on the admin Product usage screen. Bucket
   boundaries do not require a runtime migration to change; they
   are emitted at event-write time.

5. **Hash secret for `*_user_id_hash` properties.** §11 question 1
   of `data-tracking-contract.md`. The OWNER provides the secret
   and the rotation cadence; the spec does not invent a value.

6. **`reason_category` closed enumeration.** §11 question 2 of
   `data-tracking-contract.md`. The runtime author requests the
   enumeration from the OWNER at implementation time; the spec
   does not invent values.

7. **Per-archetype profile required-fields list.** §12 question 2
   of `onboarding-coaches.md`. The OWNER provides the per-archetype
   list; the spec defaults to the existing `CoachProfile` shape.

8. **Per-archetype invite-link copy.** §10 of
   `onboarding-clients.md`. The actual strings live in the email-
   template module under `docs/emails/`; they are owned by support
   copywriting, not by this spec.

9. **`CoachTemplate` for the info-seller archetype.** §2.4 of
   `onboarding-coaches.md` declares the "Accountability container"
   as a new template the runtime PR ships. The spec does not include
   the template payload; the runtime PR seeds it.

10. **Goal-direction inference.** §18 question 3 of
    `retention-progression-system.md`. The runtime PR may add an
    explicit `goal_direction` enum to `UserProfile` to remove the
    inference; the OWNER decides whether to add the column or
    accept the directional inference from the existing goal shape.

### Cross-repo dependencies (all draft, all unmerged)

Wave 2 is the **product layer**; the runtime substrate it depends
on is partially specced and partially shipped. Dependencies the
runtime author must reconcile before lifting any Wave 2 spec:

| Wave 2 spec | Depends on | Status |
|---|---|---|
| `sub-coach-hierarchy.md` | PR #118 Team Mode ADR (permission scaffolding) | Draft, do-not-merge marker. §12.5 of the spec spells out how Wave 2 is the product layer of #118's runtime substrate. |
| `sub-coach-hierarchy.md` (Flow B billing) | PR #125 commerce wave (Stripe Connect onboarding) | Draft. Flow B consumes the Stripe Connect plumbing #125 specs; Wave 2 does not respec it. |
| `sub-coach-hierarchy.md` (refund cascade) | Wave 5 finance app sub-coach billing-split spec | Not yet open in `tgp-finance-app`. Wave 2 declares the contract; Wave 5 owns refund rules. |
| `retention-progression-system.md` (Charter chat) | `src/messaging/` existing module | Shipped. Charter chat is a new `MessageThread` type. |
| `retention-progression-system.md` (community references) | PR #126 engagement wave | Draft. Charter chat is NOT a community space; the spec is explicit that they are different surfaces. |
| `positioning-whop-ai-for-coaches.md` (AI Program Builder) | PR #117 AI Program Builder RFC | Draft. Wave 2 references; runtime contract owned by #117. |
| `positioning-whop-ai-for-coaches.md` (Phase 1 recap + at-risk) | PR #121 row #22 + #23 (pre-work specs) | Draft. Wave 2 references; runtime contract owned by #121. |
| `data-tracking-contract.md` (admin Product usage) | PR #130 Wave 1 admin console (`docs/admin/control-room-spec.md`) | Draft. The Product usage screen is §9 of the canonical spec. Wave 2 adds funnel cells; doesn't change the screen shape. |
| `data-tracking-contract.md` (org-aware metrics rollup) | The next admin-spec PR (Wave 2 of admin) | Not yet open. Wave 2 reserves §11.P–T gap letters for the admin runtime; the next admin-spec PR adds them to `control-room-spec.md` §11. |
| `onboarding-clients.md` + `onboarding-coaches.md` | `growth-project-mobile` Wave 4 | Wave 4 is the mobile-mirror PR. Wave 2 fixes the backend contract; Wave 4 fixes the mobile render. |

### Open questions surfaced by the Wave 2 spec

These are decisions the platform-OWNER must close before any Wave 2
runtime PR opens. Captured here for visibility; each spec
references them in its own §-Open-questions section.

1. **Sub-coach Flow B Connect-account model:** one Connect account
   per head coach (recommended) vs one per sub-coach. (See
   `sub-coach-hierarchy.md` §16 question 4.)
2. **Cross-org client reassignment:** out of scope for v1; the
   OWNER confirms a future PR adds it via a manual platform-OWNER
   endpoint, or declares it permanently out of scope. (See
   `sub-coach-hierarchy.md` §16 question 2.)
3. **Charter Members tenure threshold (months):** OWNER-set; the
   schema does not encode it. (See
   `retention-progression-system.md` §18 question 1.)
4. **Yearly-plan refund-window demotion:** the spec defaults to
   "demote on refund" because not demoting creates a gameable path
   (buy yearly, refund in window, keep the level). The OWNER
   confirms or rejects. (See `retention-progression-system.md`
   §18 question 4.)
5. **Charter Members visibility to the user's coach:** spec
   recommends yes; alternative is no (Charter is a confidential
   platform-OWNER relationship). (See
   `retention-progression-system.md` §18 question 5.)
6. **48-hour client onboarding completion threshold:** spec
   recommends 80%. (See `onboarding-clients.md` §13 question 1.)
7. **Median time-to-first-client thresholds (coach onboarding):**
   spec recommends <7d solo, <14d others. (See
   `onboarding-coaches.md` §12 question 4.)
8. **Template prefill rate threshold:** spec recommends 70%. (See
   `onboarding-coaches.md` §12 question 5.)
9. **Hash-secret rotation cadence:** OWNER-set. (See
   `data-tracking-contract.md` §11 question 1.)
10. **`reason_category` closed enumeration:** OWNER-set. (See
    `data-tracking-contract.md` §11 question 2.)

### What is NOT in this PR (intentional, all justified)

- **No runtime source under `src/`.** Wave 2 is docs-only.
- **No `prisma/schema.prisma` changes or migrations.** The Prisma-
  style schema sketches in the specs are illustrative; they are in
  ```prisma``` fences so a future runtime PR can lift them. No
  migration is implied.
- **No environment variable changes.**
- **No CI / Fly / smoke configuration changes.**
- **No `package.json` changes.**
- **No changes to `new-website` (no such directory in this repo).**
- **No Stripe Connect onboarding flow.** Owned by PR #125 commerce
  wave.
- **No marketplace / storefront / offer-builder runtime.** Owned by
  PR #125.
- **No community spaces / events runtime.** Owned by PR #126.
- **No AI Program Builder runtime.** Owned by PR #117.
- **No removal of `User.coach_id`.** Phase-2 cleanup, not v1. The
  Wave 2 schema keeps `User.coach_id` as a denormalized cache and
  uses `User.owning_membership_id` as the source of truth.
- **No changes to the existing Wave 1 admin console spec (PR
  #130).** The admin runtime gap letters reserved by Wave 2
  (§11.P–T) are added to `docs/admin/control-room-spec.md` in the
  *next* admin-spec PR, not this one.
- **No PR #127 / #128 disposition.** That decision is owned by the
  Wave 1 entry below; Wave 2 does not change it.

### What the next Computer should know

- The user is **Bradley Gleave** (`@BradleyGleavePortfolio`). He
  runs The Growth Project — a private high-touch coaching platform
  positioned as **"Whop AI for trainers, gyms, influencers, info-
  sellers/coaches — with sub-coach hierarchy."** The four-
  archetype frame and the sub-coach hierarchy are the irreducible
  product axes; everything in Wave 2 inherits them.

- **Strict rules from the user (carry over from Wave 1):**
  - Build to enterprise depth/quality.
  - Never use placeholder content without noting why/where in this
    file.
  - Optimize for user experience (operator UX in this case).
  - Stay draft, stay unmerged, never touch live apps without
    explicit approval.
  - No emoji. No `Coming Soon`. No `any` types. No `ts-ignore`. No
    invented data. No synthetic numbers in metrics screens.
  - Money is `Decimal(14,2)` end-to-end. AI calls use `sonar-pro`,
    never `sonar`. Audit row on every mutation. Append-only audit
    log.

- **Wave plan:**
  - **Wave 1** — admin console (PR #130, draft, unmerged, in
    `docs/admin/`). Five files: `README.md`,
    `control-room-spec.md`, `deployment-and-rbac.md`,
    `pr-sequence.md`, `screens-addendum.md`.
  - **Wave 2** — this PR. Seven files in `docs/product/`. Builds on
    Wave 1.
  - **Wave 3** — admin data-feed RFC for cohort drilldown
    (separate PR, branch `docs/wave-3-admin-data-feed`; one or two
    files in `docs/admin/`). Builds on Wave 1 and Wave 2.
  - **Wave 4** — mobile mirror of progression + onboarding
    (separate repo `growth-project-mobile`).
  - **Wave 5** — finance app sub-coach billing-split spec
    (separate repo `tgp-finance-app`).
  - Each wave updates this file when its work completes.

- **The next runtime PR off Wave 2 should be the data-tracking
  contract.** It is the single Wave-2 spec deployable independently
  of sub-coach hierarchy and progression — it adds events, deny-list
  entries, and `OnboardingProgress` / `CoachOnboardingProgress`
  tables, none of which require the org / progression schema. The
  runtime author should ship it first, behind a per-event `enabled`
  registry, so the operator has visibility into the existing
  funnel before the next runtime PR adds the org schema.

- **The single biggest spec is `sub-coach-hierarchy.md` (1074
  lines).** Read §12 (migration strategy) before lifting it; the
  three-step backfill + dual-write + flag-flip is the contract the
  runtime author is graded against.

---

## Session 2026-05-01 (early AM PDT) — Wave 1 admin console reconciliation

**Goal:** finish what the previous Computer was mid-build on when its
session was cut: reconciling the two competing admin console specs
(PR #127 and PR #128) into a single canonical source of truth.

**Status:** docs-only, draft, **NOT MERGED**. Sitting alongside #127
and #128 as a third draft PR. User instruction: stay unmerged
tonight; build to one-click-to-merge state.

This Wave 1 entry was authored against the
`docs/admin-console-canonical` branch (PR #130) and never landed on
`main` because the canonical PR remains open. The summary below is
preserved verbatim from that branch's `wave-context/PERP_HANDOFF.md`
for traceability:

### What was done

Created branch `docs/admin-console-canonical` from PR #128's branch
(`docs/admin-control-room-spec`). Adopted #128's
`docs/admin/control-room-spec.md` as the canonical primary spec
unchanged. Added four new doc files in `docs/admin/`:

| File | Lines | Purpose |
|---|---:|---|
| `README.md` | 36 | Index, supersedes #127, adopts #128 as primary |
| `control-room-spec.md` | 755 | Carried forward from #128 unchanged — the EHR control-room target shape, §11.A–O gap inventory, §17 7-week phased rollout |
| `deployment-and-rbac.md` | 157 | Migrated from #127 §1.3, §2, §11, §17 — deployment shape, auth, advisory client-side capability matrix, optional admin mobile companion wire contract |
| `pr-sequence.md` | 299 | Reconciles #127 §12 stale PR-numbered map with #128 §11 gap-letter inventory; allocates `TBD-admin-A..O` placeholder slots; phase rollup; explicit out-of-scope list |
| `screens-addendum.md` | 677 | The 9 screens from #127 §4 not covered in #128 §3-§10: AI & Audit, Reports & Exports, Privacy & GDPR, Feature Flags, Release & Readiness, Mastermind, plus 3 consumer-only (Marketplace, Payouts, Support) owned by other expansion PRs |

### Key reconciliation decisions

1. **#128 is canonical.** Its EHR control-room framing wins over
   #127's "web dashboard" framing. #128 also did the rigorous
   endpoint-gap inventory (§11.A–O) which is the contract future
   runtime PRs are graded against.

2. **PR #127's §12 PR-numbered map (#117–#126) is stale.** Those PR
   numbers are now used by other in-flight scopes (AI Program
   Builder, Team Mode, expansion roadmap, masterminds, coach-
   experience wave, commerce/marketplace, engagement/retention).
   The new `pr-sequence.md` allocates `TBD-admin-A` through
   `TBD-admin-O` placeholder slots instead of inventing collision-
   prone numbers.

3. **Recommended PR disposition:**
   - Close #127 unmerged with a comment pointing at this canonical
     PR.
   - Either merge #128 first then layer this PR on top (preserves
     git history) OR close #128 too and treat this as a complete
     replacement. **User decision required.**

4. **Three categories of cross-repo concern preserved:**
   - **Owned by admin console runtime PRs:** §11.A–O gap closures.
   - **Owned by other expansion PRs (admin console only consumes):**
     marketplace moderation (#125 commerce wave), payouts/disputes
     (Stripe Connect / commerce), support tickets (#126 engagement
     wave), feature flags (separate platform-readiness PR), AI cost
     tracking (separate AI infra PR), masterminds
     (`MastermindApplication` table — separate PR).
   - **Anti-scope:** no per-tenant scoping, no new auth model, no
     changes to `new-website`, no runtime/schema/migration/env/CI
     changes in this PR.

### Wave 1 placeholders (carried into Wave 2 unchanged)

- The `tgp-admin-web` frontend repo does not exist yet. Spec'd as
  next-step in `pr-sequence.md`. Cannot be created without user
  approval (new repo creation).
- The `ADMIN_CONSOLE_V2_ENABLED` feature flag is referenced in the
  spec but not added to backend env yet. Requires a tiny runtime
  PR — out of scope for the docs-only constraint.
- The `/api/admin/operators` endpoint that would server-enforce the
  capability matrix is reserved-name-only. The matrix is
  advisory/client-side until that endpoint ships. Documented.
- `X-Operator-Action` and `X-Operator-Surface` headers are spec'd
  but the backend doesn't yet echo them into audit metadata.
  Listed as a gap-closing requirement in `pr-sequence.md`.

The Wave 1 PR (#130) remains the canonical first read for any new
Computer session before touching either Wave 2 or any future wave.

---

## Session [previous] — what came before tonight

The previous Computer session opened a long string of draft expansion
PRs (#117 through #129 in `growth-project-backend`, #92–#97 in
`growth-project-mobile`, #106–#108 in `tgp-finance-app`) covering AI
Program Builder, Team Mode, masterminds + L1/L2/L3 SaaS tiers,
coach-experience wave, commerce/marketplace, engagement/retention,
and the original admin console specs (#127 + #128). All draft, all
unmerged, all CI green. None of them touched runtime code.

That session died right after opening #128 — likely a context limit
or session timeout. It was about to start runtime work behind an
`ADMIN_CONSOLE_V2_ENABLED` flag but never got there.

The Wave 1 session picked up the baton specifically on the
#127-vs-#128 reconciliation it left mid-pivot. The Wave 2 session
(this one) layers product specs on top of the resulting canonical
admin console spec.
