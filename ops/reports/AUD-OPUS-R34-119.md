# AUD-OPUS-R34-119 — Claude Opus 5.5 lens, recurring R3 #680 + R4 #696 (T4)

Started 12:30 PDT 10-04, finished 12:49 PDT 10-04. Claims: lanes119/claims/backend-680-216489ff-opus, backend-696-276610a3-opus.
Notes and probe copies: /home/user/workspace/ops/aud-119/AUD-OPUS-R34-119/. This folder holds verdict-680.md, verdict-696.md, aud-opus-r34-119-probe.spec.ts, aud-opus-r34-119-pg-lock.spec.ts, run-37229300646.log, delta-680-handler.diff, pr673.diff, and the comments c680.txt / c696.txt.

## Verdicts
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #680 (R3) | 216489ff5fa707147b50ef0e387aba5b3079e4b1 | APPROVE | 0/0/6 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983750522 |
| #696 (R4) | 276610a3a3cc7877b30a3a5f1214e24c7cbb7eae | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696#issuecomment-5983750701 |

CI at both heads: 10 pass, 1 skip (deploy-readiness-gate). The runs are #680 37224655542 and #696 37225236249. Banned casts were checked locally and are OK for both ranges.

## Evidence
- The prior Opus APPROVE at 8e05ad0e was withdrawn (LENS NOTE 5977325672), so this lens audited fix rounds 5 and 6 in full. The handler delta from 8e05ad0e to 216489ff is 291 lines. The base move f48fa8f0 → 8bbf4a41 does not touch the handler.
- Closed with code and tests at this head:
  - Sol B-680-1, B-680-2 and B-680-3 (narrowed);
  - B-680-2 residual, B-680-5 (cases 1 and 2, plus deletion) and B-680-6;
  - B-679-10 handoff (metadata SetupIntent attach);
  - C-680-9 and C-680-10.
- C-680-8 is withdrawn: the builder's reason is sound.
- Probe lane run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229300646 at ef68d464 (head plus probe specs only). 73 tests: 67 pass, 6 fail.
  - Dead Sol authority: 11/12. The failure is B-680-5 case 2 on exact call shape only (`liftTrialEnd: true`); this lens's behavioural version passes.
  - Dead Sol PG lock: the lock part passes (windows 1, no 55P03). The metrics line fails on its stub (no `paymentReminder.create`). The builder's shim passes 2/2.
  - Opus R34-117: 12/12. Builder regressions: pass.
  - New real-PG lock-mode probe: 4/4.
  - New probe: 11 controls green, plus 4 expected-red Cs (C-680-11, C-680-12 x2, C-680-13).
- #696 is tests only. The FR5 move (53/53 titles) and FR6 move (21/21) are byte-identical apart from header comments. f0075245 models R2 round 5. 276610a3 matches R2 round 6 sendFenced → `inProgress(true)` = `PAYMENT_RETRY`.

## Follow-ups (C)
- C-680-7 — `src/checkout/checkout-webhook-handler.service.ts:785-790`. The SetupIntent lookup by `stripe_client_secret startsWith` is unindexed. Fix rule: an additive migration (> 20270316000000) adding an indexed SetupIntent id column, with an equality lookup.
- C-680-11 — `checkout-webhook-handler.service.ts:1915-1925` (main-era, main L1161). A renewal decline writes `past_due` over `unpaid`. Fix rule: write the live subscription status (past_due/unpaid), and never downgrade `unpaid`.
- C-680-12 — `checkout-webhook-handler.service.ts:90-97` `purchaseHasEnded` (main-era L793 grant-by-status).
  - Problem: a sub.updated (status active, including a `pause_collection` update) re-grants rows revoked for money reasons (chargeback_lost, disputed, refunded).
  - Fix rule: one ended-or-money-revoked predicate used by every grant writer (applySubscriptionUpdated, applyInvoicePaid, attachNativeTrialCard).
  - It must ship with the R-DISPUTE-PAUSE build (B-DUNSPLIT-119), carried by whichever of recurring or dunning lands second. Use this lens's probe cases as regressions.
- C-680-13 — `checkout-webhook-handler.service.ts:809`. `attachNativeTrialCard` does not skip ended rows. It is unreachable through R2 today. Fix rule: when `purchaseHasEnded(row)`, return ok without attaching.
- C-680-14 — `checkout-webhook-handler.service.ts:37-42` duplicates `src/checkout/subscription-plan.ts:287` `ownTrialCardOn`. Fix rule: one shared helper.
- C-680-15 — `checkout-webhook-handler.service.ts:1894-1896`. `invoice_superseded` acks a decline of a still-open older invoice. Fix rule: treat it as superseded only when the declined invoice is no longer collectible or the newer invoice is paid; otherwise run the version-fenced write.

## Findings for other PRs (operator)
- Trials #673 (5fdb5f5c) adds `subscriptionGrantsEntitlement` (any default card grants a trial) and a TrialUsage ledger in the same handler. The second to land must keep recurring's `trialOwnCardOn` (binding rule: a customer default card is never this attempt's consent) and keep one trial ledger.
- R-DISPUTE-PAUSE: see C-680-12. Stripe's `pause_collection` keeps the status `active`, and the pause itself emits `customer.subscription.updated`. Without the fence, recurring re-grants access on that very event.

## Operator decisions (recommended default)
1. Narrower past_due exemption (B-680-2 residual): accept.
2. Deletion consumes only granted or own-card trials: accept.
3. Real-PG proof as a CI-lane probe: accept.
4. Day-10 lockout plan view: owned by recurring R1, landed with the lockout stack. Accept.
5. C-680-12 owner: the B-DUNSPLIT-119 R-DISPUTE-PAUSE build adds the predicate. Default: yes, as a hard merge obligation, not a ticket.

## Log
- 12:30 rules read; claims taken.
- 12:42 delta read; lock order, #673 and dispute composition checked; #696 moves verified; probe run 37229300646 started.
- 12:47 run read (results above).
- 12:49 heads re-read (unchanged); verdicts posted (5983750522, 5983750701).
- 12:49 audit/AUD-OPUS-R34-119/680-probes deleted, worktree removed, and probe specs copied to the notes folder.

## HANDOFF
- #680 @ 216489ff: Opus APPROVE 0/0/6 posted. #696 @ 276610a3: Opus APPROVE 0/0/0 posted. No audit/* branches or worktrees remain.
- Next step: the Sol lens verdicts at these heads; then the operator lands #686 → #678 → #679 → #680 → #696 → #701.
- Short delta check after a merge-only restack onto the final fees top (fresh Opus lens):
  1. `git diff 216489ff <new #680 head> -- src/checkout/checkout-webhook-handler.service.ts src/connect/stripe-connect-api.service.ts src/notifications/coach-first-payment.service.ts` must equal the fees-side changes to those files, if any. Confirm with `git diff <old fees top> <new fees top>` on the same paths. Every conflict hunk must be read.
  2. `git diff 216489ff..<new head> -- test/` must add nothing beyond the fees merge. Likewise `git diff 276610a3..<new #696 head>` must hold no R4 test changes beyond the merges.
  3. Fees changes to `purchase-split-handler`, `refund-dispute-handler`, `runOrDeferSplit` / `DeferredSplitTask`, `stripe-connect-api` method signatures (`retrieveInvoice`, `retrieveSubscription`, `setSubscriptionDefaultPaymentMethod`), or `transfer-orchestrator` must still compile against R3's calls. Check build-and-test green at the new head.
  4. If fees touched the refund or dispute status writes (`refunded`, `chargeback_lost`, `disputed`), re-check C-680-12. Recurring writers still fence only canceled/expired/incomplete_expired.
  5. If fees adds any in-tx Stripe HTTP or any new lock on ClientPurchase or CoachPackage, re-check the lock order: package FOR UPDATE, then purchase FOR NO KEY UPDATE, with no other order anywhere.
  6. Re-run `aud-opus-r34-119-probe.spec.ts` and `aud-opus-r34-119-pg-lock.spec.ts` (copies are in the notes folder) in the CI lane at the new head. Expect the same 11 green controls and 4/4 PG, with the same 4 expected-red Cs and nothing new red.
  7. All required checks green at the new heads. On a stacked base, CodeQL, danger, banned casts and SBOM are absent, so run `check-r75 --mode=range` locally.
