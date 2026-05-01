# Handoff: #43 Rewards and Bounties

> Operator brief. Engineer-facing long form is
> [`docs/specs/rewards-and-bounties.md`](../../specs/rewards-and-bounties.md).
> **Read §11 of the spec on the sweepstakes posture before
> reviewing the runtime PR.**

## WHY

A coach wants to incentivise specific behaviours — post a
transformation, refer a friend, hit a streak, win a
challenge — and today does it by hand: a Venmo, a manual
discount, a private DM. Nothing tracks the outcome and
nothing audits the payout. The bounty surface formalises
this into a tracked, audited, idempotent in-app credit
applied to the member's next coach invoice.

## WHEN

Cannot start runtime PR-1 until: reward-currency decision
recorded (v1 ships **only** `coach_credit` via Stripe
`customer_balance`); per-coach monthly cap recorded (PR
#120 lane #05); sweepstakes posture written into
`docs/audit-and-gdpr.md` and ToS; OWNER review threshold
agreed (default $100); anti-fraud floors confirmed
(per-user daily claim cap, evidence ownership check).
**Legal sign-off on §11 is non-negotiable.**

## WHERE

New module `src/bounties/` peer to `src/billing/`. Four new
tables: `Bounty`, `BountyClaim`, `BountyPayout`,
`BountyPayoutReviewQueue`. New env-var family `BOUNTIES_*`.
The platform never moves cash to a member; the credit
applies to the coach's invoice for that member via Stripe
`customer_balance`. No `new-website` change.

## WHO

Founder owns: per-tier monthly cap, OWNER review threshold,
whether bounties apply to lapsed accounts (spec defaults:
no). Backend lead owns: Stripe credit mechanic
(`customer_balance` vs coupon/promotion code vs negative
invoice line — spec defaults to `customer_balance`). Legal
owns: ToS section on the sweepstakes posture. Mobile owns:
evidence-attach UI. Coach console owns: award/reject UI +
per-bounty roster. OWNER on the pager; double-payout is the
failure mode to avoid.

## WHAT

Already exists: `Invoice`, `PaymentFailure`,
`StripeProcessedEvent`, `AuditLog`, the throttler, the OWNER
admin convention.

Net-new: 4 tables, per-coach monthly cap predicate,
evidence-validation service, idempotent Stripe credit-
application service, OWNER review queue surface.

Non-goals (and **legal hard boundaries**): no sweepstakes /
chance-based prizes, no random selection, no member-to-member
bounties, no cash-out, no Stripe Connect payouts, no AI auto-
award, no tradeable points / leaderboard tokens / NFTs /
crypto.

## HOW

7-PR rollout (spec §7.1). PR-1 is schema + empty `[]`
behind `BOUNTIES_ENABLED=false` + the ToS / sweepstakes-
posture edit to `docs/audit-and-gdpr.md`. Stripe credit
path lands PR-4; OWNER review queue lands PR-5.

Smallest first PR ships: schema, module mounted, empty `[]`,
smoke assertion, OpenAPI export update, ToS update. Zero
Stripe call.

## Risks (top 3)

1. Double-payout. Mitigation: idempotency anchor =
   `BountyPayout.id` on the Stripe call; post-call DB write
   reads the existing `stripe_balance_txn_id`.
2. Sweepstakes drift in coach copy. Mitigation: copy review
   at design time; OWNER review queue catches above-threshold
   payouts.
3. Reversal flood (coach awards then rejects in bulk).
   Mitigation: PostHog alert on
   `bounty_payout_reversal_rate_30d > 5%`; OWNER reads daily.

## Acceptance criteria (one-line)

Coach creates $25 bounty for "post a transformation photo"
(`evidence_kinds=['community_post']`) → member posts +
claims → coach awards → idempotent $25 credit on the
member's next coach invoice → above-threshold bounty routes
to OWNER review queue → OWNER metrics counter reflects the
$25 in `bounty_payouts_30d_total_cents_platform` → revert
= flag flip; in-flight claims sit `pending`; no money moves.

## Operator handoff

- **Kill-switch:** `fly secrets set BOUNTIES_ENABLED=false
  -a tgp-backend-prod`.
- **Dashboards:** payouts-30d-per-coach, review-queue-open,
  reversal-rate-30d, cap-utilization-per-coach.
- **Runbook entry:** `docs/operations/bounties.md` (future
  doc) covers cap predicate, OWNER review queue, reversal
  path, and the legal posture.
- **First 30 days:** OWNER reads
  `bounty_payout_reversal_rate_30d` daily; > 5% is the
  on-call signal.

## Cross-references

- Engineer spec: [`docs/specs/rewards-and-bounties.md`](../../specs/rewards-and-bounties.md)
- Adjacent specs: [`community-spaces.md`](../../specs/community-spaces.md),
  [`events-live-calls.md`](../../specs/events-live-calls.md),
  [`ai-business-copilot.md`](../../specs/ai-business-copilot.md)
- Related drafts: PR #120 (lanes #01, #03, #04, #05, #06, #11
  — the prize-payout regression gate), #123 (#30, #31, #36).
