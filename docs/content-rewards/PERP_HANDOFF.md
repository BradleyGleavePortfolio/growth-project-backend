# Wave 8 — Content Rewards + Affiliate Program — session log (backend half)

> **Date:** 2026-05-01
> **Status:** docs only, draft, NOT MERGED
> **Branch:** `docs/wave-8-content-rewards-affiliate`
> **Scope:** backend half only — data models, business rules, API contracts, fraud rules, dashboard surface, payout pipeline (orchestration spec).

## What this wave ships

Eight files across two directories under `docs/`:

| File | Lines | Purpose |
|---|---:|---|
| `content-rewards/README.md` | 166 | Overview, non-goals, OWNER decisions, file map |
| `content-rewards/rewards-spec.md` | 1,192 | `ContentReward` + `ContentSubmission` data model, view-verification trust ladder, anti-fraud rules, leaderboards, state machine, failure modes |
| `content-rewards/payout-pipeline.md` | 554 | End-to-end pipeline (submission → verification → approval → Stripe transfer), platform fee, 1099 thresholds, reconciliation |
| `content-rewards/buyer-discovery.md` | 366 | UGC → coach attribution; cross-link to Wave 7 buyer funnel; UTM/short-link semantics; multi-channel attribution; failure modes |
| `affiliate/README.md` | 158 | Overview, non-goals, OWNER decisions, file map |
| `affiliate/affiliate-link-spec.md` | ~470 | `AffiliateProgram`, `AffiliateAccount`, `AffiliateLink`, `AffiliateClick`, `AffiliateConversion`, `AffiliateCommission` models; referral codes; attribution window; commission rules; self-referral detection; refund/clawback; state machines; 7 failure modes; full TS API contracts |
| `affiliate/dashboard-and-payouts.md` | ~440 | Dashboard surface (TS shapes), `AffiliatePayout` model, end-to-end payout pipeline (sweep, preflight, dispatch, webhook reconcile, D+5 reconciliation), KYC gates, 1099/W8 collection, refund clawback paths, anti-fraud at payout time, perf budgets |
| `content-rewards/PERP_HANDOFF.md` | this file | Session log |

Approximate total: **~3,500-4,000 lines** across 8 files.

## OWNER decisions surfaced

### Content Rewards (rewards-spec.md, payout-pipeline.md)
1. Platform fee % on payouts (recommend **5%**)
2. View-verification trust ladder (recommend tier-1 auto-pay <$50, tier-2 OAuth required >$50, tier-3 manual review >$500)
3. 1099 threshold (recommend **$600 trailing 12-month**)
4. Clawback window (recommend **90 days**)
5. Bot/anti-fraud auto-quarantine thresholds
6. Public leaderboard exposure (recommend opt-in only, relative ranks not absolute)

### Affiliate (affiliate-link-spec.md, dashboard-and-payouts.md)
1. Attribution window (recommend **30-day last-touch click**)
2. Multi-level: single-level v1 vs two-level v2 (recommend **single-level v1**)
3. Default commission % (recommend **20% flat, configurable per program**)
4. Self-referral detection (strict on payment-method + account-id; heuristic on IP+device)
5. Cookie consent fallback (cookie + server-side ledger)
6. Refund clawback window (90 days)
7. Tiered commission (flat v1 only)
8. Bot-click filtering (hybrid edge + async sweep)
9. Default min payout threshold (recommend **$50**)
10. Payout cadence (recommend **monthly, settling on the 7th**)
11. KYC provider (recommend Stripe Connect Express; re-use Wave 5 KYC)
12. Tax form storage (platform-encrypted bucket primary; Stripe-managed redundant)
13. Pre-dispatch hold window (recommend **24h**)

All recommendations carry rationale; OWNER may flip any with a follow-up before GA.

## Hard rules satisfied

- **Docs only** — `prisma/schema.prisma` is NOT touched. All schema deltas in fenced ```prisma blocks inside `.md` files.
- **No emojis**, no TODO/FIXME/Coming Soon, no fake testimonials or fabricated data.
- **Decimal(14,2)** on every money field; currency stored on row.
- **Stripe Connect** for all payouts (re-uses Wave 5 wiring).
- **PII never to PostHog** — affiliate analytics use server-aggregated counts only; events emitted by client carry only opaque ids.
- **Audit log** entry specified for every mutation route (request_id, actor, before/after).
- **GDPR cascade** specified on every personal-data table (`AffiliateAccount.delete_after`, `ContentSubmission` cascade, `BuyerFunnelEvent` cascade).
- **AI default `sonar-pro`** with hard monthly caps (e.g. $200/mo for fraud-summary calls).
- **Performance budgets** specified at 100 / 1k / 10k coach scale on every read endpoint and background job.
- **Idempotency** keyed on stable ids (Stripe charge id + refund id, payout.id) on every mutation.
- **No money movement ambiguity** — pipeline stages explicit, KYC gates explicit, reconciliation specified.

## Failure-mode coverage

- `rewards-spec.md`: ≥6 (view-burst fraud, OAuth expiry, refund timing, currency mismatch, KYC reject, banned-content detection).
- `payout-pipeline.md`: ≥6 (transfer fail, KYC gap, currency mismatch, refund-after-payout, duplicate transfer, reconciliation drift).
- `buyer-discovery.md`: ≥5 (link rot, attribution race, duplicate creator, OAuth expiry, fingerprint collision).
- `affiliate-link-spec.md`: ≥7 (cookie blocked, attribution race, refund timing, currency mismatch, KYC reject, self-referral, click stuffing, affiliate banned mid-window).
- `dashboard-and-payouts.md`: ≥6 (Stripe terminal fail, KYC gap, bank reject, refund-after-payout, duplicate transfer, currency mismatch in batch, reconciliation drift).

## Cross-repo dependencies

- **`tgp-finance-app`** — Stripe Connect routing extensions (Decimal(14,2) sub-ledger split for content-rewards payouts and affiliate commissions). **OUT OF SCOPE for this PR.** A separate Wave 8 finance branch (`docs/wave-8-payout-extensions`) is recommended for the finance-app repo. The pipeline orchestration in this PR specifies the intent and contract; the finance repo will hold the Connect routing implementation spec.
- **`growth-project-mobile`** — read-only mirror of affiliate dashboard endpoints; no native KYC UI v1 (deep-link to web).
- **`growth-project-backend` Wave 1 admin** — operator screens for content-reward review, affiliate ban/release, payout force-hold/release, reconciliation drift triage.
- **`growth-project-backend` Wave 7 buyer funnel** — content-rewards `buyer-discovery.md` and affiliate conversion capture both write into the same `BuyerFunnelEvent` ledger.

## What is NOT in this wave (intentional out-of-scope)

- Finance repo Connect routing implementation spec (separate Wave 8 finance branch).
- Multi-level (MLM) trees beyond two levels — never v1.
- Block-level A/B testing (Wave 9).
- Native mobile payout UI / KYC UI (deep-link to web v1).
- Marketing-attribution analytics richer than clicks/conversions/EPC.
- Tax-treaty optimisation tooling beyond W8 collection.
- Instant payout / on-demand payout — monthly cycle only.
- Multi-currency consolidation per affiliate — each currency has its own balance and threshold.

## Senior-engineer onboarding checklist

- [ ] Read `content-rewards/README.md`, `affiliate/README.md`.
- [ ] Read `affiliate-link-spec.md` first, then `dashboard-and-payouts.md` — link-spec defines the data model the dashboard reads.
- [ ] Read `rewards-spec.md` and `payout-pipeline.md` for the content-reward side.
- [ ] Read `buyer-discovery.md` and Wave 7 `buyer-funnel-and-attribution.md` together — same ledger, different write-paths.
- [ ] Read TGP `audit-and-gdpr.md`, `api-conventions.md`, `stripe-setup.md`.
- [ ] Read Wave 5 (`tgp-finance-app/docs/billing/`) Stripe Connect destination wiring.
- [ ] Set up local Stripe webhook listener.
- [ ] Sit with a finance/tax owner for one hour on 1099/W8 collection cadence.
- [ ] Verify replica lag tolerance (≤ 5 s) and read-replica access.
- [ ] Familiarize with PostHog event-emission policy: aggregate only, never individual ids in client events.

## Status

Draft, do not merge. PR opens `[DRAFT] docs(wave-8): content rewards + affiliate program (backend half)` against `main`. Finance-app payout-extension branch is a separate follow-up; this PR explicitly notes the dependency in its body.
