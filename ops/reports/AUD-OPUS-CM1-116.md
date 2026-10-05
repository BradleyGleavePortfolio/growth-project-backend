# AUD-OPUS-CM1-116 (lens Claude Opus 5.5, agent 116 wave) — report

Job: full-depth T4 audit of backend #674 (coach Money M1) and #676 (coach Money M3) at their current heads, with one verdict per PR.
- Claims: ops/lanes116/claims/backend-674-9a512028-opus and backend-676-564f33bf-opus.
- Notes dir: ops/aud-116/AUD-OPUS-CM1-116/. It holds both verdict bodies, both probe specs and one run log.

## Heads
Verified at 2026-10-04T02:28Z, again right before posting, and again after posting (2026-10-04T02:59Z). Neither head moved.
- **#674 @ 9a512028f49682073227c04ef1268c81102716fd**
  - Base: main d23fa317.
  - Checks: all 18 green.
- **#676 @ 564f33bf1469e483a253df29ecaac750c5c43a22**
  - Base: the #674 branch.
  - Checks: all 11 applicable checks green. CodeQL, danger, banned casts and SBOM do not run on a stacked base.

## Evidence trail
- **Piece fidelity:** `git merge-tree --write-tree f60ed603 d23fa317` = d4d5d4bc. `git diff 564f33bf d4d5d4bc` touches only the M2 and M4 files, so the M1 and M3 code is byte-identical to #641 FIX ROUND 5 merged with main.
- **Opus history on #641:**
  - APPROVE @ fb29fb9e (5964726454).
  - REQUEST CHANGES 0/1/1 @ 02cd3f88 (5972121356).
  - FIX ROUND 5 (f60ed603) never addressed B-641-12.
- **M1:** every line of d23fa317..9a512028 was audited. No evidence was reused.
- **M3:** apart from `payoutReason` and main-merged lines, the code is byte-identical to the fb29fb9e approve.
  - The reuse covers guards, tenancy, currency scoping, lifetime totals and the onboarding landings.
  - A fresh real-writer probe disproved event-level window cents (B-676-1), so the reuse stops there.
- **Probes** (CI lane, audit-only branches, now deleted):
  - [Run 37171850436](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171850436), on #674's head (probe commit 2cad0d3a):
    - 5 red as predicted: three for B-674-3, two for B-641-12.
    - 1 control green.
  - [Run 37172376221](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172376221), on #676's head (probe commit efdd3c6e): 1 red for B-676-1.
    - The writer posts 97 and then 98.
    - Money reports the first window as 97, then 96 after the second refund, and the second window as 99. The first window's CSV changes.
- **Independence:**
  - B-674-3 was found and proved before Sol's verdicts were read.
  - After reading them, Sol's B-674-2 (owner routes unreachable) and B-676-1 (window reallocation) were re-derived from source, re-proved, and adopted under Sol's IDs.
  - The log-text findings were promoted from C to B so they are rated the same as B-641-11.

## #674 — REQUEST CHANGES, A/B/C = 0/4/5 (C-641-2 is carried and not counted)
[Verdict comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-5975983216).

**B findings**
- **B-674-2:** the owner cannot reach the review and reconcile routes.
  - Cause: the class-level JwtAuthGuard and ServiceTokenGuard both read the same Bearer header and each demands a different value.
  - Effect: the runbook's mandatory step cannot be performed.
- **B-674-3:** one Stripe reversal is counted twice.
  - Cause: the `transfer.reversed` webhook mirror is absolute, while the retry-sweep, reconcile and record paths add to it.
  - Effects:
    - The platform under-recovers on the next refund.
    - On a full refund, the head-coach ledger slice is never reversed.
- **B-674-4:** the new scheduler logs raw exception text.
- **B-641-12 (carried; Sol's B-674-1):** a read-then-absolute-write lost update.
  - It affects `ConnectTransfer.reversed_amount_cents` and `SplitLedgerEntry.reversed_cents`.
  - Its fix needs a live-DB test.

**C findings**
- C-674-5: `request_timeout` is not in the error catalog.
- C-674-6: a Stripe failure during reconcile returns a generic 500.
- C-674-7: reconcile records no actor.
- C-674-8 (outside this diff): a stale `charge.refunded` regresses refund status and strands the owed reversal.
- C-674-9 (outside this diff): a pending head-coach transfer is still paid after its sale is refunded.

**Confirmed closed at this head:** B-641-7/8/9/10/11 and C-641-7.

## #676 — REQUEST CHANGES, A/B/C = 0/2/1 (C-641-2 is carried and not counted)
[Verdict comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5975983345).
- **B-676-1:** proportional re-allocation of cumulative `reversed_cents` makes a later partial refund rewrite earlier windows and their tax CSV. Reported cents do not equal the per-event cents the writer posted.
- **B-676-2:** `refreshStatus` logs raw exception text.
- **C-676-2 (= C-641-13, own):** the failed-payout reason is Stripe's raw text with no action.

## Operator items (recommended defaults)
1. **The builder fix round for #674 is large.**
   - Default: one builder fixes B-674-2/3/4 and B-641-12 in #674, adds the live-DB test, then restacks #676 and fixes B-676-1/2 there.
   - B-676-1 may be fixed most cleanly by persisting per-event postings in the #674 writer. If so, keep the change inside #674 and #676 (the stack lands as one).
2. **B-674-2 reaches beyond this PR.** Every AdminPaymentOpsController route (and admin.controller, audit, soc2, secrets) uses the same unreachable guard pair.
   - Default: fix only the two new routes in #674, and open a separate T4 issue for the rest of the admin surface.
3. **Migration ordering:** 20270314000000 sorts after the 20270311 and 20270313 migrations carried by other open PRs. Prisma applies pending migrations in name order.
   - Default: no action; confirm at deploy.
4. **Housekeeping:** #676's READY comment labels it "Piece M2" (it is M3), and the bodies of #674 and #676 carry no tier header. Cosmetic.

## Cleanup
- Branches: audit/AUD-OPUS-CM1-116/674-reversal-mirror and /676-window-cents are deleted from origin.
- Worktrees: wt/AUD-OPUS-CM1-116-1/2/3 are removed (no node_modules were linked).
- Nothing was pushed to any PR branch.

## HANDOFF
- **backend #674** @ 9a512028f49682073227c04ef1268c81102716fd
  - Opus verdict: REQUEST CHANGES 0/4/5 (comment 5975983216). Sol: REQUEST CHANGES 0/4/0.
  - CI: green.
  - Next step: a builder fix round for B-674-2, B-674-3, B-674-4 and B-641-12 (live-DB test). The probe spec ops/aud-116/AUD-OPUS-CM1-116/audit-cm1-674-reversal-mirror.spec.ts must pass unchanged. Then a re-audit by both lenses at the new head.
- **backend #676** @ 564f33bf1469e483a253df29ecaac750c5c43a22
  - Opus verdict: REQUEST CHANGES 0/2/1 (comment 5975983345). Sol: REQUEST CHANGES 0/2/2.
  - CI: green on the applicable checks.
  - Next step: restack after the #674 fix, then fix B-676-1 (the probe ops/aud-116/AUD-OPUS-CM1-116/audit-cm1-676-window-cents.spec.ts must pass unchanged) and B-676-2. Then a re-audit by both lenses at the new head.
- The stack #674 -> #676 -> #677 lands as one only after all three are approved at their final heads.
- Job AUD-OPUS-CM1-116 has ended.
