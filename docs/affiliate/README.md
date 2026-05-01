# Wave 8 — Affiliate Program (backend half)

> **Status:** DRAFT spec. Docs-only. No runtime, no migrations, no schema applied.
> **Branch:** `docs/wave-8-content-rewards-affiliate`
> **Base:** `main`
> **Sister doc:** `docs/content-rewards/README.md`. Affiliate and Content-Rewards share payout-pipeline scaffolding; read both.
> **Cross-repo:** finance-app payout extensions tracked separately (see Wave 8 finance branch in `tgp-finance-app`).

---

## 1. Purpose

The Growth Project's second Whop-AI parity gap is the **Affiliate Program**: a referral-and-commission system that lets *any party* — power users, marketing partners, super-affiliates, even coaches' own clients — drive new coach signups or new program purchases in exchange for a configurable commission.

Affiliate programs are how Whop crossed the chasm from "creator marketplace" to "creator-economy operating system". They:

1. **Distribute marketing cost to outcomes.** A coach pays nothing for a click; a coach pays a known commission only on a converted purchase. CAC becomes deterministic.
2. **Unlock long-tail distribution.** Partners with niche audiences (newsletters, podcasts, micro-influencers) who would never run paid ads will happily promote a $99/mo program for a 20% recurring commission.
3. **Layer with content rewards.** A creator can run a clip campaign (Wave 8 Content Rewards) AND embed an affiliate link in the clip's bio, double-monetising the same attention.
4. **Compound on TGP's network.** Once affiliate payouts route through TGP's Stripe Connect plumbing (already wired for sub-coach billing in Wave 5), every new coach onboarded extends the affiliate-eligible inventory.

This spec covers the **backend half**: data model, attribution semantics, anti-fraud, refund/clawback rules, and dashboard surface contract.

The finance-app extends Wave 5's Stripe Connect plumbing to support **affiliate commission transfers**. That extension is OUT OF SCOPE for this PR; cross-link only.

---

## 2. Non-goals (explicit)

The following are **NOT** part of this wave:

1. **No self-referral.** A user cannot earn affiliate commission on their own purchase. Detection is mandatory at attribution-resolve time AND at payout-emit time (defence in depth).
2. **No commission on refunded purchases.** If a converted purchase is refunded within the clawback window (90 days, OWNER_DECISION 8.J), the corresponding `AffiliateCommission` row is auto-reversed and (if already paid out) clawed back via the next payout cycle's debit.
3. **No incentive for spammy traffic.** Anti-fraud (bot click filtering, EPC anomaly detection, sudden conversion spikes) is mandatory. Affiliates whose traffic fails quality thresholds are throttled or banned.
4. **No multi-level commissions in v1.** v1 is single-level: affiliate refers a buyer, affiliate gets paid. v2 may introduce two-level (affiliate refers another affiliate, gets a smaller cut of their conversions). v1 ships single-level only. (See OWNER_DECISION 8.G.)
5. **No "lifetime" attribution.** Default attribution window is 30-day last-touch click (OWNER_DECISION 8.H). After that, the cookie/link expires and a new touchpoint is required to re-establish attribution.
6. **No commission on free trials, only on paid conversions.** Free-trial signups do NOT trigger commission; the first paid invoice does. This prevents trial-farming abuse.
7. **No commission on chargebacks won by the merchant.** If the merchant wins a chargeback, the original transaction stands and commission is honoured. If the merchant loses, the commission is clawed back per the refund pathway.
8. **No payouts below threshold.** Affiliate payouts hold until `>= $50` lifetime accrued (OWNER_DECISION 8.I). Below threshold, balance carries forward indefinitely (or until affiliate closes account, in which case ≥$10 is paid out and <$10 is forfeited per ToS).
9. **No automated Stripe transfers from this repo.** Same separation as Content Rewards: this backend produces a `PayoutInstruction` envelope; the finance-app executes it.

---

## 3. OWNER_DECISIONs surfaced in this wave

### OWNER_DECISION 8.G — Multi-level depth

Single-level (v1) or two-level (v2) commissions?

- **Option A: Single-level only.** Affiliate A refers buyer B; A earns commission. Done.
- **Option B: Two-level.** Affiliate A refers affiliate C; C refers buyer B; both A and C earn (C gets primary %, A gets secondary % which is a fraction of C's). Higher viral coefficient, higher fraud surface, MLM perception risk.
- **Option C: Two-level only for OWNER-approved super-affiliates.**

**Recommendation:** Option A (single-level v1). Two-level deferred to v2 behind capability flag. MLM perception is a meaningful brand risk for coach trust.

### OWNER_DECISION 8.H — Attribution window

How long does an affiliate click remain attributable?

- **Option A: 30-day last-touch click.** Industry standard.
- **Option B: 60-day last-touch click.** Longer consideration cycle for high-ticket programs (e.g., $5k masterminds).
- **Option C: 7-day last-touch + 30-day form-fill.** Hybrid; click expires fast, but form-fill (e.g., entered email) extends.

**Recommendation:** Option A (30-day) for v1. Per-program override allowed (`AffiliateProgram.attributionWindowDays`).

### OWNER_DECISION 8.I — Minimum payout threshold

When does TGP cut a payout to an affiliate's Connect account?

- **Option A: $50 minimum, monthly cycle (1st of month).**
- **Option B: $25 minimum, monthly.**
- **Option C: $100 minimum, monthly.**
- **Option D: No minimum, monthly (always pay if balance > $0.01).**

**Recommendation:** Option A. Stripe transfer fees (≥$0.25 base) become punitive on small payouts; $50 is industry standard.

### OWNER_DECISION 8.J — Refund clawback window

After how long is a refund "too late" to claw back commission?

- **Option A: 90 days from original purchase.** Aligned with most card-network chargeback windows.
- **Option B: 60 days.** Tighter, friendlier to affiliate.
- **Option C: 180 days.** Match Stripe's max chargeback window.

**Recommendation:** Option A (90 days). Aligned with most networks and affiliate-industry standard.

### OWNER_DECISION 8.K — Default commission rate

What's the default `AffiliateProgram.commissionRateBps` when a coach enables affiliates without explicit override?

- **Option A: 20% flat (2000 bps).**
- **Option B: 15% flat (1500 bps).**
- **Option C: 30% recurring on subscriptions for 12 months, 20% one-time on one-shot purchases.**

**Recommendation:** Option A (20% flat) for v1 simplicity. Per-program override always available.

### OWNER_DECISION 8.L — Cookie consent + server-side fallback

Affiliate attribution traditionally relies on browser cookies. With ITP, GDPR, and ad-blockers, cookie attribution rate has fallen to ~50%. Do we support server-side attribution as fallback?

- **Option A: Cookie-only.** Simplest. Loses ~50% attribution.
- **Option B: Cookie + URL-param fallback (referral code in checkout URL).** Captures ~80%.
- **Option C: Cookie + URL + server-side click-ID (stored in session, signed JWT in URL).** Captures ~95%, GDPR-compliant if click-ID is opaque.

**Recommendation:** Option C. ITP-resilient and respects consent.

### OWNER_DECISION 8.M — Self-referral detection strictness

How aggressively do we block self-referral?

- **Option A: Email match only.** Low false positives; bypassable with a second email.
- **Option B: Email + IP + device-fingerprint match.** Strong; some false positives on shared households.
- **Option C: Manual review for high-value referrals (>$500 commission).**

**Recommendation:** Option B + manual review escalation per Option C above $500.

---

## 4. File map

| File | Purpose | Target lines |
|------|---------|--------------|
| `README.md` (this) | Purpose, non-goals, OWNER_DECISIONs | ~180 |
| `affiliate-link-spec.md` | Prisma models, referral code semantics, attribution, commission rules, anti-fraud, state transitions, failure modes | ~1,300 |
| `dashboard-and-payouts.md` | Affiliate dashboard surface, payout pipeline, 1099, anti-fraud detail, tax forms | ~1,000 |
| `PERP_HANDOFF.md` | Combined session log (content-rewards + affiliate) | ~200 |

## 5. Dependencies

- **Wave 5** — Stripe Connect plumbing.
- **Wave 7** — coach-page funnel (affiliate links land here).
- **Wave 8 content-rewards** — sibling wave; shared payout pipeline scaffolding.
- **Wave 3** — admin scope-stack (affiliate metrics surface in admin console).

## 6. Merge order

Same as content-rewards: this PR first, finance-app second, mobile mirror third.

## 7. Senior-engineer onboarding checklist

1. Read `affiliate-link-spec.md` end-to-end (~40 min).
2. Read `dashboard-and-payouts.md` (~30 min).
3. Read sibling content-rewards specs for shared payout scaffolding (~75 min).
4. Cross-reference Wave 5 Stripe Connect Express doc.
5. Resolve OWNER_DECISIONs 8.G through 8.M.
6. Begin schema migration draft (separate PR, not this one).

## 8. Glossary

- **Affiliate** — entity (Coach, Client, or external partner) authorised to refer purchasers.
- **Affiliate program** — coach-or-org-owned configuration (commission rate, window, eligible products).
- **Click** — a tracked traversal of an affiliate link.
- **Conversion** — a paid purchase attributable to an affiliate click within the attribution window.
- **Commission** — the dollar amount owed to the affiliate for a conversion.
- **EPC** — earnings per click. Aggregate quality metric.
- **Clawback** — reversal of a commission after refund/chargeback.
- **Last-touch attribution** — last affiliate click before purchase wins.
- **Cookie consent fallback** — server-side click-ID attribution when cookies are blocked.
