# Wave 8 — Content Rewards (backend half)

> **Status:** DRAFT spec. Docs-only. No runtime, no migrations, no schema applied.
> **Branch:** `docs/wave-8-content-rewards-affiliate`
> **Base:** `main`
> **Cross-repo:** finance-app payout extensions tracked separately (see Wave 8 finance branch in `tgp-finance-app`).

---

## 1. Purpose

The Growth Project (TGP) competes with Whop AI for the operating-system layer of the coaching economy. One of Whop's most successful primitives is **Content Rewards**: a coach (or brand) puts up a **bounty pool**, and **creators** (clippers, editors, short-form posters) submit content (TikTok clips, IG Reels, YouTube Shorts, X posts, blog mentions) that drives attention to the coach. Verified views translate to micro-payouts. The pool drains as views accrue. When the pool is exhausted, the campaign closes.

This produces three compounding effects:

1. **Marketing leverage.** A coach paying $1,000 into a content-rewards pool typically generates 5-50x that in earned distribution because creators chase the pool from many angles simultaneously. The coach pays per verified view, not per attempt.
2. **Discovery for TGP.** Every clip carries a short-link or tracked landing URL that funnels back to the coach's TGP page (Wave 7 funnel). Content rewards are one of the highest-converting top-of-funnel discovery channels in the creator economy.
3. **Network effect.** Creators who earn from one coach see the pool size of other coaches' campaigns and gravitate toward TGP as a clipping platform, deepening the supply side of the marketplace.

This spec covers the **backend half** of Content Rewards: data model, business rules, view-verification trust ladder, anti-fraud, payout pipeline (orchestration only — actual Stripe Connect transfers extend `tgp-finance-app`), and discovery attribution.

The finance-app extends Wave 5's Stripe Connect plumbing to support **per-submission transfers** to creator-owned Connect accounts. That extension is OUT OF SCOPE for this PR; cross-link only.

---

## 2. Non-goals (explicit)

The following are **NOT** part of this wave and will be rejected in review if included:

1. **No payment without view-verification.** Every cent paid out must be backed by either (a) a server-side short-link impression count, (b) an OAuth-fetched platform metric, or (c) a manual reviewer signature. We do not pay on creator self-report.
2. **No payout to fraudulent or sanctioned accounts.** Anti-fraud quarantine, OFAC/sanctions screen, and KYC pass via Stripe Connect Express are mandatory before any transfer.
3. **No payment for hate / banned categories.** Each `ContentReward` carries a `bannedCategories` enum set. Submissions categorised into a banned bucket by the moderation pipeline are auto-rejected with no payout liability.
4. **No public exposure of revenue.** Leaderboards show *relative rank* and *clip count*, never dollar amounts, unless the creator explicitly opts in (Wave 10 doctrine — quiet reinforcement).
5. **No retroactive bounty changes.** Once a `ContentReward` is `ACTIVE`, the `perViewCents` and `capCents` are immutable for already-submitted content. Coach can only **lower future bounty** for new submissions or close the pool early. This protects creator trust.
6. **No multi-platform deduplication v1.** If a creator cross-posts identical content to TikTok and IG, both submissions count separately (subject to platform-specific verification). De-dup is a v2 fairness improvement, not a v1 blocker.
7. **No creator-to-creator subcontracting.** A creator cannot resell a submission slot to another creator. Payouts go to the verified `creatorId` only.
8. **No automated Stripe transfers from this repo.** This backend produces a `PayoutInstruction` envelope and emits a domain event. The finance-app consumes the event and executes the transfer. Separation of concerns is mandatory.

---

## 3. OWNER_DECISIONs surfaced in this wave

The following decisions are open and **must be resolved by the platform owner before implementation Monday**. Each carries a recommendation.

### OWNER_DECISION 8.A — Platform fee on content-reward payouts

When a coach funds a $1,000 content-rewards pool, what slice does TGP retain?

- **Option A: 0%.** Pure pass-through. Maximises creator share, minimises TGP revenue. Forces TGP to monetise via core subscription only.
- **Option B: 5% platform fee, deducted from pool before per-view accrual.** A $1,000 pool funds $950 in payouts; $50 is TGP revenue. Aligns with Whop's typical take rate on similar primitives.
- **Option C: 10% platform fee.** Higher TGP margin, but creator backlash risk; creators see effective per-view rate drop.
- **Option D: Tiered (5% on first $5,000 lifetime per coach, 3% thereafter).** Rewards loyalty.

**Recommendation:** Option B (5% flat). Simple to communicate, aligns with industry norm, leaves room to tier later. Stored as `ContentReward.platformFeeBps` (basis points, default 500) so per-pool override is possible for white-label/enterprise.

### OWNER_DECISION 8.B — View-verification trust-ladder thresholds

How aggressively do we require higher trust tiers as payouts grow?

- **Option A: Auto-pay up to $50 lifetime per creator on tier 1 (short-link only).** Beyond that, tier 2 (OAuth) required. Beyond $500 per submission, tier 3 (manual review) required.
- **Option B: Auto-pay up to $200 on tier 1.** Looser, faster creator acquisition, more fraud risk.
- **Option C: Tier 2 required from cent zero.** Highest integrity, slowest creator onboarding.

**Recommendation:** Option A. Balance fraud risk vs friction. Codified as `RewardPayoutTier` constants in `payout-pipeline.md` §4.

### OWNER_DECISION 8.C — Clawback window for fraudulent views

If a submission is paid out and later determined fraudulent (bot-driven views), how long can TGP claw back?

- **Option A: 30 days from payout.** Aligned with Stripe dispute window.
- **Option B: 90 days from payout.** Longer fraud-detection runway.
- **Option C: Indefinite for confirmed fraud, 30 days for dispute.**

**Recommendation:** Option C. Fraud is fraud regardless of age; dispute window is for grey-area cases.

### OWNER_DECISION 8.D — 1099 / tax form generation responsibility

Does TGP generate 1099-NEC for US creators earning >$600/yr, or does Stripe Connect Express handle it via their tax form workflow?

- **Option A: TGP generates and files via Stripe Tax Reporting API.**
- **Option B: Stripe Connect Express handles natively; TGP only flags the threshold.**
- **Option C: Hybrid — Stripe handles US, TGP handles EU/UK VAT-equivalent.**

**Recommendation:** Option B for v1 (cheaper, faster, lower compliance surface). Re-evaluate at $1M GMV/yr.

### OWNER_DECISION 8.E — Creator identity model

Are content-reward creators a sub-type of `Client` (re-using auth), a sub-type of `Coach` (re-using Connect), or a **net-new** `Creator` entity?

- **Option A: Net-new `Creator` entity** with own auth, own Connect account, own discovery profile.
- **Option B: Polymorphic — a `Client` or `Coach` can opt in to creator role, gaining `Creator` capabilities.**
- **Option C: Sub-type of `Client` only.** Coaches cannot also be clippers.

**Recommendation:** Option B. Avoids duplicate-account problem; aligns with TGP's identity-graph doctrine.

### OWNER_DECISION 8.F — Cross-platform de-dup v1

If a creator submits the same clip URL slug pattern to TikTok and Instagram, do we count it once or twice?

- **Option A: Twice (per-platform verification independent).**
- **Option B: Once (perceptual hash de-dup).**

**Recommendation:** Option A for v1 (simpler), v2 introduces perceptual hashing.

---

## 4. File map

| File | Purpose | Target lines |
|------|---------|--------------|
| `README.md` (this) | Purpose, non-goals, OWNER_DECISIONs, file map | ~200 |
| `rewards-spec.md` | Prisma models, state-transition tables, view-verification trust ladder, anti-fraud, leaderboards, failure modes | ~1,500 |
| `payout-pipeline.md` | Submission → verification → approval → Stripe Connect transfer pipeline, decimal handling, 1099, clawback, idempotency, reconciliation | ~900 |
| `buyer-discovery.md` | UGC → coach attribution, UTM/short-link semantics, multi-channel attribution, dashboards | ~800 |
| `PERP_HANDOFF.md` | Combined session log for content-rewards + affiliate (see `docs/affiliate/PERP_HANDOFF.md`) | (see affiliate dir) |

---

## 5. Dependencies

- **Wave 2** — `Coach`, `Client`, `Org`, `Program`, `Cohort` entities. Creator identity in Wave 8 is polymorphic on these.
- **Wave 3** — admin data-feed scope-stack. Content-rewards pools surface in admin console under `org/cohort/coach` scope.
- **Wave 5** — Stripe Connect Express foundation. Wave 8 finance branch extends with per-submission transfers.
- **Wave 7** — funnel + buyer-discovery mechanics. Wave 8 short-links land into Wave 7's coach-page funnel and inherit its conversion attribution.
- **Wave 8 affiliate** (sister wave, this PR) — shared payout pipeline scaffolding (Connect transfers, 1099 thresholds, clawback semantics).

## 6. Merge order

1. This PR (`docs/wave-8-content-rewards-affiliate`) merges first (docs-only).
2. Finance-app PR (`docs/wave-8-payout-extensions` in `tgp-finance-app`) merges second, references this spec.
3. Mobile mirror (`docs/wave-8-creator-surfaces` in `growth-project-mobile`) merges third.

## 7. Personas + permission matrix (high-level; full matrix in `rewards-spec.md`)

| Persona | Create reward | Submit clip | Approve clip | Disburse payout | View pool ledger |
|---------|---------------|-------------|--------------|-----------------|-------------------|
| OWNER (TGP staff) | Y (any org) | N | Y (override) | Y (override) | Y (any) |
| COACH | Y (own org) | N (separate role) | Y (own pool) | N (auto via finance-app) | Y (own pool) |
| SUB_COACH | Conditional | N | Conditional | N | Conditional |
| CREATOR | N | Y | N | N (recipient only) | Self only |
| CLIENT | N | N (unless dual-role) | N | N | N |
| ADMIN (TGP) | Y | N | Y | Y | Y |

## 8. Senior-engineer onboarding checklist

A senior engineer picking this up Monday should:

1. Read `rewards-spec.md` end-to-end (~45 min).
2. Read `payout-pipeline.md` (~30 min).
3. Read `buyer-discovery.md` (~25 min).
4. Read affiliate sister docs for payout pipeline reuse (~40 min).
5. Cross-reference Wave 5 Stripe Connect doc to confirm Express account model.
6. Cross-reference Wave 7 funnel to confirm short-link → coach-page handoff.
7. Resolve OWNER_DECISIONs 8.A through 8.F with platform owner.
8. Begin schema migration draft (separate PR, not this one).

## 9. Glossary

- **Pool** — total capital coach commits to a `ContentReward` campaign.
- **Per-view rate** — `perViewCents`. The unit price paid per verified view.
- **Cap** — `capCents`. Maximum lifetime payout to a single creator from one pool. Anti-whale protection.
- **Trust tier** — verification confidence level (1=short-link, 2=OAuth, 3=manual).
- **Clawback** — reversal of a paid-out transfer due to fraud or refund.
- **EPC** — earnings-per-click (used for affiliate, mirrored here for unit economics).
- **Verified view** — a view that survives anti-fraud filters and is eligible for payout accrual.
- **Quarantine** — submission flagged by anti-fraud, held in `UNDER_REVIEW`, not paid until human or higher-tier signal clears it.
