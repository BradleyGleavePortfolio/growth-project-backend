# PERP Handoff — Master Index

> **Purpose:** single canonical pointer to every spec PR opened during the
> 2026-04-30 → 2026-05-01 enterprise spec build. New Computer sessions and
> new senior engineers should start here.
> **Status:** docs only, **draft, NOT MERGED**. Designed to land **after** every
> wave PR below has merged so the per-wave `PERP_HANDOFF.md` files can
> consolidate into this index without conflicts.
> **Last updated:** 2026-05-01 — final Waves 1-10 map.

---

## How to read this file

1. Skim §1 to find the wave you care about.
2. Open that wave's PR; read the PR body for the wave-level summary.
3. Open the per-wave `PERP_HANDOFF.md` at the wave branch's repo root for the
   detailed session log (what was decided, what was deferred, what's next).
4. Open the spec docs themselves (linked from each wave's PR description) for
   the full enterprise-grade contract.

If you are a senior engineer onboarding to implement these specs, read in
order: Wave 1 (admin) → Wave 2 (positioning, hierarchy, retention engine,
rewards) → Wave 3 (admin data-feed) → Wave 4 (mobile) → Wave 5 (finance
billing). That covers the foundation. Then Waves 6-10 (the Whop-AI parity
layer): Wave 6 (apps + SDK + manifest + MCP) → Wave 7 (discovery) →
Wave 8 (content rewards + affiliate) → Wave 9 (storefront builder) →
Wave 10 (community RFC).

---

## 1. The ten waves — final PR map

### 1A. Foundation (Waves 1-5)

| Wave | PR | Repo | Branch | Lines | What it ships |
|---|---|---|---|---:|---|
| **Wave 1** | [#130](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/130) | `growth-project-backend` | `docs/admin-console-canonical` | 2,065 | Admin console canonical reconciliation. Supersedes #127, adopts #128 as canonical. Five files under `docs/admin/`. |
| **Wave 2** | [#132](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/132) | `growth-project-backend` | `docs/wave-2-product-specs` | 5,367 | Eight files under `docs/product/`: Whop-AI positioning, sub-coach hierarchy, retention engine, retention rewards layer, onboarding (clients + coaches), data-tracking contract. |
| **Wave 3** | [#131](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/131) | `growth-project-backend` | `docs/wave-3-admin-data-feed` | 2,388 | Three files under `docs/admin/`: data-feed RFC, glossary, handoff. Cohort drilldown architecture, scope-stack, SSE/polling envelope, materialised views, capability hash cache keys. |
| **Wave 4** | [#98](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/98) | `growth-project-mobile` | `docs/wave-4-mobile-mirror` | 2,582 | Six files under `docs/product/`: mobile mirror for org mode, progression UX, onboarding flows, AI copilot. |
| **Wave 5** | [#109](https://github.com/BradleyGleavePortfolio/tgp-finance-app/pull/109) | `tgp-finance-app` | `docs/wave-5-finance-subcoach-billing` | 1,381 | Four files under `docs/billing/`: sub-coach billing split (Flow A + Flow B), finance org roll-ups. |

**Foundation total: ~13,783 lines of spec across 5 draft PRs in 3 repos.**

### 1B. Whop-AI parity layer (Waves 6-10)

| Wave | PR | Repo | Branch | Lines | What it ships |
|---|---|---|---|---:|---|
| **Wave 6** | [#136](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/136) | `growth-project-backend` | `docs/wave-6-app-architecture-sdk` | 4,101 | Eight files under `docs/apps/`: hybrid runtime (iframe + server), manifest spec (signed JSON, KMS custody, capability scopes, surface declarations, monetization), SDK surface (TS client, hooks, auth, rate limits, webhooks), install/billing (per-app split, Stripe Connect routing), developer portal & review SLA, MCP server spec for AI agents over admin data-feed. |
| **Wave 7** | [#134](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/134) | `growth-project-backend` | `docs/wave-7-discovery-marketplace` | 4,848 | Eight files under `docs/discovery/`: public coach + app cards, 50-niche taxonomy, hybrid embedding recommendation engine with cold-start + warm ranking + freshness decay, paid + editorial featured placements, buyer funnel attribution (30-d last-touch), trust & safety (verified achievements, testimonial consent, photo retention, banned claims, refund-rate auto-suspend), REST API + mobile parity. |
| **Wave 8** | [#138](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/138) | `growth-project-backend` | `docs/wave-8-content-rewards-affiliate` | 3,625 | Eight files across `docs/content-rewards/` + `docs/affiliate/`: ContentReward + ContentSubmission models with view-verification trust ladder, content-reward payout pipeline, UGC → coach attribution; AffiliateProgram/Account/Link/Click/Conversion/Commission models, 30-d last-touch attribution, single-level v1 commission, self-referral detection, refund/clawback, full Stripe Connect payout pipeline (sweep → preflight → dispatch → reconcile), KYC + 1099/W8 gates. |
| **Wave 9** | [#137](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/137) | `growth-project-backend` | `docs/wave-9-storefront-builder` | 5,381 | Seven files under `docs/storefront/`: block tree editor (validation, undo/redo, autosave, collab lock, a11y, mobile breakpoints), 11 canonical block types + custom-via-app, draft/preview/publish lifecycle with version snapshots and rollback, ISR-based SEO SSR, block-level funnel analytics with Wave 7 attribution cross-link, Wave 6 manifest custom-block iframe sandbox + postMessage protocol. |
| **Wave 10** | [#135](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/135) | `growth-project-backend` | `docs/wave-10-community` | 4,491 | Seven files under `docs/community/`: doctrine-collision RFC (A=full Whop reactions, B=limited acknowledgement-only [recommended], C=text+threads only) re PR #90, channel & thread spec, voice notes (sonar-pro transcription, 90-d retention), moderation & ban ladder, Discord federation (read-only v1, bidirectional v2). |

**Parity total: ~22,446 lines across 5 draft PRs in 1 repo.**

### 1C. Master index PR

| PR | Repo | Branch | Purpose |
|---|---|---|---|
| [#133](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/133) | `growth-project-backend` | `docs/perp-handoff-master` | This file. Merges last after all wave PRs land. |

---

**Combined foundation + parity: ~36,229 lines across 11 draft PRs in 3 repos. Zero runtime changes. Zero migrations. Zero merges.**

---

## 2. Dependency graph & recommended merge order

```
                    Wave 5 (finance) ────┐
Wave 1 (admin) ──────┐                   │
Wave 2 (product) ────┼─→ Wave 3 ─→ Wave 4 (mobile mirror)
                     │
                     └─→ Wave 6 (apps) ──→ Wave 9 (storefront)
                                       └─→ Wave 7 (discovery) ──┐
                                                                 ├─→ Wave 8 (rewards + affiliate)
                                       └─→ Wave 10 (community) ──┘
                                                                 │
                                                          PR #133 (this index, merges last)
```

Recommended merge order:

1. **Wave 1** (admin canonical) — supersedes #127, adopts #128.
2. **Wave 2** (product foundation) — establishes positioning, sub-coach hierarchy, retention engine + rewards.
3. **Wave 5** (finance billing split) — independent of admin/data-feed; can ship in parallel with 2/3.
4. **Wave 3** (admin data-feed) — depends on Wave 1's admin shell + Wave 2's hierarchy.
5. **Wave 4** (mobile mirror) — depends on Wave 2's product specs.
6. **Wave 6** (apps + SDK + manifest + MCP) — depends on Wave 2 (Coach/Org) and Wave 3 (admin data-feed read-models for MCP).
7. **Wave 7** (discovery marketplace) — depends on Wave 2 (sub-coach hierarchy) + Wave 6 (apps).
8. **Wave 10** (community RFC) — depends on Wave 2 (sub-coach + retention). Can ship before or after 7-9 since it is doctrine-decision-first.
9. **Wave 9** (storefront builder) — depends on Wave 6 (custom blocks via manifest) + Wave 7 (buyer funnel).
10. **Wave 8** (content rewards + affiliate) — depends on Wave 5 (Stripe Connect), Wave 7 (buyer funnel ledger). Can ship in parallel with 9.
11. **PR #133** (this index) — last.

The five parity PRs (6-10) can be reviewed in parallel; their merge order matters only for cross-references and the eventual master-index consolidation.

---

## 3. OWNER decisions surfaced — across all waves

The waves intentionally do **not** decide for the OWNER on the questions
below. Each is tagged `OWNER_DECISION` in its source spec with options +
recommendation. None block implementation; all can be flipped pre-GA.

### Wave 6 (apps)
- Runtime model: iframe sandbox vs server runtime vs **hybrid (recommended)**.
- Manifest signing key custody: AWS KMS vs Vault vs in-process — **recommend KMS**.
- Per-app revenue split — recommend 70/30 dev/platform with first $1k/mo free.
- Review SLA — recommend 5 business days.
- Sandbox resource quotas (CPU sec/req, memory MB, network bytes/day).

### Wave 7 (discovery)
- Embedding model — **hybrid (text-embedding-3-large + local pgvector)**.
- Attribution window — **30-day last-touch**.
- Featured-slot pricing — **flat tier with cap**.
- Refund-rate auto-suspend threshold — **8% trailing 90-day**.
- Transformation-photo retention — **30-day post-revocation hold**.
- Crawler indexing — opt-out default.
- Geo unit — locale-based.
- Sub-coach surfacing — bundled under parent.

### Wave 8 (content rewards + affiliate)
- Content-rewards platform fee — **5%**.
- View-verification trust ladder — auto <$50 / OAuth >$50 / manual >$500.
- 1099 trigger — **$600 trailing 12mo**.
- Clawback window — **90 days**.
- Affiliate attribution window — **30-day last-touch**.
- Multi-level — **single-level v1**.
- Default commission — **20% flat, configurable per program**.
- Self-referral — strict on payment-method + heuristic on IP/device.
- Cookie consent fallback — cookie + server-side ledger.
- Min payout threshold — **$50**.
- Payout cadence — **monthly on the 7th**.
- KYC provider — Stripe Connect Express.
- Pre-dispatch hold — 24h.
- Bot-click filter — hybrid edge + async sweep.

### Wave 9 (storefront)
- Custom-HTML escape — **NO arbitrary HTML in v1**, embed allowlist only.
- A/B test scope v1 — **page-level only**.
- SEO render — **ISR**.
- Image CDN — **Cloudflare Images**.
- Version retention — **30 versions per page**.

### Wave 10 (community)
- **THE highest-stakes decision in the parity set: A vs B vs C reactions/feed/streak doctrine.** Recommend **B (limited acknowledgement-only)**.
- Voice-note retention — **90 days**.
- Voice-note max length — **5 min**.
- Discord bridge depth — **read-only v1, bidirectional v2**.
- Moderation queue ownership — platform with per-coach escalation.
- DM scope v1 — **1:1 coach↔client only**, no group DMs.

Note: Wave 1 (admin) and Wave 2 (product foundation) are decisive — no
open OWNER_DECISION tags by design (those decisions were made up-front
when the foundation was established). `TBD-admin-A..O` slots inside
Wave 1 are intentional PR-slot identifiers (forward links to future
runtime PRs), not unfilled placeholders.

---

## 4. Status snapshot (as of 2026-05-01)

All 11 PRs are **draft, NOT MERGED**. CI is docs-only and passes on every
wave PR. No runtime changes anywhere; `prisma/schema.prisma` is untouched
in every backend PR (schema deltas are illustrative inside fenced
```prisma blocks within `.md` files).

| Wave | PR | Draft? | Notes |
|---|---|---|---|
| 1 | #130 | yes | Supersedes #127, adopts #128 |
| 2 | #132 | yes | Foundation |
| 3 | #131 | yes | |
| 4 | mobile #98 | yes | Mobile repo |
| 5 | finance #109 | yes | Finance repo |
| 6 | #136 | yes | New |
| 7 | #134 | yes | New |
| 8 | #138 | yes | New. Finance-half deferred to a separate Wave 8 finance branch (not in this batch) |
| 9 | #137 | yes | New |
| 10 | #135 | yes | New. Lead with A/B/C OWNER decision |
| index | #133 | yes | This file. Merges last |

---

## 5. Cross-repo dependency map

```
                    growth-project-backend
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
  Waves 1-3, 6-10        (this index)        Wave 4 (mirror to)
                                                     │
                                                     ▼
                                         growth-project-mobile
                                            (PR #98 + future
                                             mobile parity work)

                              │
                              │ Wave 5 (cross-repo)
                              ▼
                       tgp-finance-app
                          (PR #109 + planned
                           Wave 8 finance-half
                           branch — not yet created)
```

**Outstanding cross-repo work not yet a draft PR:**

- `tgp-finance-app/docs/wave-8-payout-extensions` (Wave 8 finance half) —
  Decimal(14,2) Stripe Connect routing extensions for content-reward
  payouts and affiliate commissions. The orchestration/contract is
  specified in this batch's Wave 8 backend PR (#138); the finance-side
  implementation spec is the next thing to write. Suggest ~600-1,000
  lines split across `content-rewards-payouts.md` and
  `affiliate-payouts.md`.

---

## 6. Senior-engineer onboarding — single-page checklist

If you are a senior engineer joining the team this week, read in this
order to get to "ready to implement Monday morning":

1. `README.md` (root of `growth-project-backend`).
2. `CLAUDE.md` (root) — repository conventions for Claude Code agents.
3. **This file.**
4. `docs/admin/control-room-spec.md` (Wave 1).
5. `docs/product/positioning-whop-ai-for-coaches.md` (Wave 2).
6. `docs/product/sub-coach-hierarchy.md` (Wave 2 — the data model spine).
7. `docs/product/retention-progression-system.md` + `retention-progression-rewards.md` (Wave 2 — the engine).
8. `docs/admin/data-feed-rfc.md` (Wave 3).
9. `docs/apps/architecture.md` + `manifest-spec.md` + `sdk-spec.md` (Wave 6).
10. `docs/discovery/recommendation-engine.md` + `buyer-funnel-and-attribution.md` (Wave 7).
11. `docs/affiliate/affiliate-link-spec.md` + `dashboard-and-payouts.md` (Wave 8).
12. `docs/storefront/block-editor-spec.md` (Wave 9).
13. `docs/community/doctrine-decision-rfc.md` (Wave 10 — read this with PR #90 doctrine context).
14. `docs/audit-and-gdpr.md`, `docs/api-conventions.md`, `docs/stripe-setup.md` (cross-cutting).
15. Mobile mirror (`growth-project-mobile/docs/product/`) and finance billing (`tgp-finance-app/docs/billing/`).

---

## 7. What is NOT in this batch (intentional out-of-scope)

- Wave 8 finance-app payout-extensions branch (separate follow-up).
- Mobile parity PRs for Waves 6-10 (a separate mobile-side wave).
- Runtime implementation of any wave.
- Production secret rotations, Fly deploys, Stripe live-mode wiring.
- Block-level A/B testing (Wave 9 v2).
- Multi-level affiliate trees beyond two levels (Wave 8 v2 deferred).
- Discord bidirectional federation (Wave 10 v2).
- Voice-note transcription languages beyond English (Wave 10 v1.x).

---

## 8. How to merge this batch when the OWNER approves

1. Resolve the highest-stakes OWNER decisions first (Wave 10 A/B/C, Wave 8 commission %, Wave 9 image CDN).
2. Merge Wave 1, then Wave 2, then 3 + 4 + 5 in parallel.
3. Merge Wave 6 (apps foundation).
4. Merge Waves 7, 9, 10 in parallel.
5. Merge Wave 8 backend half (#138). Open and merge the Wave 8 finance-half branch in `tgp-finance-app` next.
6. Merge this master index (#133) last; consolidate the per-wave `PERP_HANDOFF.md` files into a single root `PERP_HANDOFF.md` at that point.

Each wave PR has its own per-wave `PERP_HANDOFF.md` at the wave branch's
repo root with the detailed session log. After this index merges, those
files can be combined into one canonical root file.

---

## 9. Authorship & process notes

- Foundation waves (1-5) authored 2026-04-30 — 2026-05-01 in a co-authored
  Opus 4.7 spec build.
- Parity waves (6-10) authored 2026-05-01 in parallel by five Opus 4.7
  subagents working against fresh `/tmp/gpb-w{6..10}/` clones; recovery
  passes by the parent agent for waves where the subagent stalled mid-write.
- Every PR is draft. No runtime changes. No production secret changes.
  No deploys. No published claims.
- Every spec was reviewed against the same 15-section enterprise template
  (purpose, personas, schema deltas, API contracts, route surface, state
  tables, ≥5 failure modes, security/audit, perf budgets, billing,
  AI rules, day-1 order, test plan, migration plan, rollback +
  onboarding).

---

This index is the single canonical pointer. If a future session is
unsure where to start, start here.
