AUDIT Claude Opus 5.5 — growth-project-backend#684 @ 42e9ca13b0b365315fade00f0fce869f5e25834b — VERDICT: REQUEST CHANGES
A/B/C = 0/1/2

Tier T4 (money, coach payouts, coach-facing money copy). Piece F4 of the #627 split: 22 files (+2183/-423) wiring F3's settlement into the purchase-split handler, refund/dispute handler, webhook (BillingService), settlement sweep cron, payout notices (in-app, push, email), coach adjustments API, analytics and Connect metrics. Base agent115/fee-split-3-charge-settlement (#683 @ e2af8ca1).

## Evidence reuse (G09)
- Reused: this lens's APPROVE 0/0/1 on #627 @ 3a5338d72c277238486452f7f256da2d8e22c7c8 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972040127) for the money logic.
- Why it applies: every F4 file is byte-identical to 3a5338d7, to the refreshed #627 tree (merge-tree of 66162285 and main d23fa317 = 09de2bff) and to the F6 #686 tree. Round 10 and the main merge did not touch F4 files. No F4 line changed since that APPROVE.
- Re-done at this head anyway: full read of the F4 diff (refund-dispute handler, payout-notice service, settlement sweep cron, billing post-commit hooks, purchase-split handler, payment-ops controller, analytics/metrics, email template), plus the copy rules, which that APPROVE missed (B-684-1).
- C-627-10 stays the deferred C on #627; not re-raised.

## Piece-boundary safety
- Compiles alone and is green: run 37151663653, build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151663653/job/111286640886 : tsc, build, lint pass; 716 suites passed, 23 skipped, 0 failed; all 10 checks pass. Carries the updated main specs that F2/F3 left red (checkout-webhook-fee-split, purchase-split-handler, reconciliation): all PASS here.
- Wires F3 (`checkout.module.ts`, `connect.module.ts`); imports main + F1-F3 only; no migrations; nothing imports F5/F6.
- Sweep kill switch `SFEE_SETTLEMENT_SWEEP_ENABLED` (`src/common/env-validation.ts:446`). The S-FEE path itself is live once F1 switches checkout, which is why the stack lands as one (HANDOFF_AGENT_116 land-as-one rule).
- Tests: the sweep, adjustments controller, analytics and metrics tests ship here. The deep OR-111-1 tests for `payout-notice.service.ts` and the settlement branches of `refund-dispute-handler.service.ts` ship in F5/F6 (test-only pieces: s-fee-r5-or-111-1, s-fee-r4-money-protocol, s-fee-charge-concurrency, s-fee-r7-transfer-create-recovery). Acceptable only because the stack lands as one.

## Money paths re-verified (no finding)
- Refund: ChargeRefund upsert races resolve on P2002 then update; the reversal decision runs under the charge lock with a fresh `ledger_reversed` read; settlement charges converge from cumulative succeeded refunds; legacy destination charges keep the old path, now limited to that charge's own slices and `head_coach_split` transfers with a per-refund reversal key. Admin refund sets `reverse_transfer` / `refund_application_fee` only for legacy destination charges, read from the Stripe charge.
- Dispute: created/updated converge to the canonical dispute position under the lock; no adjustment error is swallowed (delivery fails, Stripe redelivers, sweeper flagged); closed won/lost converges before the legacy branch; lost on a settlement charge skips the legacy reversal.
- transfer.reversed: absolute, never-lowering sync of `amount_reversed`, then re-converge under the lock for settlement transfers.
- Notices: delivered only after the webhook transaction commits (C-627-7); generic refund alert skipped when an exact-amount notice exists; listing and acknowledge are scoped to `req.user.id`; non-UUID id gives 404, not 500; page size and cursor validated.
- Analytics: coach net = posted (net of reversals) - counted recoveries; seller vs head-coach recoveries split by settlement owner; `net_30d` no longer subtracts refunds twice.

## Findings

### B-684-1 — first-person product copy in new coach-facing text
- Where: `src/checkout/payout-notice.service.ts:543` (404 PAYOUT_NOTICE_NOT_FOUND message: "We could not find that payout notice on your account. Refresh Money to see your current notices.") and `src/email/templates/coach-payout-adjustment.hbs:20` (payout email: "We take it out of your next payout, and out of the ones after it if one sale is not enough.").
- Counterexample: the owner bar (_COMMON section 1, binding; OPERATOR_STANDING_ORDERS.md:41) says no first person in product copy. Every coach with a held amount gets the email line; the 404 message is the user-facing next action. These are the only two first-person strings this piece adds (`git diff e2af8ca1 42e9ca13 -- src`, non-comment lines).
- Fix rule: impersonal wording that keeps the next action, for example "No payout notice with that id is on this account. Refresh Money to see your current notices." and "It is taken out of your next payout, and out of the ones after it if one sale is not enough. Nothing is taken from sales already paid out." Add a guard test that renders the template and reads the 404 body and fails on `\b(We|we|Our|our|us)\b` (case-sensitive), `!` and emoji.
- Verify: the guard test fails on this head and passes on the fix; `rg -n "\bWe\b" src/checkout/payout-notice.service.ts src/email/templates/coach-payout-adjustment.hbs` returns nothing.

### C-684-2 — live held amount and needs_attention depend on page size
- Where: `src/checkout/payout-notice.service.ts:491-494` (`seen` is per page).
- Counterexample (fixture of s-fee-r5-or-111-1, test at line 535): two notices on ch_100 ($40 partial refund, then the full refund with 6000 held). With no limit, the older notice shows `held_now_open_cents: 0`, `needs_attention: false` after acknowledge. With `limit: 1`, page 2 returns the same older notice with `held_now_open_cents: 6000` and `needs_attention: true`, because page 2 has not seen the newer notice. A client summing the per-notice live amounts across pages double counts.
- Fix rule: compute the newest notice id per settlement for the payee (one grouped query) and give the live amount only to that id, on any page.
- Verify: extend the r5 test: page 2 with `limit: 1` shows `held_now_open_cents: 0` and `needs_attention: false` after acknowledge.

### C-684-3 (outside this diff) — dispute alert sends the coach to a step a coach cannot take
- Where: `src/checkout/refund-dispute-handler.service.ts:1017` (unchanged): "Chargeback opened on a client purchase. Submit evidence in Stripe within 7 days."
- Counterexample: S-FEE charges are platform charges (separate charge and transfer); the dispute sits on the platform account, so an Express coach has no Stripe screen to submit evidence. The next action does not work (no-generic-errors rule).
- Fix rule: point the coach to the in-app path that sends evidence to TGP support (or say TGP responds and what the coach should send), with the due date.
- Verify: copy test on the alert body.

## For the operator (not blocking this PR)
- F2 #682 `src/connect/fees/payout-notice-copy.ts:67,79,93,101` builds the notice title/body (in-app, push, email) with "We will hold", "We took", "We paid", "We ${freed}". Same rule as B-684-1; fixing both in one round keeps the stack's copy consistent.
- No probes were run: B-684-1 rests on literal strings; C-684-2 on the r5 fixture traced by hand.
