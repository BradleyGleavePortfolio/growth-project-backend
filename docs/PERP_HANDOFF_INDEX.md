# PERP Handoff — Master Index

> **Purpose:** single canonical pointer to every spec PR opened during the
> 2026-04-30 → 2026-05-01 enterprise spec build. New Computer sessions and
> new senior engineers should start here.
> **Status:** docs only, **draft, NOT MERGED**. Designed to land **after** every
> wave PR below has merged so the per-wave `PERP_HANDOFF.md` files can
> consolidate into this index without conflicts.
> **Last updated:** 2026-05-01 — Waves 6-10 PRs landed (draft); this index now points at the final PR numbers.

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
[Wave 5] → [Wave 6 apps] → [Wave 7 discovery] → [Wave 9 storefront] →
[Wave 8 rewards/affiliate] → [Wave 10 community RFC]. Two to four hours of
reading covers the foundation; another four to six hours covers the parity
layer.

---

## 1. The five foundation waves (all draft, none merged)

| Wave | PR | Repo | Branch | Lines | What it ships |
|---|---|---|---|---:|---|
| **Wave 1** | [#130](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/130) | `growth-project-backend` | `docs/admin-console-canonical` | 2,065 | Admin console canonical reconciliation. Supersedes PR #127, adopts PR #128 as canonical. Five files under `docs/admin/`. |
| **Wave 2** | [#132](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/132) | `growth-project-backend` | `docs/wave-2-product-specs` | 5,367 | Eight files under `docs/product/`: Whop-AI positioning, sub-coach hierarchy, retention engine, retention rewards layer, onboarding (clients + coaches), data-tracking contract. |
| **Wave 3** | [#131](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/131) | `growth-project-backend` | `docs/wave-3-admin-data-feed` | 2,388 | Three files under `docs/admin/`: data-feed RFC, glossary, handoff. Defines the cohort drilldown architecture, scope-stack, SSE/polling envelope, materialised views, capability hash cache keys. |
| **Wave 4** | [#98](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/98) | `growth-project-mobile` | `docs/wave-4-mobile-mirror` | 2,582 | Six files under `docs/product/`: mobile mirror for org mode, progression UX, onboarding flows, AI copilot. |
| **Wave 5** | [#109](https://github.com/BradleyGleavePortfolio/tgp-finance-app/pull/109) | `tgp-finance-app` | `docs/wave-5-finance-subcoach-billing` | 1,381 | Four files under `docs/billing/`: sub-coach billing split (Flow A + Flow B), finance org roll-ups. |

**Foundation total: ~13,783 lines of spec across 5 draft PRs in 3 repos. Zero runtime changes. Zero migrations. Zero merges.**

---

## 1B. Waves 6-10 — Whop AI parity layer (all draft, none merged)

| Wave | PR | Branch | Lines | Files | What it ships |
|---|---|---|---:|---:|---|
| **Wave 6** App architecture + SDK + manifest + MCP | [#136](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/136) | `docs/wave-6-app-architecture-sdk` | 4,101 | 8 | `docs/apps/`: README, architecture (hybrid: iframe sandbox + server runtime), manifest-spec (signed JSON, KMS, version pinning, capability decls), sdk-spec (typed TS client, retention/rewards/sub-coach hooks), installation-and-billing (per-app revenue split, Stripe Connect routing), developer-portal-and-review (submission, SLA, sandbox lifecycle, banned categories), mcp-server-spec (MCP exposure of Wave 3 read-models, sonar-pro default), PERP_HANDOFF. **Foundation for Wave 9 custom blocks.** |
| **Wave 7** Public discovery / marketplace | [#134](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/134) | `docs/wave-7-discovery-marketplace` | 4,848 | 8 | `docs/discovery/`: README, public-directory (coach + app cards, 50-niche taxonomy, archetype/geo/price filters, SSR), recommendation-engine (cold-start + warm ranking, hybrid embeddings, A/B), featured-placements (paid + editorial slots, anti-spam), buyer-funnel (server-side event ledger, 30-d last-touch attribution, dashboards), trust-and-safety (verified achievements, testimonial consent, transformation-photo policy, banned claims), api-and-mobile (REST surface, rate limits, CDN cache, mobile parity), PERP_HANDOFF. |
| **Wave 8** Content Rewards + Affiliate (backend half) | [#138](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/138) | `docs/wave-8-content-rewards-affiliate` | 3,625 | 8 | `docs/content-rewards/`: README, rewards-spec (`ContentReward` + `ContentSubmission` models, view-verification trust ladder, anti-fraud, leaderboards), payout-pipeline (Stripe Connect, 1099, reconciliation), buyer-discovery (UGC → coach attribution, UTM/short-link). `docs/affiliate/`: README, affiliate-link-spec (full Prisma sketches, 30-d last-touch, single-level v1, self-referral detection, refund/clawback, full TS API contracts), dashboard-and-payouts (`AffiliatePayout` model, end-to-end pipeline, KYC gates, 1099/W8, anti-fraud at payout). PERP_HANDOFF. **Finance-app payout-extensions tracked separately as a follow-up Wave 8 finance branch.** |
| **Wave 9** Storefront block builder + funnel analytics | [#137](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/137) | `docs/wave-9-storefront-builder` | 5,466 | 7 | `docs/storefront/`: README, block-editor-spec (block tree, validation, undo/redo, autosave, collab lock, a11y, mobile breakpoints — biggest single file at 1,667 lines), block-types-catalog (Hero, Pricing, Testimonial, FAQ, Embed, CTA, About, Programs-Grid, Reviews, Schedule, Custom-via-app), publishing-and-versioning (draft/preview/publish, version snapshots, ISR, sitemap/OG/Twitter), funnel-analytics (event taxonomy, block-level CTR, attribution cross-link to Wave 7), integration-with-apps (custom blocks via Wave 6 manifest, iframe sandbox, postMessage), PERP_HANDOFF. **Depends on Wave 6.** |
| **Wave 10** Native chat / community decision RFC + spec | [#135](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/135) | `docs/wave-10-community` | 4,491 | 7 | `docs/community/`: README (leads with A/B/C OWNER decision), doctrine-decision-rfc (the most important file — full A/B/C trade space, feature matrix, risk analysis, reversibility, clause-by-clause doctrine compatibility), channel-and-thread-spec (taxonomy, permission matrix, Prisma deltas, 28+ routes, state machines), voice-notes-spec (recording, sonar-pro transcription, retention, $260/mo storage at 10k coaches), moderation-and-safety (auto-flag, ban ladder, audit, GDPR cascade, CSAM), integration-with-discord (read-only v1, OAuth, identity reconciliation), PERP_HANDOFF. **Highest-stakes OWNER question of the parity set: A vs B vs C — recommend B.** |

**Parity total: ~22,531 lines of spec across 5 draft PRs in 1 repo (backend).**
**Combined foundation + parity: ~36,314 lines across 10 draft PRs in 3 repos.**

### CI status (2026-05-01)

| PR | Wave | Title | CI |
|---|---|---|---|
| #130 | 1 | admin console canonical | last-run: green |
| #131 | 3 | admin data-feed RFC | last-run: green |
| #132 | 2 | product specs | last-run: green |
| #134 | 7 | discovery marketplace | green ✓ |
| #135 | 10 | community RFC + spec | green ✓ |
| #136 | 6 | apps architecture + SDK + MCP | green ✓ |
| #137 | 9 | storefront block builder | green ✓ |
| #138 | 8 | content rewards + affiliate | green ✓ |
| #133 | this index | master PERP_HANDOFF index | green ✓ |

All checks are docs-only build-and-test runs (no migration, no deploy, no
secret rotation). All PRs are draft and unmerged.

---

## 2. Dependency graph

```
Wave 1 (admin console canonical)
   │
   ├──► Wave 3 (admin data-feed RFC)
   │       │
   │       └──► Wave 6 §mcp-server-spec (MCP exposes Wave 3 read-models)
   │
   └──► Wave 4 mobile mirror (admin-screen surfaces only — most are server-rendered)

Wave 2 (product specs: positioning, sub-coach hierarchy,
        retention engine, rewards layer, onboarding,
        data-tracking)
   │
   ├──► Wave 4 (mobile mirror)
   ├──► Wave 5 (sub-coach billing in tgp-finance-app)
   ├──► Wave 6 (apps reference Coach/Org/Cohort entities)
   ├──► Wave 7 (discovery cards reference coach archetype/niche from Wave 2)
   ├──► Wave 8 (content rewards + affiliate reference Coach/Org)
   └──► Wave 10 (community channels reference Cohort + sub-coach hierarchy)

Wave 5 (Stripe Connect destination model)
   │
   ├──► Wave 6 §installation-and-billing (per-app revenue split routing)
   ├──► Wave 8 §payout-pipeline + §dashboard-and-payouts (commission + UGC payouts)
   └──► Wave 7 §featured-placements (Stripe billing for paid slots)

Wave 6 (manifest + SDK + sandbox)
   │
   └──► Wave 9 §integration-with-apps (custom blocks declared via Wave 6 manifest)

Wave 7 (buyer funnel ledger + attribution)
   │
   ├──► Wave 8 §buyer-discovery + affiliate conversion capture write into the
   │           same BuyerFunnelEvent ledger
   └──► Wave 9 §funnel-analytics extends per-block attribution

Wave 10 (community)
   │
   └── (no downstream parity dependents v1)
```

### Recommended merge order

1. Wave 1 (admin console canonical) — unblocks Wave 3.
2. Wave 2 (product specs) — unblocks 4, 5, 6, 7, 8, 10.
3. Wave 3 (admin data-feed) — unblocks Wave 6 MCP.
4. Wave 4 (mobile mirror) — independent of parity layer.
5. Wave 5 (sub-coach billing in finance) — unblocks Wave 6/8 payout routing.
6. Wave 6 (apps) — unblocks Wave 9 custom blocks.
7. Wave 7 (discovery) — unblocks Wave 8 buyer-discovery cross-link and
   Wave 9 funnel-analytics cross-link.
8. Wave 9 (storefront) — depends on 6 + 7.
9. Wave 8 (content rewards + affiliate, backend half) — depends on 5 + 7.
   Finance-app payout extensions follow as a separate Wave 8 finance branch.
10. Wave 10 (community RFC + spec) — independent dependency-wise but
    OWNER must resolve the A/B/C doctrine collision before any
    runtime work begins.
11. **This PR (#133)** merges last to consolidate handoff logs.

---

## 3. Outstanding OWNER decisions (by wave)

> Each is tagged `OWNER_DECISION` in the relevant spec file; recommendations
> in **bold**. Implementation can proceed on the recommendations on file;
> OWNER may flip any with a follow-up PR before GA.

### Wave 6 — Apps
1. Runtime model — iframe sandbox / server runtime / **hybrid (recommended)**
2. Manifest signing key custody — **AWS KMS** / Vault / in-process
3. Per-app revenue split — **70/30 dev/platform with first $1k/mo free** / 15% flat / other
4. Review SLA — **5 business days**
5. Sandbox resource quotas (CPU sec/req, memory MB, network bytes/day)

### Wave 7 — Discovery
1. Embedding model — text-embedding-3-large / local / **hybrid (recommended)**
2. Attribution window — **30-day last-touch (recommended)** / first-touch / multi-touch
3. Featured-slot pricing — CPM / **flat tier with cap (recommended)**
4. Refund-rate auto-suspend threshold — **8% trailing 90-day**
5. Transformation-photo retention — **30 days post-revocation (GDPR-aligned)**
6. Crawler indexing — opt-in / **opt-out (recommended)**
7. Geo unit — **locale (recommended)** / city / radius
8. Sub-coach surfacing — **bundled under parent (recommended)** / standalone

### Wave 8 — Content Rewards + Affiliate
1. Platform fee % on content rewards payouts — **5% (recommended)**
2. View-verification trust ladder thresholds — **tier-1 auto-pay <$50 / tier-2 OAuth >$50 / tier-3 manual >$500**
3. 1099 threshold — **$600 trailing 12-month (US legal floor)**
4. Clawback window — **90 days**
5. Public leaderboard exposure — **opt-in only, relative ranks (recommended)**
6. Affiliate attribution window — **30-day last-touch click**
7. Multi-level — **single-level v1 / two-level v2 deferred (recommended)**
8. Default commission % — **20% flat, configurable per program**
9. Self-referral detection — **strict on payment-method + heuristic on IP/device**
10. Cookie consent fallback — **cookie + server-side ledger fallback**
11. Default min payout threshold — **$50**
12. Payout cadence — **monthly, settling on the 7th**
13. Tax form storage — **platform-encrypted bucket primary; Stripe-managed redundant**
14. Pre-dispatch hold window — **24 h**
15. Bot-click filtering — **hybrid edge + async sweep**

### Wave 9 — Storefront
1. Custom-HTML escape policy — **NO arbitrary HTML in v1; allowlist embeds only**
2. A/B test scope v1 — **page-level only; block-level v2 deferred**
3. SEO render strategy — SSR / static / **ISR (recommended)**
4. Image CDN — **Cloudflare Images (recommended)**
5. Version retention — **30 versions per page**

### Wave 10 — Community
1. **A vs B vs C doctrine collision** — full reactions+presence (A) vs limited (B, recommended) vs text+threads only (C). Highest-stakes question across the parity set.
2. Voice-note retention — **90 days**
3. Voice-note max length — **5 min**
4. Discord bridge depth — **read-only v1 (recommended)**
5. Moderation queue ownership — **platform with per-coach escalation (recommended)**
6. DM scope v1 — **1:1 coach↔client only, no group DMs**

---

## 4. Cross-repo dependency map

| Wave | growth-project-backend | growth-project-mobile | tgp-finance-app |
|---|---|---|---|
| 1 | own (admin console) | (read-only consumer of admin endpoints) | — |
| 2 | own (product specs) | mirror in Wave 4 | — |
| 3 | own (data-feed RFC) | (admin client) | — |
| 4 | (consumer of Waves 2-3 contracts) | own (mobile mirror) | — |
| 5 | (consumer of Connect routing) | (consumer of billing portal) | own (sub-coach billing split) |
| 6 | own (apps architecture + manifest + MCP + SDK) | mirror app surfaces on mobile shell | extends Connect destination model for app revenue split |
| 7 | own (discovery + recommendation + funnel) | mobile parity surfaces (REST mirror) | (Stripe billing for paid featured slots) |
| 8 | own (content rewards + affiliate, **backend half**) | read-only mirror of affiliate dashboard; deep-link to web for KYC | **Wave 8 finance branch (follow-up):** Stripe Connect routing extensions for content-rewards payouts and affiliate commissions |
| 9 | own (storefront + funnel-analytics) | webview render of storefront pages | (pricing-block reads finance pricing model from Wave 5) |
| 10 | own (community + Discord federation) | mobile chat client (mirrors REST) | — |

---

## 5. Hard rules satisfied across every spec PR

| Rule | Enforcement across Waves 6-10 |
|---|---|
| Docs only | `prisma/schema.prisma` is **untouched** in every wave PR; schema deltas are illustrative inside fenced ```prisma blocks in `.md` files. Verified by file diffs. |
| No emojis | Spot-checked across all 38 spec files. |
| No TODO / FIXME / Coming Soon | Open decisions tagged `OWNER_DECISION:` with options + recommendation. |
| Money: Decimal(14,2), currency on row, Stripe Connect | Waves 6, 7, 8 specify; no money movement ambiguity. |
| PII never to PostHog | Waves 7, 8, 9, 10 specify aggregate-only emission with opaque ids. |
| Audit log per mutation | Waves 6, 7, 8, 9, 10 specify the `AuditLog` row contract per mutation route. |
| GDPR delete/export | Cascade columns specified on every personal-data table; export endpoints specified on Waves 7, 8, 10. |
| Consent flags | Wave 7 (testimonial, transformation-photo, marketing), Wave 8 (program terms, affiliate), Wave 10 (voice-note transcription). |
| Least-privilege scopes | Capability tokens enumerated per wave (`affiliate:self`, `app:capability:read:retention`, etc.). |
| Performance budgets at 100 / 1k / 10k | Specified per-endpoint and per-job in every wave. |
| AI rules: sonar-pro default, hard caps, MCP scopes, consent for tool actions | Wave 6 §mcp-server-spec, Wave 8 §11, Wave 10 §voice-notes. |
| Day-1 implementation order | Specified in every wave's primary spec file. |
| Test plan (unit/integration/e2e/load/security) | Specified in every wave. |
| Migration/backfill plan | Stated in every wave (most are greenfield). |
| Rollback plan | Specified in every wave (feature flags at multiple layers, append-only correction ledger entries). |
| Senior-engineer onboarding checklist | Specified in every wave. |
| Cross-repo dependency map | Specified in every wave (and aggregated in §4 above). |

---

## 6. What is NOT in this set (intentional out-of-scope)

- **Runtime implementation** — every wave is docs-only.
- **Schema migrations** — all schema deltas illustrative; no SQL applied.
- **Deploy / publish** — no Fly secrets touched, no env tier changes, no production rollouts.
- **Wave 8 finance-app half** — Stripe Connect routing extensions for content-rewards and affiliate payouts will be a separate follow-up Wave 8 finance branch in `tgp-finance-app`. The orchestration contract is specified in PR #138; the finance implementation spec is not in this set.
- **Multi-level affiliate (MLM trees beyond two levels)** — explicitly deferred from Wave 8 v1.
- **Block-level A/B testing** — explicitly deferred from Wave 9 v1.
- **Custom HTML/CSS/JS in storefront builder** — explicitly excluded from Wave 9 v1.
- **Native mobile KYC UI** — explicitly excluded from Wave 8 v1.
- **Bidirectional Discord federation** — explicitly excluded from Wave 10 v1 (read-only v1).
- **Tax-treaty optimisation tooling beyond W8 collection** — excluded from Wave 8 v1.

---

## 7. Senior-engineer onboarding checklist (cross-wave)

- [ ] Read this index in full.
- [ ] Read each wave's `README.md` (10 files, ~10-30 min each).
- [ ] Read each wave's primary spec (the heaviest file in each wave).
- [ ] Read TGP `audit-and-gdpr.md`, `api-conventions.md`, `stripe-setup.md`,
      `entitlements.md`.
- [ ] Read existing PR #90 doctrine (relevant to Wave 10).
- [ ] Confirm read-replica access and edge-route deployment topology with infra.
- [ ] Sit with finance/tax owner for one hour on 1099/W8 collection mechanics
      (relevant to Waves 6, 7, 8).
- [ ] Familiarize with PostHog event-emission policy: aggregate only, never
      individual link/conversion ids.
- [ ] Familiarize with the `AuditLog`, capability-token, and idempotency-key
      infrastructure already present in the repo.
- [ ] Set up local Stripe webhook listener (`stripe listen ...`).
- [ ] Verify KMS-key-rotation handling for any encrypted-at-rest store
      (manifest signing keys in Wave 6, tax-form bucket in Wave 8).

---

## 8. Status

- **All 10 waves are draft, none merged.**
- **All ~36,314 lines of spec are docs-only.**
- **Zero runtime changes, zero migrations, zero deploys.**
- **CI is green (or in-flight) on every PR.**
- **OWNER decisions are tagged in every wave with recommendations.**
- **This PR (#133) merges last to consolidate per-wave handoff logs.**
