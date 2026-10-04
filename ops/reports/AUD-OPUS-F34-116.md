# AUD-OPUS-F34-116 (Claude Opus 5.5 lens, agent 116 wave) — fees F3 backend #683 and F4 backend #684

Started 2026-10-03 19:28 PDT (date: Sun Oct 4 02:28 UTC). Verdicts posted 2026-10-04 02:47 UTC.
Claims: lanes116/claims/backend-683-e2af8ca1-opus, backend-684-42e9ca13-opus.
Notes and verdict drafts: /home/user/workspace/ops/aud-116/AUD-OPUS-F34-116/ (notes.md, verdict-683.md, verdict-684.md, f3-failed.log, f4-build-and-test.log).

## Evidence reuse basis (both PRs)
- This lens's APPROVE 0/0/1 on #627 @ 3a5338d72c277238486452f7f256da2d8e22c7c8: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972040127
- Every F3 and F4 file is byte-identical to 3a5338d7, to merge-tree(66162285, d23fa317) = 09de2bff, and to the F6 #686 tree. Round 10 (6c7706e1) touched only F2 + F5 files. No F3/F4 line changed since that APPROVE. Full piece diffs still read; copy rules re-checked (found B-684-1, missed by the #627 APPROVE).
- C-627-10 not re-raised.

## #683 (F3) @ e2af8ca1fe872ca3c319b52b3ac3b8fca17de7bd — APPROVE, A/B/C = 0/0/3
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5975904957
- CI: run 37151662477, build-and-test red by design: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151662477/job/111286637746 (tsc + build pass; 3 suites / 9 tests fail: checkout-webhook-fee-split 2, purchase-split-handler 2, reconciliation.service 5 with TypeError at reconciliation.service.ts:216). All other checks green. All three updated specs PASS at F4.
- C-683-1: PR body red-by-design list is inexact (names checkout, which is green; omits reconciliation). Fix: correct the body or move the reconciliation spec update into F3.
- C-683-2: refunded amount (presentment currency) vs gross (settlement currency) in charge-settlement.service.ts:499/581/589/1317-1322 and reconciliation.service.ts:257/364/371. Latent (mobile sends usd only; API accepts any ISO code at packages.service.ts:679, outside diff).
- C-683-3: reconciliation covers only the 12 newest settled charges (reconciliation.service.ts:216-219).
- Open items: none blocking.

## #684 (F4) @ 42e9ca13b0b365315fade00f0fce869f5e25834b — REQUEST CHANGES, A/B/C = 0/1/2
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5975905095
- CI: run 37151663653 green; build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151663653/job/111286640886 (716 suites passed, 23 skipped, 0 failed); 10/10 checks pass.
- B-684-1: first-person product copy: src/checkout/payout-notice.service.ts:543 ("We could not find that payout notice...") and src/email/templates/coach-payout-adjustment.hbs:20 ("We take it out of your next payout..."). Owner bar section 1 + OPERATOR_STANDING_ORDERS.md:41. Fix: impersonal wording keeping the next action, plus a copy guard test (case-sensitive We/we/Our/our/us, "!", emoji) on the template render and the 404 body.
- C-684-2: per-page `seen` set (payout-notice.service.ts:491-494) makes held_now_open_cents / needs_attention depend on page size (r5 fixture, limit 1, page 2).
- C-684-3 (outside this diff): refund-dispute-handler.service.ts:1017 dispute alert tells the coach to submit evidence in Stripe; coaches have no Stripe dispute screen for platform charges.
- Open items: B-684-1 fix round on F4 (then restack F5/F6), and a fresh audit at the new F4 head.

## For the operator (other PRs, not blocking #683/#684)
- F2 #682 src/connect/fees/payout-notice-copy.ts:67,79,93,101: notice title/body (in-app, push, email) use "We will hold", "We took", "We paid", "We ${freed}". Same rule as B-684-1. Recommended default: fix in the same round as B-684-1 (builder edits F2 and F4 copy together, restacks F3-F6).
- Package currency (C-683-2): recommended default: a small separate PR restricting package currency to usd until multi-currency is designed.

## Cleanup
- No probes run; no audit/* branches created. Worktrees /home/user/workspace/wt/AUD-OPUS-F34-116-683 and -684 removed (no node_modules linked).

## HANDOFF
- backend #683 @ e2af8ca1fe872ca3c319b52b3ac3b8fca17de7bd: Opus APPROVE 0/0/3 posted (comment 5975904957). Red by design verified. Next: Sol verdict at this head is REQUEST CHANGES (theirs); any new F3 head (restack after a fix round) needs a fresh Opus delta check using this report.
- backend #684 @ 42e9ca13b0b365315fade00f0fce869f5e25834b: Opus REQUEST CHANGES 0/1/2 posted (comment 5975905095). Next: builder fixes B-684-1 (two strings + guard test), ideally together with the F2 copy; a fresh Opus lens audits the new F4 head (delta: copy + test only, money logic unchanged and covered by the evidence above).
- This job ends here; no other PR audited.
