# Handoff brief: #44 Affiliate / Referral System

**Spec:** [`docs/specs/commerce/affiliate-referral.md`](../../../specs/commerce/affiliate-referral.md).

## WHY

Coaches grow primarily through word-of-mouth: existing clients referring friends, mastermind alumni referring colleagues. Today this is informal — handed-out discount codes, Venmo-paid referral fees, untracked links. Untaxed, unattributable, and the customer relationship leaks back to the third-party tool that minted the link.

A TGP-owned affiliate system makes the channel **trackable** (attribution chain in our DB), **payable on-platform** (same `Payout` rail as coaches), **tax-clean** (1099 issued correctly per routing), and **abuse-resistant** (self-referral, click farms, cookie-stuffing detectable because the chain is in our DB).

## WHEN

- Spec accepted.
- [`payments-checkout.md`](../../../specs/commerce/payments-checkout.md) and [`offer-builder.md`](../../../specs/commerce/offer-builder.md) at S1 (so `Offer.affiliate_share_bps` exists).
- [`application-funnel.md`](../../../specs/commerce/application-funnel.md) accepted (so `shared_by_affiliate_id` slot lines up).
- §20 OQs closed (attribution model, cookie window, self-referral default, minimum payout, ad-hoc-vs-batch).

## WHERE

- New sub-module `src/commerce/affiliates/`.
- New tables: `Affiliate`, `AffiliateLink`, `AffiliateClick`, `AffiliateConversion`, `AffiliatePayoutBatch`.
- New routes: `/api/v1/coach/affiliates/*`, `/api/v1/affiliate/*` (self-service), `/r/:code` (public click), `/api/v1/owner/affiliates/*`.

## WHO

- Sign-off: founder, backend lead, counsel (1099 / tax positioning per routing).
- Pager: backend lead.

## WHAT

**Single-tier referrals only.** Hard no on multi-level / MLM (regulatory + abuse risk).

**Default share** is per-`Offer.affiliate_share_bps` (basis points of gross). Per-link override allowed. Last-touch attribution by default; cookie window 30d.

**Routing-aware:** Connect destination charges → coach's net carries the share, paid to affiliate via Stripe transfer from coach's connected account. MoR charges → TGP's gross carries the share, paid from TGP's platform account.

**Payouts:** held until `Charge.refund_window_days` elapses, then auto-batched. Two-OWNER ack required for batches > $10k.

**Non-goals:** no paid acquisition tracking, no coupon codes (S1), no off-platform payouts.

## HOW

S0 spec → S1 (`Affiliate` + `AffiliateLink` + clicks + manual payouts, flag off) → S2 (auto-payout batches, self-service portal, Connect onboarding for affiliates) → S3 GA. Smallest first PR: `Affiliate` + `AffiliateLink` + `AffiliateClick` + `/r/:code` route only, ~400 LOC.

## Risk + dependency highlights

- Click farms / bot fraud — bot score + velocity hold + review queue.
- Self-referral abuse — default block; per-coach OWNER override.
- Negative-balance carryover after refund-post-payout — 90d operator write-off SOP.
- 1099 misclassification — counsel review pre-GA; documented per-routing matrix.
- Cookie loss / Safari ITP — cross-device authenticated attribution + persistent log-in fallback.

## Operator handoff

`AFFILIATE_ENABLED`, `AFFILIATE_AUTOPAYOUT_ENABLED`, `AFFILIATE_SELF_REFERRAL_ALLOWED` flags. Per-affiliate `status='paused' | 'suspended'`. Runbook `docs/commerce/affiliate-runbook.md`. Conversion-rate, fraud-signal histogram, payable-balance-by-affiliate dashboards.
