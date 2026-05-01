# PERP Handoff — Master Index

> **Purpose:** single canonical pointer to every spec PR opened during the
> 2026-04-30 → 2026-05-01 enterprise spec build. New Computer sessions and
> new senior engineers should start here.
> **Status:** docs only, **draft, NOT MERGED**. Designed to land **after** every
> wave PR below has merged so the per-wave `PERP_HANDOFF.md` files can
> consolidate into this index without conflicts.
> **Last updated:** 2026-05-01 (late PDT) — safety-update with Waves 6-10 plan while parity build is in flight

---

## How to read this file

1. Skim §1 to find the wave you care about.
2. Open that wave's PR; read the PR body for the wave-level summary.
3. Open the per-wave `PERP_HANDOFF.md` at the wave branch's repo root for the
   detailed session log (what was decided, what was deferred, what's next).
4. Open the spec docs themselves (linked from each wave's PR description) for
   the full enterprise-grade contract.

If you are a senior engineer onboarding to implement these specs, read in
order: [Wave 1] → [Wave 2 engine] → [Wave 2 rewards] → [Wave 3] → [Wave 4] →
[Wave 5]. Two hours of reading covers the foundation. Waves 6-10 (the Whop
AI parity layer — apps marketplace, public discovery, content rewards +
affiliate, storefront builder, native community RFC) are in flight as of
2026-05-01 late PDT and stack on top of Waves 1-5 (see §1B and §2B below).

---

## 1. The five foundation waves (all draft, none merged)

| Wave | PR | Repo | Branch | Lines | What it ships |
|---|---|---|---|---:|---|
| **Wave 1** | [#130](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/130) | `growth-project-backend` | `docs/admin-console-canonical` | 2,065 | Admin console canonical reconciliation. Supersedes PR #127, adopts PR #128 as canonical. Five files under `docs/admin/`. |
| **Wave 2** | [#132](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/132) | `growth-project-backend` | `docs/wave-2-product-specs` | 5,367 | Eight files under `docs/product/`: Whop-AI positioning, sub-coach hierarchy, retention engine, retention rewards layer, onboarding (clients + coaches), data-tracking contract. |
| **Wave 3** | [#131](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/131) | `growth-project-backend` | `docs/wave-3-admin-data-feed` | 2,388 | Three files under `docs/admin/`: data-feed RFC, glossary, handoff. Defines the cohort drilldown architecture, scope-stack, SSE/polling envelope, materialised views, capability hash cache keys. |
| **Wave 4** | [#98](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/98) | `growth-project-mobile` | `docs/wave-4-mobile-mirror` | 2,582 | Six files under `docs/product/`: mobile mirror for org mode, progression UX, onboarding flows, AI copilot. |
| **Wave 5** | [#109](https://github.com/BradleyGleavePortfolio/tgp-finance-app/pull/109) | `tgp-finance-app` | `docs/wave-5-finance-subcoach-billing` | 1,381 | Four files under `docs/billing/`: sub-coach billing split (Flow A + Flow B), finance org roll-ups. |

**Foundation total: 13,783 lines of spec across 5 draft PRs in 3 repos. Zero runtime changes. Zero migrations. Zero merges.** (Note: count above reflects original wave-1-through-5 scope; the Wave 2 surgical rewards-layer follow-up added ~303 lines bringing the shipped foundation total to ~14,086 lines as of 2026-05-01 late PDT.)

---

## 1B. Waves 6-10 — Whop AI parity layer (in flight, planned)

> **Status as of 2026-05-01 late PDT:** five Opus 4.7 codebase subagents are
> running in parallel against fresh `/tmp/gpb-w{6..10}/` clones. PRs below
> will be opened **draft** against the same three repos. This section is a
> **safety-fallback plan** — recorded here in case any subagent fails to
> complete or any PR has to be re-opened from scratch. Once subagents return,
> §1B will be revised in place to point at the actual PR numbers and final
> line counts.
>
> **Why these five waves exist:** after Waves 1-5 locked the foundation
> (positioning, sub-coach hierarchy, retention engine + rewards, admin
> data-feed, mobile mirror, finance billing split), the OWNER asked "what
> more would need integrated to be full Whop AI level?" Research against
> Whop's public surface (apps marketplace, Discover, Content Rewards, MCP
> server, storefront block builder, native chat/community) identified five
> capability gaps. Waves 6-10 close them as docs-only spec PRs at the same
> 15-section enterprise-depth bar as Waves 1-5.

| Wave | Repo(s) | Branch(es) | Target lines | Planned deliverable summary |
|---|---|---|---:|---|
| **Wave 6** App architecture + SDK + manifest spec | `growth-project-backend` | `docs/wave-6-app-architecture-sdk` | ~5,000 | `docs/apps/`: README, architecture (iframe sandbox vs server runtime), manifest-spec (signed JSON manifest, permission model, version pinning), sdk-spec (typed client surface, hooks for retention/rewards/sub-coach data), installation-and-billing (per-app revenue split, Stripe Connect routing), developer-portal-and-review (submission, review SLA, reject reasons, sandbox), mcp-server-spec (MCP exposure of admin data-feed read-models). **Foundation for Wave 9 custom blocks.** |
| **Wave 7** Public discovery / marketplace spec | `growth-project-backend` | `docs/wave-7-discovery-marketplace` | ~5,000 | `docs/discovery/`: README, public-directory (coach + app cards, archetype/niche/geo filters), recommendation-engine (cold-start fallback, view-to-purchase ranking, freshness decay), featured-placements (paid + editorial slots, anti-spam), buyer-funnel (landing → coach card → checkout, attribution), api-and-mobile (mobile parity surfaces), trust-and-safety (transformation-photo policy, refund-rate gating, banned-claims list). |
| **Wave 8** Content Rewards + Affiliate program (TWO PRs) | `growth-project-backend` + `tgp-finance-app` | `docs/wave-8-content-rewards-affiliate` (backend) + `docs/wave-8-payout-extensions` (finance) | ~5,500 (combined) | Backend `docs/content-rewards/` (UGC reward pools, view-verification trust ladder, anti-fraud thresholds, leaderboards) + `docs/affiliate/` (referral codes, attribution window, commission tiers, multi-level recommendation = single-level v1 / two-level v2). Finance `docs/billing/content-rewards-payouts.md` + `docs/billing/affiliate-payouts.md` (Decimal(14,2) payout extensions, Stripe Connect routing, 1099 thresholds, clawback rules). |
| **Wave 9** Storefront block builder + funnel analytics | `growth-project-backend` | `docs/wave-9-storefront-builder` | ~4,500 | `docs/storefront/`: README, block-editor (drag-and-drop block tree, validation, undo/redo), block-types-catalog (hero, pricing-table, testimonial, FAQ, embed, custom-via-app-manifest), publishing (draft → preview → publish lifecycle, SEO SSR), funnel-analytics (block-level CTR, conversion attribution to Wave 7 buyer funnel), integration-with-apps (Wave 6 manifest custom blocks). **Depends on Wave 6.** |
| **Wave 10** Native chat / community decision RFC + spec | `growth-project-backend` | `docs/wave-10-community` | ~4,500 | `docs/community/`: README, doctrine-decision-rfc (THREE options A=full reactions+presence, B=limited reactions only [recommended], C=text+threads only — re-opens PR #90 streak/social-proof doctrine collision), channel-and-thread (channel taxonomy, thread depth, permissions), voice-notes (recording, transcription via sonar-pro, accessibility), moderation (auto-flag rules, OWNER review queue, ban ladder), integration-with-discord (federated bridge for coaches who already run Discord). **Highest-stakes OWNER question of the parity set.** |

**Planned parity total (estimated): ~24,500 lines across 6 PRs in 2 repos.**
**Combined shipped foundation + planned parity: ~38,500 lines across 11 draft PRs in 3 repos.**

### Critical decisions each wave will surface to the OWNER

- **Wave 6:** iframe sandbox vs server-side runtime; manifest signing key custody; per-app revenue split %; review SLA + sandbox lifecycle.
- **Wave 7:** cold-start ranking signal, trust-badge issuance criteria, transformation-photo policy (consent + retention), pricing display (range vs exact), geo-targeting precision.
- **Wave 8:** view-verification trust ladder thresholds, anti-fraud auto-disqualify rules, multi-level affiliate Y/N (recommend single-level v1, two-level v2), commission attribution window length, clawback rules on refund/chargeback.
- **Wave 9:** custom-block extensibility surface, custom-HTML escape policy (likely no in v1), A/B test scope v1, SEO SSR vs static.
- **Wave 10:** **Option A/B/C for chat reactions and social-proof exposure** (this re-opens the PR #90 streak doctrine collision and is the single highest-stakes question across the parity set); voice-note retention; moderation queue ownership; Discord federation depth (read-only mirror vs bidirectional).

### Subagent IDs in flight (for cross-session continuity if this session ends)

- `wave_6_app_architecture_sdk_mon8thiy` — Wave 6
- `wave_7_discovery_marketplace_mon8thj9` — Wave 7
- `wave_8_content_rewards_affiliate_mon8thjj` — Wave 8 (two PRs)
- `wave_9_storefront_builder_funnel_analytics_mon8thjs` — Wave 9
- `wave_10_community_decision_spec_mon8thk3` — Wave 10

Shared context the subagents read: `wave-context/SHARED_CONTEXT_W6_W10.md` in
the primary agent's workspace (positioning, hard rules, 15-section enterprise
template, per-wave §8 deliverable bullets).

---

## 2. Recommended merge order

Hard dependencies dictate the order. Do **not** merge any of these without an
explicit OWNER approval — they were built tonight on the user instruction
"build to a one-click-to-merge state, but stay unmerged tonight."

```
  Wave 1  ────►  Wave 3  ────────────────────────────────────────►  (consolidated handoff index)
    │
    └──►  Wave 2  ────►  Wave 5  ────►  Wave 4
                  │                       │
                  │                       └──►  Wave 7  (discovery / marketplace)
                  │                                │
                  └──►  Wave 6  (apps + SDK)  ────┼──►  Wave 8  (content rewards + affiliate)
                                  │                │
                                  └──►  Wave 9  (storefront blocks)
                                                   │
                                                   └──►  Wave 10  (community RFC; re-opens PR #90 doctrine)
```

**Why this order:**

1. **Wave 1 first.** Admin console canonical reconciliation. Other waves
   reference `docs/admin/control-room-spec.md` and the deployment-and-RBAC
   capability matrix.
2. **Wave 2 second.** Sub-coach hierarchy is the central schema change every
   downstream wave touches. The retention engine + rewards layer can ship
   after sub-coach if needed (they are in the same PR).
3. **Wave 3 third (parallel-safe with Wave 2).** Admin data-feed RFC
   references Wave 1 (capabilities) and Wave 2 (archetype column,
   sub-coach hierarchy, retention rollups). Architecturally independent of
   Wave 4/5.
4. **Wave 5 fourth.** Sub-coach billing split depends on Wave 2 sub-coach
   hierarchy. Independent of Wave 4.
5. **Wave 4 last (of foundation).** Mobile mirror references all of Wave 1
   (admin capabilities visible in mobile owner mode), Wave 2 (every
   client/coach surface), and Wave 5 (org revenue roll-ups screen consumes
   Wave 5 endpoints).

### 2B. Parity layer merge order (Waves 6-10)

6. **Wave 6 (apps + SDK + manifest).** Must merge before Wave 9 because
   Wave 9 storefront custom blocks consume the manifest contract. Independent
   of Waves 7 and 8.
7. **Wave 7 (discovery).** Depends on Wave 2 archetype + sub-coach data and
   Wave 1 admin capabilities. Independent of Waves 6, 8, 9.
8. **Wave 8 (content rewards + affiliate).** Backend half depends on Wave 2
   (sub-coach attribution) and Wave 7 (buyer funnel attribution). Finance
   half depends on Wave 5 (Decimal(14,2) payout primitive) and Wave 8
   backend.
9. **Wave 9 (storefront).** Depends on Wave 6 (manifest custom blocks) and
   Wave 7 (funnel analytics integration).
10. **Wave 10 (community RFC + spec).** Independent of 6/7/8/9 in delivery,
    but the doctrine decision (Option A/B/C) re-opens PR #90 and **must**
    have explicit OWNER sign-off on the chosen option before any runtime
    work starts in this area. The RFC ships first; the spec details only
    finalise after the OWNER picks A, B, or C.

**This index merges last,** after the per-wave `PERP_HANDOFF.md` files have
been folded into one place by whoever does the merges.

---

## 3. Cross-repo dependency map

```
growth-project-backend (docs/)
  ├── admin/control-room-spec.md  ← Wave 1
  ├── admin/data-feed-rfc.md       ← Wave 3 (depends on Wave 1)
  ├── product/sub-coach-hierarchy.md           ← Wave 2 (central)
  ├── product/retention-progression-system.md   ← Wave 2 (engine)
  ├── product/retention-progression-rewards.md  ← Wave 2 (rewards layer; OWNER decisions)
  ├── product/positioning-whop-ai-for-coaches.md ← Wave 2
  ├── product/onboarding-{clients,coaches}.md   ← Wave 2
  └── product/data-tracking-contract.md        ← Wave 2

growth-project-mobile (docs/product/)
  ├── role-experience-extension-org-mode.md     ← Wave 4 (consumes Wave 2 sub-coach + Wave 5 org rollups)
  ├── progression-mobile-ux.md                  ← Wave 4 (consumes Wave 2 retention engine + rewards)
  ├── onboarding-mobile-flows.md                ← Wave 4 (consumes Wave 2 onboarding)
  └── whop-ai-coach-copilot-mobile.md           ← Wave 4 (consumes Wave 2 positioning)

tgp-finance-app (docs/billing/)
  ├── sub-coach-billing-split-spec.md           ← Wave 5 (consumes Wave 2 sub-coach)
  ├── finance-org-roll-ups.md                   ← Wave 5 (produces signal for Wave 2 retention MRR composites)
  ├── content-rewards-payouts.md                ← Wave 8 (planned; consumes Wave 5 payout primitive)
  └── affiliate-payouts.md                      ← Wave 8 (planned; consumes Wave 5 payout primitive)

growth-project-backend (parity layer, planned)
  ├── apps/{architecture,manifest-spec,sdk-spec,installation-and-billing,developer-portal-and-review,mcp-server-spec}.md  ← Wave 6
  ├── discovery/{public-directory,recommendation-engine,featured-placements,buyer-funnel,api-and-mobile,trust-and-safety}.md  ← Wave 7
  ├── content-rewards/*.md + affiliate/*.md     ← Wave 8 backend half
  ├── storefront/{block-editor,block-types-catalog,publishing,funnel-analytics,integration-with-apps}.md  ← Wave 9 (depends on Wave 6 manifest)
  └── community/{doctrine-decision-rfc,channel-and-thread,voice-notes,moderation,integration-with-discord}.md  ← Wave 10
```

---

## 4. The product positioning that drives everything

> **"Whop AI for trainers, gyms, influencers, and info-sellers / coaches —
> with sub-coach hierarchy."**

Four buyer archetypes: solo trainers, gyms (multi-trainer), influencers
(audience-monetization), info-sellers/coaches (recurring relationship beyond
a course). Sub-coach hierarchy: head coach → sub-coaches → clients. Two
billing flows: Flow A (separate per-coach Stripe), Flow B (head coach pays
platform + Stripe Connect transfers to sub-coaches).

The retention progression system is **outcome-anchored**, not tenure-named.
Adapted from the Iman Gadzhi *Digital Launchpad* operator transcript onto The
Growth Project's "right-fit member, not buyer" CEO doctrine. See
[`docs/product/retention-progression-system.md`](./product/retention-progression-system.md)
(engine) and
[`docs/product/retention-progression-rewards.md`](./product/retention-progression-rewards.md)
(OWNER-decided rewards).

---

## 5. OWNER-decided rewards layer (locked 2026-05-01 late PDT)

Recorded in detail in `docs/product/retention-progression-rewards.md` (Wave 2
PR #132). Summary:

**Coach tenure ladder (Track A, M1–M36):**
M1 onboarding call · M3 up-to-20 funnel leads · M6 mastermind invite · M9
Coach Spotlight · M12 funnel audit + tier-aware annual lock-in · M18 priority
requests + quarterly OWNER 1-on-1 · M24 lifetime locked pricing + lifetime
referral revshare · M36 in-person retreat invite.

**Coach achievement ladder (Track B, composite milestones):**
First Win → Trusted (10 retained >60d) → Builder (25 active OR $5K MRR) →
Operator (50 active OR $10K MRR OR first sub-coach) → Authority (100 active
OR $25K MRR) → Top Performer (top 10 retention 90d) + Comeback Coach +
Referrer.

**Tier-overlap policy:** a coach who earns Authority but pays for a lower
tier receives a one-time taste of the next tier as a soft upsell. The
achievement track and the pricing tier interact in exactly one place
(`RewardOverlapPolicy`).

**Client three-track model (same-coach scoped; no free months, no
discounts, no streak counters surfaced to UI):**
1. **Consistency** — Showing Up (7d) → Locked In (30d) → Disciplined (90d) →
   Relentless (180d) → Year One (365d).
2. **Outcome** — OS-app-specific milestones reward shareable milestone reels
   the client posts to their own social, tagging coach.
3. **Community** — same-coach cohort contributions (Helper, Cheerleader,
   Cohort Lead, Ambassador). Depends on Wave 4 cohort feed surface.

**Year One — the one cross-coach exception in the entire client experience:**
365 days with their coach + activity marker → golden ticket to a premium TGP
retreat (upsell, NOT a free retreat) + admission to a private TGP-moderated
cross-coach chat (status only, no comp data, coaches do not have visibility) +
a special social cue on profile and cohort feed.

---

## 6. Open OWNER decisions (deferred, with recommendations)

These are deferred deliberately. Each has a recommendation in the linked
spec; none of them block Day-1 commit sequences.

### Wave 1 (admin console)
- (none — Wave 1 is canonical reconciliation only)

### Wave 2 (product) — see `docs/product/retention-progression-rewards.md` §7
1. Lifetime-locked-pricing terms when TGP raises base prices later
2. Mastermind cadence + host (recommendation: quarterly, OWNER for first 4 cohorts)
3. Retreat cost model (recommendation: hybrid)
4. Cohort feed UX in mobile (recommendation: full feed in v1; otherwise Track 3 ships v2)
5. Year One activity-marker threshold (recommendation: active in 4 of last 8 weeks)
6. Year One golden ticket: single vs annual-recurring (recommendation: single per milestone, refires on Year-Two renewal)
7. Top Performer reward content (recommendation: free month + leaderboard placement on coach directory + shoutout)
8. "Qualifying lead" definition for Month-3 (recommendation: archetype/niche match + geo target if specified + no other coach grant in past 90d)
9. Tier-overlap "exec review taste" copy
10. Charter Members vs Year One relationship (locked: a user can hold both)

Plus 10 placeholders inherited from the main Wave 2 spec (default seat caps,
first-win window, reminder cadences, bucket boundaries, HMAC hash secret,
`reason_category` enumeration, per-archetype profile required-fields,
per-archetype invite-link copy, info-seller "Accountability container"
template, goal-direction inference vs explicit enum).

### Wave 3 (admin data feed) — see `docs/admin/data-feed-rfc.md` §19
8 high-stakes (Q1 endpoint shape, Q4 materialised views, Q5 archetype column
placement, Q7 capability enforcement timing, Q9 cache TTLs, Q11 versioning,
Q13 timezones, Q14 bulk-export rate limit) + 7 lower-stakes — each carries an
explicit recommendation in the RFC.

### Wave 4 (mobile)
Eleven push topic names, AI disclaimer corpus (server-rendered), push body
strings (server-rendered), four reserved route names
(`CreateCoachAccount`/`LevelUpAck`/`Progression`/`FirstWinAck`).

### Wave 5 (finance)
Flow B Connect-account model (fully-revealed coach Stripe Express vs platform
Custom), customer re-confirmation copy on A→B subscription migration
(compliance-pending), OWNER admin endpoints for the three non-default refund
strategies.

### Waves 6-10 (parity layer, planned — full lists land when subagents return)

High-stakes decisions previewed:

- **Wave 6:** iframe sandbox vs server-side app runtime · manifest signing
  key custody · per-app revenue split · review SLA + sandbox lifecycle.
- **Wave 7:** cold-start ranking signal · trust-badge criteria · transformation-photo
  consent and retention policy · pricing display (range vs exact) · geo-targeting precision.
- **Wave 8:** view-verification trust ladder · anti-fraud thresholds ·
  multi-level affiliate Y/N (recommend single-level v1, two-level v2) ·
  commission attribution window · clawback rules on refund/chargeback.
- **Wave 9:** custom-block extensibility surface · custom-HTML escape policy
  (likely no in v1) · A/B test scope v1 · SEO SSR vs static.
- **Wave 10:** Option A/B/C for chat reactions + social-proof exposure (this
  re-opens PR #90 doctrine and is the single highest-stakes OWNER question
  across the parity set) · voice-note retention · moderation queue ownership
  · Discord federation depth (read-only mirror vs bidirectional).

---

## 7. Hard rules in force across all waves (carried forward)

These are NOT placeholders or recommendations. They are constraints every
runtime PR MUST respect.

1. **Money is `Decimal(14,2)` end-to-end.** No exceptions. The
   `@SkipDecimalNormalisation()` decorator exists for the few payloads that
   intentionally hold cents-as-int (e.g. `lifetime_pricing_lock.locked_monthly_cents`).
2. **AI calls use `sonar-pro`, not `sonar`.** Verified at the LLM client
   layer.
3. **Audit row on every mutation.** Append-only. Audit rows are NEVER deleted.
   Per `docs/audit-and-gdpr.md`.
4. **No PII in PostHog properties.** HMAC-hash sensitive target ids; bucket
   amounts/tokens/body-length. Per `docs/metrics.md` and the Wave 2
   data-tracking contract.
5. **No emoji in any user-facing copy.** No "Coming Soon". No AI-sounding
   filler. No `any` types in TypeScript. No `ts-ignore`. Quiet luxury voice
   per `docs/QUIET_LUXURY_DOCTRINE.md` (mobile).
6. **No streak counters surfaced to UI.** The Consistency track in the
   rewards layer computes streaks internally but presents milestone names.
   PR #90 doctrine preserved.
7. **No invented data, no synthetic numbers in metrics.** When a number is
   genuinely unknown (e.g. retreat seat count not yet decided), the spec says
   "TBD" with a § reference to the deferred-decisions section.
8. **Cross-coach client visibility is forbidden** — except the one Year One
   private chat channel (§5 above). Any future code that introduces another
   cross-coach surface MUST justify the breach in its PR description and add
   a new audit-action constant for it.
9. **Spec PRs are docs-only.** No `src/`, no migrations, no env, no CI, no
   `package.json` changes. This is the non-negotiable boundary between spec
   and runtime work.
10. **All five wave PRs stay DRAFT until OWNER approves.** "Build to
    one-click-to-merge state, but stay unmerged tonight" was the explicit
    OWNER instruction.

---

## 8. The senior-engineer onboarding checklist

A senior engineer joining tonight's spec build should be able to:

- [ ] Read this file end-to-end in 10 minutes.
- [ ] Open each of the 5 wave PRs and skim the PR body — total ~30 minutes.
- [ ] Read the Wave 2 sub-coach-hierarchy spec front-to-back — ~25 minutes
      (1,074 lines; this is the central change).
- [ ] Read the Wave 2 retention engine + rewards layer — ~40 minutes (937 +
      720 lines).
- [ ] Read the Wave 3 data-feed RFC — ~25 minutes (1,794 lines, but mostly
      reference tables and §19 open questions).
- [ ] Skim the Wave 4 mobile spec — ~20 minutes (every section maps to a
      backend contract from Wave 2).
- [ ] Skim the Wave 5 finance billing spec — ~15 minutes.
- [ ] Cross-reference the hard rules in §7 above against any RFC they intend
      to revise — every rule has a code-level hook.

**Total budget: ~3 hours of reading. After that the engineer should be able
to start writing the runtime PR for any one wave.**

---

## 9. Per-wave handoff log pointers

Each wave branch carries its own `PERP_HANDOFF.md` at the repo root with the
detailed session log. When the waves merge, those files consolidate into a
single `PERP_HANDOFF.md` that supersedes this index. Until then:

- Wave 1: [`docs/admin-console-canonical:PERP_HANDOFF.md`](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/docs/admin-console-canonical/PERP_HANDOFF.md)
- Wave 2: [`docs/wave-2-product-specs:PERP_HANDOFF.md`](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/docs/wave-2-product-specs/PERP_HANDOFF.md)
- Wave 3: [`docs/wave-3-admin-data-feed:PERP_HANDOFF.md`](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/docs/wave-3-admin-data-feed/PERP_HANDOFF.md)
- Wave 4: [`docs/wave-4-mobile-mirror:PERP_HANDOFF.md`](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/docs/wave-4-mobile-mirror/PERP_HANDOFF.md)
- Wave 5: [`docs/wave-5-finance-subcoach-billing:PERP_HANDOFF.md`](https://github.com/BradleyGleavePortfolio/tgp-finance-app/blob/docs/wave-5-finance-subcoach-billing/PERP_HANDOFF.md)

**Waves 6-10 handoff log pointers (placeholders — populated when subagents return):**

- Wave 6: `docs/wave-6-app-architecture-sdk:PERP_HANDOFF.md` (growth-project-backend)
- Wave 7: `docs/wave-7-discovery-marketplace:PERP_HANDOFF.md` (growth-project-backend)
- Wave 8 backend: `docs/wave-8-content-rewards-affiliate:PERP_HANDOFF.md` (growth-project-backend)
- Wave 8 finance: `docs/wave-8-payout-extensions:PERP_HANDOFF.md` (tgp-finance-app)
- Wave 9: `docs/wave-9-storefront-builder:PERP_HANDOFF.md` (growth-project-backend)
- Wave 10: `docs/wave-10-community:PERP_HANDOFF.md` (growth-project-backend)

---

## 10. Provenance

- **Built:** 2026-04-30 evening through 2026-05-01 late evening (PDT).
- **Builder:** Perplexity Computer (Opus 4.7 subagents for the heavy spec
  authoring, primary agent for review + reconciliation + the rewards-layer
  follow-up).
- **OWNER instruction stack (verbatim, preserved across summarizations):**
  - "All work here stays unmerged, not touching live apps for tonight."
  - "Don't make it live though — build to enterprise scale, think 'I need to
    operate as the tech lead for 3 senior engineers.' Make this product
    amazing."
  - "Build to enterprise depth/quality, think bigger — never use placeholder
    stuff without noting why/where in README — optimize for user experience."
- **Tonight's late-PDT addendum (the rewards-layer decisions):**
  documented in full in `docs/product/retention-progression-rewards.md`. Year
  One golden ticket = upsell to premium retreat + private TGP chat + special
  social cue. Tier-overlap = generous taste of next tier as upsell hook for
  lower-paying coaches; gracious acknowledgement only for white-glove +
  Authority overlap.
- **Tonight's late-PDT parity directive:** OWNER asked "what more would need
  integrated to be full Whop AI level?" After research against Whop's public
  surface (apps marketplace, Discover, Content Rewards, MCP server,
  storefront block builder, native chat/community), five gaps were
  identified. OWNER directive: "hit all of this now." Five Opus 4.7 codebase
  subagents (Waves 6-10) launched in parallel at the same 15-section
  enterprise-depth bar as Waves 1-5. This index will be updated in place
  with actual PR numbers and line counts when the subagents return.

End of index.
