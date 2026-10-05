# AUD-OPUS-F34-117 (Claude Opus 5.5 lens, agent 117 wave) — fees F3 backend #683 and F4 backend #684

Job AUD-OPUS-F34-117, agent 117. Both heads re-read immediately before posting (unchanged). Notes, CI logs, probe logs, the probe spec and verdict drafts: /home/user/workspace/ops/aud-117/AUD-OPUS-F34-117/. Claims: lanes117/claims/backend-683-35a18539-opus, backend-684-e9ee033d-opus.

## Evidence reuse basis (both PRs)
- Reused this lens's #627 APPROVE @ 3a5338d7 and the 116-wave reviews (#683 @ e2af8ca1 APPROVE 0/0/3, #684 @ 42e9ca13 RC 0/1/2) only for code byte-identical since: c6fb2e3e = e2af8ca1 + F2 merge (F3 files identical except F2's own 4 lines in stripe-connect-api); 392473a3 = 42e9ca13 + F3 merge (F4 files identical). All later merges clean (no remerge diff).
- Audited deeply: every line of the F3 delta c6fb2e3e..35a18539 (+230/-141) and the F4 delta 392473a3..e9ee033d (src 66 lines + 361-line spec), the F2 round-11 contract F3 relies on (reverse() outcomes, ReversalUncertainError, undoReversal removal), and refund status handling end to end on F4.
- Sol's verdicts were read only after both Opus verdicts were posted.

## #683 (F3) @ 35a18539c8a911524c3eab5b074b33e247f80ac2 — APPROVE, A/B/C = 0/0/1
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5976735455
- Size 2,984 changed lines (16 lines of headroom). Base F2 a5d6a434.
- CI: run 37174989449 attempt 2, build-and-test red by design exactly as the PR body states: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174989449/job/111357782526 (lint, tsc, build pass; 3 suites / 9 tests fail: checkout-webhook-fee-split 2, purchase-split-handler 2, reconciliation.service 5 = TypeError at reconciliation.service.ts:221; 714 passed). Attempt 1 (job 111355645469) also timed out test/prod-readiness/operator-keys-artifact.spec.ts (10 s, no F3 input; passes on rerun and at F4). All other checks green.
- Closed: C-683-1 (exact red list), C-683-2 (converted refunds via convertedRefundedCents in settle/adjust/reconcile), C-683-3 (take 12 removed). Sol B-683-2/B-683-3 closures checked independently.
- C-683-4: reconciliation.service.ts:221-225, :339-352 now reads Stripe once per settled charge with no bound (admin run-sweeper up to 200 purchases, payment-ops.controller.ts:504-508). Fix: bounded per-run reads with a cursor or `unknown` + `charges_not_checked=N`; never `ok` for unchecked charges.
- Outside this diff: reconciliation.service.ts:206 and :277 still log raw error messages (main's lines).

## #684 (F4) @ e9ee033d425a61bb48efe2ac2387a23e5347acb0 — REQUEST CHANGES, A/B/C = 0/1/2
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5976735562
- Size 2,995 changed lines (5 lines of headroom). Base F3 35a18539.
- CI: run 37175734211 green: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175734211/job/111357831986 (719 suites passed, 0 failed, 12,401 tests); all checks green. Failing-before 37173415148, passing-after 37175462104.
- Closed: B-684-1 (copy + guard test), C-684-2 (live amount on any page). Sol B-684-2 / C-684-1 closures checked independently.
- B-684-3 (new): async-rail refunds (ACH always, cards when the platform balance is short) are `pending` when charge.refunded fires; the terminal status arrives only as a refund update (Stripe connector doc, measured sequence). Round-11 final applyAdjustments (refund-dispute-handler.service.ts:379-390) converges on `charge.amount_refunded`, which carries no status; onRefundUpdated (:395-421) only writes the row status.
  - Probe at the head (fc1e97b4 on e9ee033d) https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177972171/job/111364486553 : P1 pending refund moves money, P2 a failed pending refund leaves the coach debited 4,630 permanently, P3 a pending->succeeded refund never converges if amount_refunded excludes pending; controls P4/P5 pass.
  - Same probe at the pre-round-11 head (d64d844c on 392473a3) https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177980871/job/111364512077 : P3 and P4 fail (an async refund never converged before round 11 either).
  - Fix rule: canonical total = sum of SUCCEEDED refunds (embedded list when complete, else paged listChargeRefunds), never amount_refunded; onRefundUpdated re-enters the per-refund money path when a refund becomes succeeded (under the charge lock, idempotent on ledger_reversed). Verify with the probe spec at /home/user/workspace/ops/aud-117/AUD-OPUS-F34-117/probe-audit-opus-f34-117-684.spec.ts.
- C-684-4: a refund that fails after its money was applied raises no alert and no reconcile flag (partly outside this diff). Fix: closed-code alert + flag; re-credit is an operator decision.
- C-684-3 (carried, outside this diff): refund-dispute-handler.service.ts:1031 dispute alert tells the coach to submit evidence in Stripe.

## Sol comparison (read after posting)
- Sol #683 @ 35a18539: RC 0/2/1 (B-683-1 settlement debit shown as the client's refund, B-683-4 incomplete refund page accepted, C-683-4 booked-cash naming). Opus rated the presentment display as a latent note (usd-only packages) and did not find B-683-4; lenses disagree, so #683 stays blocked by Sol's B findings.
- Sol #684 @ e9ee033d: RC 0/2/1 (B-684-1 truncated webhook leaves ChargeRefund identities incomplete, B-684-3 notice delivery ignores the sweep deadline, C-684-4 newest-notice lookup unbounded). Opus concurs the lookup at payout-notice.service.ts:491-503 has no `take`/`distinct` (rows per settlement are few in practice; `distinct: ['settlement_id']` with the same ordering bounds it).
- ID collision: both lenses used B-684-3, C-684-4 and C-683-4 for different findings. Refer to them as "Opus B-684-3 (async refunds)" vs "Sol B-684-3 (notice deadline)", and so on.

## For the operator
1. Combined refund fix (recommended default): Sol B-684-1 and Opus B-684-3 share one root. One fix round should build the canonical refund list from Stripe (paged listChargeRefunds with amount + status), upsert every refund row, converge on the succeeded sum, and re-enter the money path from refund updates. Same rule for F3's reconciliation same-currency branch (reconciliation.service.ts:349 reads amount_refunded).
2. Size (decision needed; default: move tests): F4 has 5 lines of headroom and F3 has 16. The fix cannot fit unless tests move. Default: move the F3 part of test/s-fee-r11-fx-cash-truncation-logs.spec.ts (about 170 lines) into a test-only piece placed after F4, or into F5 if F5 has room.
3. Refund failure after apply (C-684-4; default: alert + flag only now). Automatic re-credit of the coach is a product decision.
4. Webhook subscription (default: verify in Stripe settings, no code change): the handler routes only `charge.refund.updated`. Confirm the endpoint receives it (or `refund.updated`) for ACH refunds.
5. Still open from 116: C-684-3 dispute copy; #685 carries 7 copy pins inherited from F2; main-owned raw logs in reconciliation.service.ts:206 and :277.

## Cleanup
- Probe branches audit/AUD-OPUS-F34-117/684-asyncrefund and 684pre-asyncrefund deleted (0 audit/AUD-OPUS-F34-117/* branches remain). Worktrees /home/user/workspace/wt/AUD-OPUS-F34-117-684 and -684pre removed (no node_modules linked). Nothing pushed to PR branches.

## HANDOFF
- backend #683 @ 35a18539c8a911524c3eab5b074b33e247f80ac2: Opus APPROVE 0/0/1 posted (comment 5976735455). Red by design verified. Sol RC 0/2/1 at the same head, so a fix round on F3 is still needed; the next Opus audit covers only the new delta.
- backend #684 @ e9ee033d425a61bb48efe2ac2387a23e5347acb0: Opus REQUEST CHANGES 0/1/2 posted (comment 5976735562). Next: the builder fixes Opus B-684-3 together with Sol B-684-1 (same root) and Sol B-684-3, makes room by moving tests (operator item 2), restacks F5/F6, then fresh lens audits at the new F3/F4 heads.
- This job ends here; no other PR audited.
