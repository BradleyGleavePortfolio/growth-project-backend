# AUD-OPUS-FL-119 (Claude Opus 5.5 lens, agent 119): fees F4 #684 + F4b #697 round 17/18, F5 #685 / F6 #686 restacks, LANDING candidate, #681 at the landing head

Started: Sun Oct  4 13:42:38 PDT 2026
Claims (13:43:11 PDT): lanes119/claims/backend-684-9fb9c48f-opus, backend-697-c2585c97-opus, backend-685-a61d50f4-opus, backend-686-30a118dd-opus.
Heads at start (all match JOBS119):
- #684 9fb9c48f0c8cfb2a76562c0f23ac7f3bbc652379
- #697 c2585c97e013ffbcd5c826d9547a686302e0bae6
- #685 a61d50f48a7bc2682c315367203b7301600f5854
- #686 30a118ddfd75339375ea4f6f6288669f3cbebfd5
- Checks pass=10 skipping=1 on all four. #681 e9650dc4 (BEHIND).

Notes: ops/aud-119/AUD-OPUS-FL-119/ (verdict-*.md, probe-audit-opus-fl-119-684.spec.ts, r17-spec.ts, run-*.log). Worktree wt/AUD-OPUS-FL-119-1 (no node_modules).

## Step 1: #684 + #697 (posted 13:52 PDT, heads re-read at 13:52:48)
- Delta 6b13af56..9fb9c48f, every line read:
  - 233497d5: B fixes.
  - 05bc6d31: log renames. Closed values only: moneyErrorDiagnostic, settlementFailureCode, fixed reasons, statuses.
  - 9fb9c48f: comment move.
- Builder evidence verified:
  - Failing-before 37230855089 (ccb3827e): 17 fail / 2 pass.
  - Passing-after 37230897422 (1c4437ba = a5816328 + probes): 19 suites, 242 pass. My F4-119 probe there is byte-identical to the ops copy.
  - PR CI green at all four heads (37231460850 / 37231460271 / 37231460243 / 37231460547).
- My probe run 37233481399 (branch audit/AUD-OPUS-FL-119/684-lostupdate on c2585c97):
  - r17 PASS, Opus F4-119 probe PASS, Opus F34-117 probe PASS.
  - New FL probe: L0 control PASS; L1, L2, L3 FAIL.
- **#684 @ 9fb9c48f: REQUEST CHANGES 0/1/2.** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5984274116
  - B-684-7 closed. B-684-8 closed for sequential order.
  - B-684-12 (new): lost update on the refund status write.
    - Where: refund-dispute-handler.service.ts:550-563 and :595. The status is read at :564 and written unconditionally.
    - Counterexample: a failure processed between a stale worker's read and its write is overwritten to succeeded. The apply then moves the coach's 4,630 with no alert or flag; in L2 access also ends.
    - Fix: compare-and-set on status (`updateMany where status = read status`, re-read and recompute on count 0) or do the read+write under withChargeLock.
    - Test: probe L0-L3 go into #697.
  - Cs carried: C-684-3, C-684-11.
- **#697 @ c2585c97: APPROVE 0/0/1.** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/697#issuecomment-5984274225 (C-697-3: add L0-L3 with the #684 fix).

## Step 2: #685 + #686
- Patch-ids unchanged: #685 own diff d88942b5b1d2 (= approved c5e282fb), #686 f14b1e32b05a (= approved 8cb7b2d4).
- The 4 new merges (55b21bdd, a61d50f4, 0b816233, 30a118dd) all have tree == `git merge-tree --write-tree` (no hand edits). No non-merge commits.

## Step 3: LANDING candidate 0bc3696d
- 0bc3696d = 7528454a (merge of 30a118dd + main 3e9a9a75) + baseline commit.
  - 7528454a tree f30f0878 == auto merge-tree: no hand edits.
  - Baseline commit == ops/reports/B-FEES18-119-no-pii-baseline.patch. It deletes purchase-split-handler (2) and transfer-orchestrator (1) and sets refund-dispute-handler 5 -> 4. That is tightening only: the guard demands an exact match, and an absent entry means 0.
  - Tree 317ea5ca == scratch 51bc416c, CI run 37232435047 green.
- Three auto-merged files:
  - email.service.ts: fees adds the coach-payout-adjustment subject; main's B-700-1 describeFailure is kept.
  - email.types.ts: COACH_PAYOUT_ADJUSTMENT key plus main's error comment.
  - notifications.service.ts: throttle_key, channelGate and gateFrom from fees; main's describeFailure and ticket error codes.
  - Nothing is lost. The template file src/email/templates/coach-payout-adjustment.hbs is present.
- Tree identity: every fees file equals the fees top except the 3 shared files. Every main file equals main except those 3 plus no-pii-in-logs.spec.ts.
- Migrations: one new, 20270210000000_s_fee_charge_settlement. It is byte-identical to dual-approved #681 e9650dc4, additive with RLS, and older than prod latest 20270301000000 (kept by OR-113-4). Main changed nothing under prisma.
- **LANDING CANDIDATE 0bc3696d: REQUEST CHANGES.** The merge, the baseline, the migrations and the tree identity are all correct. The candidate carries #684 9fb9c48f, so B-684-12 (and Sol's open B-684-3) apply to it. After the #684 fix round and the restack, the operator rebuilds the candidate (same recipe: merge main into the fees top, then apply the baseline patch), and a lens re-checks it the same way. notify/fees-landing.txt written 13:54:08 PDT.

## Follow-ups (C)
- C-684-3 (carried) src/checkout/refund-dispute-handler.service.ts:1168: dispute alert copy must follow R-DISPUTE-PAUSE for recurring plans (#687/#688).
- C-684-11 (carried) src/checkout/refund-dispute-handler.service.ts:282-298: a full refund is decided from amount_refunded, which counts pending refunds. Rule: use the succeeded rows vs the charge amount; on a failed/canceled refund that ended access, alert the coach (no automatic restore).
- C-697-3: r17 spec has no read/write interleave case. Add L0-L3 with the B-684-12 fix.
- Carried from others: Sol C-684-4 (payout-notice.service.ts Prisma distinct in memory); builder note (provider calls not abortable beyond the 60 s margin); C-685-3/C-686-2 fakes; C-686-4 ugx; C-686-5 chargeback copy.

- #685 @ a61d50f4: APPROVE 0/0/1. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5984283110
- #686 @ 30a118dd: APPROVE 0/0/3. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5984283221
- CI: required checks green at all four heads. The cancelled duplicates are superseded runs (this is why #685 shows UNSTABLE).

## Step 4: #681 at the landing head
- A background poller (ops/aud-119/AUD-OPUS-FL-119/poll681.sh, log poll681.log) checks #681 every 180 s from 13:54:25 for 30 min. At 13:54:25 the head was still e9650dc4.
- The landing precondition (dual APPROVE on #684/#697/#685/#686) cannot hold at these heads. Both lenses posted REQUEST CHANGES on #684 @ 9fb9c48f (Opus 5984274116, Sol 5984278756). Any fix moves #684, so the candidate sha changes and 0bc3696d cannot legitimately become #681's head. No #681 verdict was posted. #681 stays dual APPROVE at e9650dc4 (unchanged).

## Sol comparison (read after posting)
- Sol #684 @ 9fb9c48f: RC 0/2/1 (5984278756).
  - Sol's B-684-12 is the same lost-update race as mine, with the same ID and an independent proof in run 37233585543.
  - Sol B-684-3 remains open: the final awaited send boundaries (the email attempt write, then the real pushToUser token read, run past the deadline and claim). No AbortSignal or timeout reaches the provider.
  - Sol C-684-4 carried.
- Sol APPROVE on #697, #685 and #686 at the same heads.

## Operator decisions (recommended default first)
1. Hold the fees landing. Recommended: one builder round on #684.
   - B-684-12: compare-and-set the status, or move status read + write + apply decision under one charge lock, including the P2002 path.
   - Sol B-684-3: re-prove the claim after the attempt CAS, and pass a bounded AbortSignal through pushToUser and the email send.
   - Tests in #697 (724 lines of room): Opus L0-L3, Sol 37233585543 cases.
   - Then merge-only restack #685 and #686, rebuild the candidate, and get fresh dual verdicts.
2. Stripe endpoint: subscribe `refund.updated` and keep `charge.refund.updated` and `charge.refunded` (default: all three). That doubles concurrent deliveries per refund transition, which is why B-684-12 matters.
3. C-684-11 product rule: after a failed refund that ended access, alert the coach only, with no automatic restore (default).

## Cleanup
- Remote audit/AUD-OPUS-FL-119/684-lostupdate deleted (ls-remote: 0 left). Worktree wt/AUD-OPUS-FL-119-1 removed (it had no node_modules). Nothing was pushed to a PR branch. Claims stay in lanes119/claims.

## HANDOFF
Done 13:55 PDT 10-04 (the poller runs on its own until about 14:24 and needs no action).
- backend#684 @ 9fb9c48f0c8cfb2a76562c0f23ac7f3bbc652379: Opus RC 0/1/2 (5984274116), Sol RC 0/2/1. Next: a builder fix round (B-684-12 + Sol B-684-3). A fresh Opus lens then replays ops/aud-119/AUD-OPUS-FL-119/probe-audit-opus-fl-119-684.spec.ts (L0-L3 must all pass), the F4-119 and F34-117 probes, and r17.
- backend#697 @ c2585c97e013ffbcd5c826d9547a686302e0bae6: Opus APPROVE 0/0/1 (5984274225), Sol APPROVE. The fix round adds tests here, so a delta verdict is needed.
- backend#685 @ a61d50f48a7bc2682c315367203b7301600f5854: Opus APPROVE 0/0/1 (5984283110), Sol APPROVE. Restack expected; it needs a merge-tree + patch-id delta check.
- backend#686 @ 30a118ddfd75339375ea4f6f6288669f3cbebfd5: Opus APPROVE 0/0/3 (5984283221), Sol APPROVE. Same as #685.
- Landing candidate 0bc3696d: REQUEST CHANGES (it carries #684's Bs). Rebuild after the fix. The checks to repeat: merge tree == merge-tree, the baseline commit == patch, migrations unchanged vs #681, and per-file identity vs the fees top and main.
- backend#681 @ e9650dc4: no new verdict (landing head never appeared).
