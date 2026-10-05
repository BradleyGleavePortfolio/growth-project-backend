# AUD-OPUS-FL2-119 (Claude Opus 5.5 lens, agent 119): fees round 19 (#684 + #697 + #685 + #686), LANDING candidate d8d062ff, #681 at the landing head

Started: Sun Oct  4 14:31:46 PDT 2026
Claims: lanes119/claims/backend-684-c1a07d9c-opus, backend-697-be7efc09-opus, backend-685-f0c48049-opus, backend-686-85683135-opus.
Heads at start (all match JOBS119; pass=10 skipping=1):
- #684 c1a07d9cc0a282a4e335035d11bb7eb8b2e0eca5
- #697 be7efc09d8a2caa2252b7ac51081e5ed6b8fa214
- #685 f0c48049ee7518862ed94924132122fa41da6865
- #686 856831354270725f651b1a26a54cdc4750271108
- #681 e9650dc4 (BEHIND, dual APPROVE)

Notes: ops/aud-119/AUD-OPUS-FL2-119/ (verdict-*.md, run-*.log, audit-opus-fl2-119-684-dup-push.spec.ts). Worktree wt/AUD-OPUS-FL2-119-1 (no node_modules).

## Step 1: #684 + #697 (posted 14:43 PDT, heads re-read right before)
#684 delta 9fb9c48f..c1a07d9c is one commit (4 files, +185/-33). Every line was read.

B-684-12 is closed.
- writeRefundStatus (refund-dispute-handler.service.ts:672-695) is a compare-and-set on the status as read. On a miss it re-reads, recomputes, and retries up to 5 times.
- All three status writers use it: :441 (legacy), :557 (update), :595 (P2002 path). No other chargeRefund status writer exists in src.
- Exhaustion throws RefundStateUnavailableError, which is retryable. That happens before any apply, flag or alert, so Stripe redelivers and the result converges. The admin path defers to the webhook.

Sol B-684-3 is closed.
- The email-attempt CAS result is honoured, the claim and budget are re-proved after it, and an unused attempt is returned on a stop.
- noticeSendSignal aborts at min(deadline, claim end), by timer or on the first read of `aborted`. EmailService checks it before the log insert and again before the transport; Resend's fetch receives it.
- pushToUser checks the signal after the token read and before each Expo chunk.

Probe runs:
- Replay https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37236744088 (be7efc09 + my probes): 7 suites, 68/68 pass. Opus FL L0-L3 now pass (L1-L3 failed at 9fb9c48f); F4-119, F34-117, r17, r19, email.service and coach-alerts-push also pass.
- C-684-13 proof https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37237037877: passes, meaning Expo is called twice for one notice when the window closes after Expo accepted.

Verdicts:
- **#684 @ c1a07d9c: APPROVE 0/0/4.** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5984698895
- **#697 @ be7efc09: APPROVE 0/0/0.** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/697#issuecomment-5984699013
  - The merge f70234ff tree equals merge-tree.
  - The own diff without the r19 spec has the same patch-id bf28b411.
  - This closes C-697-3.

## Step 2: #685 + #686 (posted 14:43 PDT)
- **#685 @ f0c48049: APPROVE 0/0/1** (C-685-3 carried). https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5984700382
  - Merge 4dd82634 tree 97cd8dcb equals merge-tree.
  - f0c48049 adds exactly `expect.any(AbortSignal),` at test/s-fee-r5-or-111-1.spec.ts:312. It is correct and does not weaken anything: the copy and payload assertions are untouched.
  - Patch-id excluding the r5 spec is d4301ac4e702, unchanged.
- **#686 @ 85683135: APPROVE 0/0/3** (C-686-2/4/5 carried). https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5984700478
  - Merge tree 6b9a208e equals merge-tree.
  - Patch-id f14b1e32b05a is unchanged.

## Step 3: LANDING CANDIDATE d8d062ff: APPROVE (14:43 PDT; one line in notify/fees-landing.txt)
- b3fdc2db is the merge of 85683135 and main 3e9a9a75. Its tree f16e0da0 equals `git merge-tree --write-tree`, so there are no hand edits.
- d8d062ff equals ops/reports/B-FEES18-119-no-pii-baseline.patch, line for line. It is tightening only: it removes purchase-split-handler 2 and transfer-orchestrator 1, and moves refund-dispute-handler from 5 to 4.
- Tree e4f86d6e equals the scratch fbc2e676 tree. Run 37235329330 is green on all 5 jobs.
- `git diff 0bc3696d d8d062ff` equals the round-19 fees delta (30a118dd..85683135). Only the hunk offsets and context in email.* differ.
- Per-file identity: every file equals the fees top or main, except the 3 auto-merged files (email.service.ts, email.types.ts, notifications.service.ts) plus no-pii-in-logs.spec.ts.
  - The merged email.service.ts keeps main's B-700-1 describeFailure and `row=` logs, and adds the round-19 signal checks, notStarted and the Resend fetch signal.
  - notifications.service.ts is unchanged since 0bc3696d. It has the fees throttle_key and channelGate plus main's describeFailure and ticket error codes.
- Migrations: only 20270210000000_s_fee_charge_settlement (additive, RLS), plus schema.prisma and the parity baseline. All are byte-identical to dual-approved #681 e9650dc4 and unchanged since 0bc3696d.

## Step 4: #681 at the landing head (posted 15:23 PDT)
- Polled from 14:44. #681 moved to d8d062ff at 15:09:15 (poll681.log). The operator extended the window by 45 min for CI.
- Every piece head (e9650dc4, 70f879a2, cc183e0a, c1a07d9c, be7efc09, f0c48049, 85683135) is an ancestor of d8d062ff. Against main: 74 files, +17,518/-1,306.
- CI at d8d062ff: all 11 required checks are green, including main-only CodeQL, danger, banned casts and SBOM. build-and-test run is 37238902523. Totals: 17 success, 1 skipped. mergeStateStatus is CLEAN.
- **#681 @ d8d062ff: APPROVE 0/0/0.** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5985105612 (claim backend-681-d8d062ff-opus)

## Follow-ups (C)
- C-684-13 (new, proved in run 37237037877): src/notifications/notifications.service.ts:713. checkAborted() after the Expo send turns an accepted push into 'aborted', so payout-notice.service.ts:483 re-pushes on the next run. Rule: report 'aborted' only before the first chunk is sent; after a send, return the ticket outcome. The Expo SDK call itself cannot be aborted, so the 60 s margin is the in-flight bound.
- C-684-14 (new; also in the builder's report): src/email/email.service.ts:343-372. ResendTransport sends no Idempotency-Key, so an abort mid-request after Resend accepted can mail twice (attempt k+1). Rule: send the attempt key as the Idempotency-Key header.
- C-684-3 (carried): refund-dispute-handler.service.ts:1209. The dispute alert copy must follow R-DISPUTE-PAUSE for recurring plans (#687/#688).
- C-684-11 (carried): refund-dispute-handler.service.ts:285. A full refund is decided from amount_refunded, which counts pending refunds. Rule: use the succeeded rows against the charge amount; for a failed refund that ended access, alert the coach with no automatic restore.
- C-685-3 / C-686-2 (carried): test/utils/settlement-fakes.ts. The fakes' $transaction has no rollback, and a null value satisfies lte.
- C-686-4 (carried): payout-notice-copy.ts. ugx is listed as zero-decimal.
- C-686-5 (carried): payout-notice-copy.ts. The chargeback copy needs the R-DISPUTE-PAUSE sentence.
- Sol C-684-4 (carried): payout-notice.service.ts. The Prisma distinct runs in memory.

## Cleanup
- Remote audit/AUD-OPUS-FL2-119/697-replay and 684-dup-push are deleted (ls-remote: 0 left).
- Worktree wt/AUD-OPUS-FL2-119-1 and its local branch are removed.
- Nothing was pushed to a PR branch.

## Operator decisions (recommended default first)
1. Land #681 @ d8d062ff once Sol's #681 verdict is APPROVE. Default: merge with a merge commit, then deploy per standing orders.
2. C-684-13 and C-684-14 (duplicate push or email when the send window closes after the provider accepted): ticket them for one post-landing round. Default: the Resend Idempotency-Key header plus 'aborted' only before the first Expo chunk.
3. C-684-3 / C-686-5 dispute copy for recurring plans: keep it gated behind #687/#688 (R-DISPUTE-PAUSE) before recurring plans take disputes in production. Default: yes.

## HANDOFF
Done 15:23 PDT 10-04. Every verdict is APPROVE.
- #684 c1a07d9c: 0/0/4, comment 5984698895.
- #697 be7efc09: 0/0/0, comment 5984699013.
- #685 f0c48049: 0/0/1, comment 5984700382.
- #686 85683135: 0/0/3, comment 5984700478.
- LANDING CANDIDATE d8d062ff: APPROVE (notify/fees-landing.txt).
- #681 d8d062ff: 0/0/0, comment 5985105612, all required checks green.
Next: the operator merges #681 after Sol's #681 verdict. The follow-up Cs are listed above.
