# Agent 119 job board (10-04). One agent per job; one or two PRs per job (plus merge-only restacks named in the entry); END.
Re-read every head on GitHub before acting. All jobs T4 unless stated. Builders: _COMMON_116.md section 7 + _COMMON_118.md +
_COMMON_119.md. Lenses: _COMMON_116.md section 8 (claims under ops/lanes119/claims) + _COMMON_118.md + _COMMON_119.md; independent of
every builder; one verdict per PR per head; re-read the head right before posting. Repo = growth-project-backend unless "mobile".
B = https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/<n>#issuecomment-<id>; mobile = growth-project-mobile.
Older entries with full finding history: /home/user/workspace/ops/lanes118/JOBS118.md (same job names with -118).

## AUD-OPUS-F3-119 (Claude Opus 5.5) / AUD-SOL-F3-119 (GPT-6.1 Sol) — fees F3 #683 (T4: platform fees, settlement, disputes) — JOB ONE
Head: #683 cc183e0ae05158290e5db77ef645578667133e0f (base F2 #682 branch agent115/fee-split-1-ledger-foundation; 2,959 lines; operator
SIZE ASSESSMENT KEEP). F1 #681 e9650dc4 and F2 #682 70f879a2 are dual APPROVE (do not re-audit them). B-FEES16-118 FIX ROUND 16 + READY
(5983177143); report ops/reports/B-FEES16-118.md (verify every claim; failing-before run 37224835684, after run 37224855812).
Prior at 438d29e64f24e6f803a578dae56e0140a44d1c52: Opus APPROVE 0/0/4 (5982917163); Sol RC 0/2/2 (5982960241):
- B-683-7: notice write and retry-flag write both fail -> webhook still 2xx, nothing retries (Opus probe P4,
  ops/aud-118/AUD-OPUS-F23-118/audit-opus-f23-118-683.spec.ts; charge-settlement.service.ts ~:1388-1393, :1672-1675). Builder fix:
  flagForReconcile returns saved/not; recordAdjustmentNotices throws NoticeUnrecordedError (SFEE_NOTICE_UNRECORDED) when neither was
  saved, so the delivery fails and Stripe redelivers.
- B-683-8: terminal dispute intent lost during retry. Builder fix: the notice-failure flag carries the run's dispute id; currentDispute
  returns `lost` read under the lock; hint = notice_event ?? (lost ? 'dispute_lost' : null).
Audit: decide your lens's prior findings first (closing commit + failing-before test), then audit the delta 438d29e6..cc183e0a deeply
(new error path: does a non-2xx here ever double-apply money on redelivery? lock order; idempotency of the notice on redelivery;
terminal states won/lost/closed). Evidence reuse for unchanged code per _COMMON_116 section 8. RED BY DESIGN: build-and-test fails with
exactly 3 suites / 9 tests (fee-split 2, purchase-split 2, reconciliation 5) that F4 #684 carries green: verify the failing set is
exactly that (run 37225035844) and nothing else is red. R75: `node scripts/check-r75.js --mode=range
--base=b644198b90bb9ab1dc62a78794e12cf09f8ace7c --head=cc183e0a...` clean. Money list end to end. Cs stay Cs (FREEZE); findings in other
PRs go to your report. Reports: ops/reports/AUD-OPUS-F3-119.md, AUD-SOL-F3-119.md.

## AUD-OPUS-F4-119 (Claude Opus 5.5) / AUD-SOL-F4-119 (GPT-6.1 Sol) — fees F4 #684 + F4b #697 (T4: charge settlement, checkout wiring)
Heads: #684 6b13af56bf2d8a36ae5559a537ee565555a6c4c7 (base F3 #683 branch; 2,435 lines), #697 88c722003c23634df69338e4ee6ceb2dd71068e6
(base #684 branch agent115/fee-split-3-charge-settlement; 1,831 lines). Both READY (merge-only restacks FIX ROUND 16 5983285256 / FIX
ROUND 17 5983285470; own-diff patch-ids unchanged per ops/reports/B-FEES16-118.md).
History you must resolve: #684 latest verdicts are REQUEST CHANGES from both lenses at e9ee033d425a61bb48efe2ac2387a23e5347acb0 (Sol
5976704760, Opus 5976735562). B-FEES-117 FIX ROUND 13 (5977081443 at d3e8ceb2) answered them and split #697 (F4b) out of #684 for size
(#697 FIX ROUND 13 5977081535). Later rounds on #684/#697 are merge-only restacks plus operator FIX ROUND 16 on #697 (5982690240 at
1807d4cc: test-only, the Sol B-683-4 reader called directly instead of `settlementModule as unknown as Record<...>`; R75). #697 has
NEVER had a verdict. Do: (1) decide each prior finding of your lens on #684 (closing commit + failing-before test); (2) audit #697 in
full (evidence reuse only for code byte-identical to what your model approved earlier on #684, verified with git diff, and stated in
the verdict); (3) check every restack merge since d3e8ceb2 adds no own-diff change beyond named conflict resolutions; (4) verify F4
turns F2/F3's red-by-design tests green (all required checks green at both heads); (5) R75 range check clean from b644198b at #697.
Probes from earlier lenses: ops/aud-118/, ops/aud-117/, audit/AUD-SOL-F34-117/{684-refunds,684-refunds-budget}; restack probe run
37225764023. Reports: ops/reports/AUD-OPUS-F4-119.md, AUD-SOL-F4-119.md.

## B-SHEET2-119 (builder, Claude Opus 5.5, T4: payment sheet money copy) — mobile P1 #342 + P2 #343 (P3 #344 merge-only restack only)
Relaunch of B-SHEET2-118 (cancelled 11:27 before any push; its notes: ops/reports/B-SHEET2-118.md). Heads: mobile #342
56f281ad3aa977882c962a6591d3594899cdd5a1 (base main, BEHIND: merge origin/main first, merge-only, before content commits; 2,018 lines),
#343 fd739d5819c232764e0389afd778860bf452b41c (base #342 branch; 2,813 lines; 187 headroom), #344 e7fcc5d2 (NOT yours to fix). Take lock
`sheet`. Rules from JOBS118 entries B-SHEET-118, AUD-*-SH-118 and B-SHEET2-118 (copy truth: never claim charged / not charged / paid
before proof; #661 reply codes (409 PAYMENT_ALREADY_COMPLETE, PAYMENT_REFUNDED_OR_IN_REVIEW, PAYMENT_CHECKOUT_CLOSED; 503
PAYMENT_IN_PROGRESS; PAYMENT_SUCCESS_RETRY / PAYMENT_FAILURE_RETRY) and recurring codes (PLAN_CHANGE_UNCONFIRMED, SETUP_UNAVAILABLE,
trial setup) map to specific truthful copy with a working next action; works against TODAY's production backend (capability check or
truthful fallback, never a dead end); recurring never one-time-only; no first person). Findings to close:
- #342: Opus APPROVE 0/0/5 (mobile 5982679049). Sol RC 0/2/1 (mobile 5982676839): B-342-1 residual, an uncoded transport failure or
  timeout claims offline / no charge (packagePayment.ts ~:456-457, :789-790); B-342-3 zero-decimal currencies (JPY etc.) display 100x
  too small (planTerms.ts ~:150-161, :215-226 via utils/currency.ts ~:13-19): fix with each currency's minor-unit exponent for every
  zero-decimal (and three-decimal) currency, not a JPY special case.
- #343: Opus RC 0/1/5 (mobile 5982679186): B-343-6 usePackagePurchase.ts ~:746-748/:790-791 a one-time plan that became free after the
  list loaded shows "Payment received. Setting up your plan." during the free claim (fix rule: claimFree sets saleKind "free"; Opus
  CI-lane probe run 37221093192). Sol RC 0/3/2 (mobile 5982700210): B-343-1 residual, a rejected poll read bypasses the account fence
  (~:505-566); B-343-3 residual, "Open your plan" falls back to onPaymentSuccess (Opus C-343-3 same: make the action truthful, label or
  route to what it really does); B-343-6(S) an ended subscription is treated as unpaid and shows "nothing was charged" (~:623-631; Opus
  C-343-4 same lines: fold in).
Replay both lenses' probes (ops/aud-118/AUD-OPUS-SH-118/probes/, ops/aud-118/AUD-SOL-SH-118/) as failing-before tests. SIZE: if #343
would pass 3,000, move whole test files up to #344 byte-identical (after the merge) and say so. Held Cs stay held (C-342-1 isCombo red by
design, C-342-2, C-343-2). Then merge-only restack #344 so it carries your heads, with a READY (restack) comment. FIX ROUND + READY on
#342 and #343 at green heads; write notify/sheet.txt; release the lock. Report: ops/reports/B-SHEET2-119.md.

## AUD-OPUS-F56-119 (Claude Opus 5.5) / AUD-SOL-F56-119 (GPT-6.1 Sol) — fees F5 #685 + F6 #686 (restack deltas, TOP of the fees stack)
Heads: #685 c5e282fbfa3e7fe6a5593949182e17c91a011738 (base #697 branch; 2,958 lines; SIZE ASSESSMENT KEEP), #686
8cb7b2d4bee3bccb65596581f84bccf9227ffc4b (base #685 branch; 1,355 lines). Latest verdicts: #685 Opus APPROVE 0/0/3 and Sol APPROVE 0/0/1
at 858d3716; #686 Opus APPROVE 0/0/2 and Sol APPROVE 0/0/1 at 7be7d396 (find the full shas and comment ids in each thread). Since then
only merge-only restacks: operator agent 117 RESTACK (#685 5977651187, #686 5977666417), B-FEES15-118 FIX ROUND 15 (5982658088,
5982658386), operator agent 118 restack merging the #697 FR16 fix (5982690346, 5982690493), B-FEES16-118 FIX ROUND 17 (5983285638,
5983285828; own-diff patch-ids unchanged per ops/reports/B-FEES16-118.md). Verify every merge since your lens's last APPROVE adds no
own-diff change beyond named conflict resolutions (read every conflict hunk), all required checks green at both heads, and judge the
INTEGRATED fees top (#686's tree is what lands on main as one stack, rule 11): R75 range check clean from b644198b; money list end to
end on the composed tree (webhook order and redelivery, concurrency, terminal states, fail closed on incomplete Stripe lists, currency,
copy truth); migrations ordered, additive and unreleased-only (production latest 20270301000000). Fees-top probe run 37225776608 (54
expected MUTANT failures in Opus F56-116). Reports: ops/reports/AUD-OPUS-F56-119.md, AUD-SOL-F56-119.md.

## AUD-OPUS-R12-119 (Claude Opus 5.5) / AUD-SOL-R12-119 (GPT-6.1 Sol) — recurring R1 #678 + R2 #679 (MOST CRITICAL OF ALL)
Heads: #678 77bce4505b12586a0fe1080246d97217f0834f1c (base fees F6 #686 branch agent115/fee-split-6-recovery-specs; 2,411 lines), #679
8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca (base #678 branch; 2,932 lines). B-RECUR6A-118 FIX ROUND 6 + READY (#678 5982632966, #679
5982633162); report ops/reports/B-RECUR6A-118.md (verify every claim). Prior verdicts: #678 Sol APPROVE 0/0/0 at b04ea692 (5977830820),
Opus APPROVE 0/0/1 at 0c2191c0 (5977231057); #679 Sol RC 0/3/1 at 6760ee6a (5977831040: B-679-7 pre-send marker does not fence account
finalization; B-679-8 unknown rejected-bind cleanup releases the one-subscription exclusion; B-679-10 a null pending SetupIntent makes an
eligible native trial unavailable or permanently confirming), Opus RC 0/2/1 at f48fa8f0 (5977231156). Dead Opus lens probes:
audit/AUD-OPUS-R12R5-117/679-probes (B-679-10 default-card client can start a trial; B-678-2 default-card update never touches
cancel_at_period_end). Operator defaults for you to judge: accept the Sol B-679-8 probe deviation (the next key resumes the same payable
subscription, still one subscription); Stripe reads inside the 120 s deletion transaction. Binding: native PaymentSheet subscriptions
(default_incomplete, first-invoice PI), never one-time-only; real free trials (coach sets 0-30 days, card up front, one per client per
coach); a customer default card is never this attempt's consent; R-DISPUTE-PAUSE (_COMMON_119 12) is built in dunning, not here.
Context: these heads sit on the CURRENT fees top; after fees lands the operator merge-only restacks recurring onto the final fees top and
asks for a short delta at the new heads. Findings in fees, dunning or #661 code go to your report. Reports:
ops/reports/AUD-OPUS-R12-119.md, AUD-SOL-R12-119.md.

## AUD-OPUS-R34-119 (Claude Opus 5.5) / AUD-SOL-R34-119 (GPT-6.1 Sol) — recurring R3 #680 + R4 #696 (MOST CRITICAL OF ALL)
Heads: #680 216489ff5fa707147b50ef0e387aba5b3079e4b1 (base #679 branch agent115/recur-split-2-subscription-checkout; 2,766 lines), #696
276610a3a3cc7877b30a3a5f1214e24c7cbb7eae (base #680 branch; 1,910 lines; FIX ROUND 6 moved and changed real tests). B-RECUR6B-118 FIX
ROUND 6 + READY (#680 5983144676, #696 5983234958); report ops/reports/B-RECUR6B-118.md (verify every claim). Prior verdicts: #680 Sol
RC 0/3/1 at 8e05ad0e (5977195657; FIX ROUND 5 5977718408 answered it), Opus APPROVE 0/0/4 at 8e05ad0e (5977283278); #696 Sol APPROVE
0/0/0 and Opus APPROVE 0/0/0 at 34a41818 (5977195253, 5977283371). Dead Sol lens probes audit/AUD-SOL-R34R5-117/680-authority (run
37187197172: B-680-2 residual, B-680-5 x2) must pass at head. Check: setup_intent.succeeded attaches the attempt's own trial SetupIntent
(metadata tgp_purchase_id / tgp_subscription_id / tgp_checkout native_subscription_trial) and lifts the trial end only for it; webhook
order and redelivery; one subscription per client per package; trial ledger shared with trials #673. Operator defaults to judge:
narrower past_due exemption; deletion consumes only granted/own-card trials; real-Postgres proof as a CI-lane probe; the Day-10 lockout
plan view belongs to recurring R1 and lands with the lockout stack. R5 #701 (72eb096b, tests only) gets its own pair later. Same restack
context as R12. Reports: ops/reports/AUD-OPUS-R34-119.md, AUD-SOL-R34-119.md.

## AUD-OPUS-T23-119 (Claude Opus 5.5) / AUD-SOL-T23-119 (GPT-6.1 Sol) — trials T2 #672 + T3 #673
Heads: #672 2690c07c1f418f3ec2a79ba93a2ffa9748698a48 (base T1 #671 c75002c9, dual APPROVE; 2,961 lines), #673
5fdb5f5cf6fb09a23dd56382a47aafa4d0089c5d (base #672 branch; 2,887 lines). B-TR3-118 FIX ROUND 9 + READY (#672 5982762148, #673
5982762294); report ops/reports/B-TR3-118.md (verify every claim; it says a late-clock probe replay needed one read-stub line). Prior at
c5e7ed8e / df76889f: Opus APPROVE #672 0/0/5 (5982465734), #673 0/0/3 (5982465887); Sol RC #672 0/1/1 (5982319373: B-672-3 an
extension or cancellation during push preparation permits obsolete charge/date copy), #673 0/1/2 (5982336690: B-673-1 cancellation
retries can delete an already-paid subscription when its conversion webhook is delayed or missing). Decide your lens's prior findings
first, then audit both rounds deeply. Opus's red-by-design probes stay as ruled (C-672-7 date wording "Oct 13 at 12:30 AM EDT"; C-671-4).
Binding: real free trials (coach sets 0-30 days, card up front, one per client per coach, trial-ending notice); MRR/churned_30d exclude
never-billed trials (C-673-3 is on the #680 integration list, not here). Trials land after recurring with mobile #338. Findings about
recurring code go to your report. Reports: ops/reports/AUD-OPUS-T23-119.md, AUD-SOL-T23-119.md.

## B-DUNSPLIT-119 (builder, Claude Opus 5.5, T4: disputes, billing pause, access, money copy) — split dunning D2 #688; build R-DISPUTE-PAUSE; #687 dispute copy
Heads: #687 38d9b3ab (D1, base main, BEHIND; 2,974 lines, 26 headroom; FIX ROUND 2 READY), #688 2368d5fa1b5671123e2f6b330137b3ebb90be514
(D2, base #687 branch agent115/dunning-split-1-foundation; 2,976 lines; FIX ROUND 3 READY). Above (NOT yours): #689 bb992fed (base
#688 branch), #690 06307883, #691 e0afe678; B-DUNB-119 restacks them onto your new D2 top after you. Take lock `dunning`. Prior
verdicts: #687 Sol RC 0/2/0 (5982357490), Opus RC 0/1/3 (5982478903); #688 Sol RC 0/2/0 (5982357473), Opus RC 0/2/3 (5982479051); all
answered by B-DUNA-118 (report ops/reports/B-DUNA-118.md; verify every claim; keep every closure intact through the split).
Owner ruling R-DISPUTE-PAUSE (verbatim in handoffs/op-118/HANDOFF_AGENT_119.md section 9 and DECISION_LOG.md 12:03 10-04): a dispute on
any charge of a recurring plan (whether or not a renewal ever failed) immediately pauses all billing for that plan and ends the
client's access; no automatic restore when the dispute closes (won or lost); the coach restarts access separately. Replaces the
compressed dispute cycle (lock date) for recurring plans. One-time purchases unchanged. OR-111-1 still applies (coach alert with exact
amounts, reverse that charge's own transfer, forward-only netting). Cancel during a dispute cycle ends access now and never resolves
the dispute.
Do, in order:
1. Merge origin/main into #687 (merge-only) and #687 into #688 so both are current.
2. SPLIT #688 into stacked pieces; every NEW piece at or under 1,500 changed lines (owner 12:33 rule: new PRs over 1,500 fail
   automatically; add pieces rather than exceed it) (MODEL_ROUTING 8.2: each piece compiles, passes CI, carries
   its own tests, inert or flag-gated (FEATURE_DUNNING_V2 stays off) until the last lands). Shape: #688 keeps D2a; new PR D2b on
   #688's branch takes the rest of today's #688 content (byte-identical moves); new PR D2c on D2b's branch BUILDS R-DISPUTE-PAUSE.
   Write the seams and line counts in each PR body and FIX ROUND.
3. D2c: on charge.dispute.created for any charge of a recurring plan, pause all billing for that plan at Stripe and end access at once,
   idempotently; nothing restores access automatically on dispute won/lost/closed; a coach restart action (endpoint or service path,
   owner-only authz, tenant-checked) resumes billing and access. Mechanism (pause_collection vs cancel) and the restart action are your
   choice: record them in the D2c PR body with the R138 gate (DECISION_LOG.md format: Musk five principles, hyperscaler practice, GOOD
   without BAD, root cause, rollback/blast radius). Tests (failing-before where they replace old behavior): webhook order and
   redelivery (dispute before/after invoice events; duplicate deliveries), concurrency (two workers; lock order consistent with the
   existing dunning locks), terminal states (won, lost, closed, refunded, canceled, deleted account), the coach restart path, and
   one-time purchases unchanged. Pass the dispute event time as closedAt where D2 records it (B-DUNB uses it in D4).
4. #687 copy: rewrite the dispute emails / notices (client and coach) to say exactly: access has ended, billing is paused, the coach
   decides on restarting. No promise of payment, access or a charge before it is true; no first person. #687 has 26 lines of headroom:
   if the copy change needs room, move a whole test file from #687 up into D2b byte-identical (after the merge) and say so. Never push
   any PR over 3,000.
5. Replay every prior probe from both lenses (ops/aud-118/AUD-SOL-D12-118/, ops/aud-118/AUD-OPUS-D12-118/, earlier threads); money
   self-check per _COMMON_119 6. FIX ROUND (+ OPENING on new PRs, tier header in the body) + READY on #687, #688, D2b, D2c at green
   heads. Write notify/dunning.txt "dunning D2 top: #<D2c> @ <sha> (B-DUNSPLIT-119, <time>)"; release the lock. Do NOT touch #689-#691;
   findings you see in D3/D4 dispute code (they still implement the old compressed cycle) go to your report for B-DUNB-119.
Report: ops/reports/B-DUNSPLIT-119.md.

## B-CM5-119 (builder, Claude Opus 5.5, T4: coach-visible money, refunds, disputes, MRR) — coach M1 #674 + M3 #676 (+ M4 #677 restack/tests)
Heads: #674 f9e21a87bf47502458a6ae21c2393010a1279198 (base main, BEHIND; 2,948 lines), #676 ccd60bbcb6b724534cfc69547c89a68c9af32901
(base #674 branch agent115/money-split-1-refund-reversal; 2,981 lines, 19 headroom), #677 4799c6af6d66910b1096bcb941580f072421b492 (base
#676 branch; 2,918 lines). Take lock `coach`. B-CM4-118 FIX ROUND 3 (report ops/reports/B-CM4-118.md). Both lenses REQUEST CHANGES:
- #674 Sol RC 0/2/2 (5982716289) and Opus RC 0/2/6 (5982843273), same two Bs: B-674-13 the sweep checks the 23-hour idempotency window
  against its start time, not a fresh clock read at send (resend after Stripe forgot the key; Opus: Stripe 244 vs local 122, row not
  moved to review); B-674-14 a `has_more: true` empty page authorizes a second dispute reversal (fail closed on an incomplete list;
  Stripe 490 vs local 245). Opus probe run 37222417496 must go green unchanged.
- #676 Sol RC 0/1/1 (5982716659) and Opus RC 0/1/1 (5982843389): B-676-5 MRR and paying-client counts include a never-billed trial after
  its first invoice fails (probe run 37221623024). Export the billed predicate (BILLED_WHERE) so C-673-3 can use it.
Do: merge origin/main into #674 first (merge-only), fix B-674-13/14 in #674 and B-676-5 in #676, restack #676 and #677 merge-only. SIZE:
new tests go to #677; if #677 would pass 3,000, open a tests-only piece M5 on #677's branch (at or under 1,500 lines; byte-identical moves, tier header) and say
so. Never push a PR over 3,000. Replay every prior probe from both lenses (threads, ops/aud-118/AUD-*-CM-118/); money self-check per
_COMMON_119 6 (owner-only authz, reversal idempotency under redelivery and concurrency, coach-visible money equals the ledger to the cent,
MRR rule). FIX ROUND + READY on #674 and #676, READY (restack) on #677 (and M5 if opened) at green heads; write notify/coach.txt; release
the lock. Report: ops/reports/B-CM5-119.md.

## AUD-OPUS-H46-119 (Claude Opus 5.5) / AUD-SOL-H46-119 (GPT-6.1 Sol) — mobile Health Connect H4 #362 + H6 #364 (T4: health data)
Heads: mobile #362 b3bc0ce4d7e62763671881e6babd60aa518203cc (base H3 #361 574b32a8, dual APPROVE; 2,835 lines), #364
529ba34524844403eb034dc1519ced21d208346c (base H5 #363 branch; 2,937 lines; top of the HC stack: its tree is what lands). B-HC4-118 FIX
ROUND 2 + READY (#362 mobile 5983281769, #364 5983281999); report ops/reports/B-HC4-118.md (verify every claim). Prior at
439937c9 (#362): Sol RC 0/4/1 (5982471782: raw retirement-error logging; stale account-A disconnect deletes account B's authorization;
health reads continue after disconnect; empty-import guidance dismissed by the real parent), Opus RC 0/2/4 (5982561308: B-362-1 an
empty first import closes the sheet as if it worked; B-362-2 "Then tap Try again" with no Try again button); IDs collide between
lenses, mapping in ops/reports/AUD-OPUS-H45-118.md. Prior at a3206441 (#364): Sol RC 0/1/1 (5982566404), Opus RC 0/2/4 (5982643511:
B-364-1 Samsung Health row never truthful after a Samsung connect; B-364-2 Health Connect privacy-policy link opens the normal screen).
Decide your lens's prior findings first (closing commit + failing-before test), then audit both heads deeply and judge the H1-H6
integrated top at #364. Stack rules: flag off, land H1-H6 as one, permission and copy truth (what is read, when, and what the copy
says), identity/session fences across account switch, no raw provider error or health value in logs, no first person. Operator
defaults to judge: Play privacy URL https://app.trygrowthproject.com/privacy; the Samsung row mirrors Health Connect; no-session
Disconnect retires the source for every account on the phone. Late-data / resumable import (C-360-1/2) are a ruled follow-up, not a
blocker. H5 #363 (2858bac5, restack) gets a short delta after you. Never name the clinic partner. Reports:
ops/reports/AUD-OPUS-H46-119.md, AUD-SOL-H46-119.md.

## AUD-OPUS-L12-119 (Claude Opus 5.5) / AUD-SOL-L12-119 (GPT-6.1 Sol) — mobile lockout L1 #352 + L2 #353 (T4: billing lockout, entitlement UI)
Heads: mobile #352 ac244d22e107e93209a5e1d206d2951d3392fe38 (base main; 2,341 lines; inert dunning API, update-card flow, error copy),
#353 05d84f27261f1f764214be5a379785ba8f690d3e (base #352 branch; 2,520 lines; lockout screen, banner, Update card screen). B-LOCK-118
FIX ROUND 1 + READY (#352 mobile 5982675004, #353 5982675120); report ops/reports/B-LOCK-118.md (verify every claim). Prior at
58b80914 / e22acc84: #352 Opus APPROVE 0/0/6 (5977022730), Sol RC 0/1/0 (5976926738); #353 Opus RC 0/4/5 (5977022872), Sol RC 0/3/3
(5976938374). Decide your lens's prior findings first, then audit both heads deeply. Lands after the dunning backend deploys, flag
off, as one unit #352 -> #354; must behave truthfully against TODAY's production backend (capability check or truthful fallback,
never a lockout the server did not decide). Copy rules (binding): retries Days 1/3/7, Day-10 lockout, card update during dunning
auto-charges the open invoice and unlocks on success, cancel during dunning ends access now, voluntary cancel keeps access to period
end, free/code grants never enter dunning, no first person, no promise before it is true. NEW binding ruling R-DISPUTE-PAUSE
(_COMMON_119 item 12): a dispute on a recurring plan pauses billing and ends access at once, nothing restores automatically, the coach
restarts access; any dispute copy or state in these PRs that promises a restore, a lock date or a retry for disputes is a B (the
backend piece is being built now by B-DUNSPLIT-119; judge against the ruling, not the old compressed cycle). L3 #354 (f084cc0f,
restack) gets a short delta later. Reports: ops/reports/AUD-OPUS-L12-119.md, AUD-SOL-L12-119.md.

## AUD-OPUS-W12-119 (Claude Opus 5.5) / AUD-SOL-W12-119 (GPT-6.1 Sol) — mobile coach setup W1 #345 + W2 #346 (T4: Stripe Connect onboarding, money setup)
Heads: mobile #345 97c9005e644ebc13731d1477bfecc270a10552fd (base main; 2,580 lines; setup API, create intent, Connect copy, QR; inert),
#346 2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60 (base #345 branch; 2,609 lines; checklist, first package, get-paid, invite, setup
screen). B-WIZ-118 FIX ROUND 1 + READY (#345 mobile 5982572052, #346 5982579141); report ops/reports/B-WIZ-118.md (verify every
claim). Prior at a4e49588 / 4522eb8e: #345 Sol RC 0/3/0 (5976946494), Opus RC 0/2/3 (5977036236: B-345-1 cadence change dropped;
B-329-5 create after unmount/account change); #346 Sol RC 0/2/1 (5976966221), Opus RC 0/2/3 (5977036337). Decide your lens's prior
findings first, then audit both heads deeply. Must work truthfully against TODAY's production backend (coach backend #674-#677 is not
deployed: capability check or truthful fallback, never a state the server did not confirm). Binding: recurring packages are first
class (never one-time-only), real free trials (coach sets 0-30 days), Connect onboarding copy matches what Stripe and the server
confirm, no first person, no promise of payout/charge before it is true. Lands #345-#351 as one after the coach backend
deploys. W3 #347 (3beab160, restack) needs its own fix round later (B-WIZ-118 HANDOFF lists its follow-ups). Reports:
ops/reports/AUD-OPUS-W12-119.md, AUD-SOL-W12-119.md.

## B-FEES18-119 (builder, Claude Opus 5.5, T4: payouts, refunds, access) — fees F4 #684 (+ tests in #697; merge-only restack #697 -> #685 -> #686)
Heads: #684 6b13af56bf2d8a36ae5559a537ee565555a6c4c7 (base #683 branch agent115/fee-split-3-charge-settlement; 2,435 lines; grandfathered,
ceiling 3,000), #697 88c722003c23634df69338e4ee6ceb2dd71068e6 (tests only; 1,831), #685 c5e282fb (2,958), #686 8cb7b2d4 (1,355; fees
top; recurring #678 sits on its branch: do NOT touch recurring). Take lock `fees`. #681-#683 are dual APPROVE at their heads: do not
touch them. JOB ONE: recurring is stacked on fees.
Findings to close (AUD-SOL-F4-119, #684 RC 0/3/1, 5983705658; report ops/reports/AUD-SOL-F4-119.md, probes ops/aud-119/AUD-SOL-F4-119/,
run 37229108434 = 7 acceptance failures):
- B-684-3 (partially closed): payout-notice.service.ts:169-171,182-196,219-242,338-370,398-430: claim/read vs deadline races remain.
- B-684-4: checkout-webhook-handler.service.ts:219-228, refund-dispute-handler.service.ts:145-148,175-180: the outer production router does
  not forward refund.updated, so its handling is unreachable. Also state in your report whether the production Stripe endpoint must
  subscribe to refund.updated (operator checks the endpoint's enabled events).
- B-684-5: refund-dispute-handler.service.ts:479-540 (522-528): a pending charge.refunded at cumulative zero followed by a succeeded full
  refund (refund.updated) leaves access active.
AUD-OPUS-F4-119 is still auditing #684/#697 at these heads: the operator will message you its verdict; fold any A/B from it into the
same round before you push (check the #684/#697 threads before pushing too). Sol APPROVE on #697 0/0/1 (5983685798) covers tests only.
Do: fix in #684 with failing-before tests (Sol's probe bundle must go green unchanged); put new regression tests in #697 (headroom
1,169 to its ceiling); merge-only restack #697 -> #685 -> #686 (no other changes; prove own-diff patch-ids unchanged for #685/#686).
Money self-check (_COMMON_119 6), R75 range check from b644198b. FIX ROUND + READY on #684 and #697, READY (restack) on #685 and #686 at
green heads (#682/#683 stay red by design until #684's fix lands on main; #684 itself must be green). Write notify/fees.txt
"fees top: #686 @ <sha> (B-FEES18-119, <time>)"; release the lock. Report: ops/reports/B-FEES18-119.md.

## B-RECUR7A-119 (builder, Claude Opus 5.5, T4: subscriptions, account deletion, money) — recurring R1 #678 + R2 #679 (+ tests in R5 #701)
Heads: #678 77bce4505b12586a0fe1080246d97217f0834f1c (base fees #686 branch; 2,411), #679 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca (base
#678 branch; 2,932: only 68 lines of headroom to its 3,000 ceiling), #701 72eb096b (tests only, base #696 branch; 416). Take lock
`recurring-r12`. MOST CRITICAL OF ALL. Do NOT merge any fees change into #678 (the operator restacks recurring onto the final fees top
after fees lands). B-RECUR7B-119 owns #680/#696 and pushes only after your notify line.
Findings to close (AUD-SOL-R12-119: #678 RC 0/2/2 5983682649, #679 RC 0/2/1 5983707659; report ops/reports/AUD-SOL-R12-119.md, probes
ops/aud-119/AUD-SOL-R12-119/ incl. probes678.patch and the real-PostgreSQL lock proof, runs 37228923406, 37229223645, 37229082643):
- B-678-3: src/account-deletion/account-deletion.billing.ts:90-99 selects only client-owned unbound attempts and client-prefixed keys:
  coach deletion misses uncertain unbound subscriptions.
- B-678-4: src/checkout/subscription-attempt.ts:50-73 locks only the client, not the coach: send authority does not fence coach
  finalization (two real PostgreSQL sessions).
- B-679-10 (narrowed): src/checkout/subscription-checkout.service.ts:1025-1045 still treats a customer default card as a settled trial
  (retained default-only retirement classification).
- B-679-11: abandoned history can hide an older billable plan (plan-list completeness).
AUD-OPUS-R12-119 is still auditing these heads: the operator will message you its verdict; fold any A/B into the same round. Sol's
operator defaults accepted: same-subscription reuse; bounded Stripe reads inside finalization.
Do: fixes in #678 and #679 with failing-before tests; #678 tests in #678; #679 tests in #701 (never push #679 over 3,000; if a fix
itself does not fit #679, move a whole existing #679 test file byte-identical into #701 and say so). Merge-only propagate your new
#679 into nothing else: write notify/recurring.txt "R2 top: #679 @ <sha>; #701 tests @ <sha> (B-RECUR7A-119, <time>)" as soon as
#678/#679 are pushed green, so B-RECUR7B-119 can restack #680 -> #696 -> #701 on top. Replay both lenses' prior probes (threads,
ops/aud-118/*R12*, audit/AUD-OPUS-R12R5-117/679-probes, ops/aud-119/AUD-*-R12-119/). FIX ROUND + READY on #678/#679 at green heads.
Report: ops/reports/B-RECUR7A-119.md.

## B-RECUR7B-119 (builder, Claude Opus 5.5, T4: subscriptions, access, money) — recurring R3 #680 (+ tests in R4 #696; restack #701)
Heads: #680 216489ff5fa707147b50ef0e387aba5b3079e4b1 (base #679 branch; 2,766), #696 276610a3 (tests; 1,910), #701 72eb096b (tests;
416). Take lock `recurring-r34`. Findings (AUD-SOL-R34-119 #680 RC 0/2/1 5983671709; report ops/reports/AUD-SOL-R34-119.md, probes
ops/aud-119/AUD-SOL-R34-119/, runs 37228714856, 37228836878 = 7 assertion failures): B-680-1 residual terminal authority: terminal or
revoked purchases can regain access (preserve revoked access unconditionally; R-DISPUTE-PAUSE depends on it); B-680-2 residual: a paid
write can also enter past_due, bypassing the stale-decline fence (strict redelivery after superseding writes). Plus AUD-OPUS-R34-119's
verdict (operator messages it). Do: develop the fixes at once in your worktree on the current #680; push NOTHING until
notify/recurring.txt shows B-RECUR7A-119's R2 line; then merge the new #679 into #680 (merge-only commit first), apply your fixes,
put tests in #696, merge-only #680 -> #696 -> #701 (keep B-RECUR7A's tests in #701). Never push a PR over 3,000. Replay both lenses'
prior probes (incl. audit/AUD-SOL-R34R5-117/680-authority). FIX ROUND + READY on #680 and #696, READY (restack) on #701 at green
heads; append "R5 top: #701 @ <sha> (B-RECUR7B-119, <time>)" to notify/recurring.txt. Report: ops/reports/B-RECUR7B-119.md.

## B-TR4-119 (builder, Claude Opus 5.5, T4: free trials, subscription cancellation, money copy) — trials T2 #672 + T3 #673
Heads: #672 2690c07c1f418f3ec2a79ba93a2ffa9748698a48 (base T1 #671 c75002c9, dual APPROVE, do not touch; 2,961 lines: 39 headroom to its
ceiling), #673 5fdb5f5cf6fb09a23dd56382a47aafa4d0089c5d (base #672 branch; 2,887: 113 headroom). Take lock `trials`. Verdicts at these
heads: Opus APPROVE #672 0/0/5 (5983711171), #673 0/0/5 (5983711331); Sol RC #672 0/1/1 (5983682719), #673 0/2/1 (5983683888).
Findings to close (report ops/reports/AUD-SOL-T23-119.md, probes ops/aud-119/AUD-SOL-T23-119/, runs 37228826610, 37228997327 = 4
behavioral failures):
- B-672-3 (narrowed): customer-card admission during final push preparation still permits obsolete charge/date copy (customer-card
  removal during final preparation).
- B-673-1 (narrowed): already-billed subscriptions currently past_due/unpaid are treated as never-billed, so cancellation can delete a
  plan that already paid (Opus C-673-5 is the same input).
- B-673-2: a committed webhook supersession does not veto an obsolete DELETE, revoking paid access.
Also fix Opus C-673-4 only if it is the same code path as B-673-2 (out-of-order active then trialing redelivery leaves a paying client
without access); otherwise leave it for the #680 integration round and say so.
SIZE: new tests go into a NEW tests-only PR T4 on #673's branch (at or under 1,500 lines; tier header; byte-identical moves allowed);
code fixes in #672/#673 must keep each under 3,000. Replay both lenses' prior probes (threads; ops/aud-118/*T23*; ops/aud-119/AUD-*-T23-119/;
Opus's red-by-design probes stay as ruled). FIX ROUND + READY on #672/#673 and OPENING + READY on T4 at green heads; write
notify/trials.txt; release the lock. Report: ops/reports/B-TR4-119.md.

## AUD-OPUS-S12-119 (Claude Opus 5.5) / AUD-SOL-S12-119 (GPT-6.1 Sol) — mobile payment sheet P1 #342 + P2 #343 (T4: money copy, payment flow)
Heads: mobile #342 0b1985f46ae2d4baadfcc6a02f8257c2f504249d (base main, main merged in; 2,153 lines), #343
19678ce780d497513764a7827447c106fb14205e (base #342 branch; 2,933 lines: 67 headroom; a 71-line contrast test moved byte-identical to
#344). B-SHEET2-119 FIX ROUND 2 + READY (#342 mobile 5983790118, #343 5983790258); report ops/reports/B-SHEET2-119.md (verify every claim:
19 failed-before / 81 of 82 after on #342; 16 / 101 of 102 on #343; the remaining reds are the held C-342-1 probe and an old "nothing was
charged" assertion that B-342-1 removed on purpose). Prior at 56f281ad / fd739d58: #342 Opus APPROVE 0/0/5 (5982679049), Sol RC 0/2/1
(5982676839: timeout claims no charge; zero-decimal amounts 100x too small); #343 Opus RC 0/1/5 (5982679186: B-343-6 free claim shows
"Payment received"), Sol RC (thread: B-343-1, B-343-3, B-343-6). Decide your lens's prior findings first, then audit both heads deeply.
Rules (AUD-*-SH-118 entry in ops/lanes118/JOBS118.md, binding): never claim charged/not charged/paid before proof; #661 reply codes
(409 PAYMENT_ALREADY_COMPLETE, PAYMENT_REFUNDED_OR_IN_REVIEW, PAYMENT_CHECKOUT_CLOSED; 503 PAYMENT_IN_PROGRESS; PAYMENT_SUCCESS_RETRY /
PAYMENT_FAILURE_RETRY) and recurring codes (PLAN_CHANGE_UNCONFIRMED, SETUP_UNAVAILABLE, trial setup) map to specific truthful copy with
a working next action; trial starts never show payment-complete copy; must work against TODAY's production backend (capability check or
truthful fallback); recurring never one-time-only; no first person. The currency fix uses each currency's minor-unit exponent (judge
ISK/UGX special cases against Stripe's currency rules) and also changes coach screens (operator default: accept). Lands with recurring.
P3 #344 is B-SHEET3-119's. Reports: ops/reports/AUD-OPUS-S12-119.md, AUD-SOL-S12-119.md.

## B-SHEET3-119 (builder, Claude Opus 5.5, T4: payment sheet, plan management, money copy) — mobile payment sheet P3 #344
Head: mobile #344 25af65691fbf60a3501a77624de8eafd0ccd81d3 (base #343 branch; 2,156 lines; restacked by B-SHEET2-119 with two test-only
commits: the moved 71-line contrast test and B-SHEET-118's trial-fixture date commit). Take lock `sheet`. #342/#343 are under lens
review now (AUD-*-S12-119): do not touch them; if their lenses force a change, the operator tells you to merge the new #343 (merge-only).
Findings to close (report ops/reports/AUD-SOL-SH3-118.md and AUD-OPUS-SH3-118.md; Sol RC 5982674874, Opus RC 5982759668):
- B-344-1 YourPlansPanel silently hides an initial list failure (404 absent production route or transient 503) while Membership promises
  plan management there.
- B-344-2 every cancellation dialog promises continued paid-period access, but the backend immediately ends an unpaid dunning plan
  (binding: cancel during dunning ends access now; voluntary cancel keeps access to period end; R-DISPUTE-PAUSE: a disputed recurring
  plan has access ended and billing paused; only the coach restarts).
- B-344-3 a successful resume's returned active-plan view is discarded; if the reload fails the app keeps saying "Nothing more is
  charged".
- B-344-4 panel notices drop the shared mapper's support action; the error says "email support" with no way to do it.
- B-344-5 YourPlansPanel.tsx:39-42,55-56,95,105-151 past-due plans: End my plan confirmation promises "stays active until" for a plan in
  dunning (Opus); B-344-6 per AUD-OPUS-SH3-118.md (replay ops/aud-118/AUD-OPUS-SH3-118/audOpusSH3118.yourPlans.probe.test.tsx: all 9 must
  pass).
Must work against TODAY's production backend (the plan list route may be absent: truthful fallback, never a dead end). Replay both
lenses' prior probes. Keep #344 under 3,000 (grandfathered). FIX ROUND + READY on #344 at a green head; write notify/sheet.txt; release
the lock. Report: ops/reports/B-SHEET3-119.md.

## AUD-OPUS-R12D-119 (Claude Opus 5.5) / AUD-SOL-R12D-119 (GPT-6.1 Sol) — recurring R1 #678 + R2 #679 FIX ROUND 7 (MOST CRITICAL OF ALL)
Heads: #678 09e159d83e192e9718bef7a493aa18944022eb0b (2,594 lines), #679 23d2c04c3d05cfc5a6594700152a9cf5336f3111 (2,943; 57 headroom).
B-RECUR7A-119 FIX ROUND 7 + READY (#678 5983942447, #679 5983962316); report ops/reports/B-RECUR7A-119.md (verify every claim). Your
lens's verdicts at the previous heads 77bce450 / 8bbf4a41: Opus APPROVE #678 0/0/2 (5983746979), #679 0/0/1 (5983747222); Sol RC #678
0/2/2 (5983682649: B-678-3 deletion misses uncertain unbound subscriptions incl. coach-owned; B-678-4 send authority does not fence coach
finalization), #679 0/2/1 (5983707659: B-679-10 default card counted as a settled trial; B-679-11 abandoned history hides an older billable
plan). Your own previous report is ops/reports/AUD-<LENS>-R12-119.md (probes ops/aud-119/AUD-<LENS>-R12-119/): replay your probes at
the new heads. Audit the FIX ROUND 7 delta deeply (git diff old..new, every changed line), confirm each B closed with failing-before
evidence, that nothing regressed (money list: webhook order and redelivery, concurrency incl. the real-PostgreSQL two-session lock
proof, terminal states, list pagination and completeness: the plan list shows every live plan, ended history capped at 50; currency;
copy truth), and judge the builder's two decisions (coach deleted mid-checkout shows "attempt expired (timed out)"; ended-history cap 50:
operator default accept both as Cs). #701 @ 5e8f1ceb holds #679's 5 new tests and is red until B-RECUR7B-119 restacks it: read those
tests as part of #679's proof (they passed 525/525 merged locally), but post verdicts only on #678 and #679. Reports:
ops/reports/AUD-OPUS-R12D-119.md, AUD-SOL-R12D-119.md.

## B-SHEET4-119 (builder, Claude Opus 5.5, T4: payment sheet money copy, account fences) — mobile P1 #342 + P2 #343 (+ merge-only restack P3 #344)
Heads: mobile #342 0b1985f46ae2d4baadfcc6a02f8257c2f504249d (2,153), #343 19678ce780d497513764a7827447c106fb14205e (2,933: 67 headroom),
#344 8f53887a6fe12a928313fde3f4464a2ee0630f3d (FR3 READY by B-SHEET3-119; 2,728). Take lock `sheet`. Verdicts at these heads: Opus
APPROVE #342 0/0/6 (5983935012), #343 0/0/6 (5983935229); Sol RC #342 0/1/6 (5983977653), #343 0/1/6 (5984020426). Close Sol's two Bs
(report ops/reports/AUD-SOL-S12-119.md; probes ops/aud-119/AUD-SOL-S12-119/ and the S12B worktrees; runs 37231087077 = 2 failed,
37231087091 = 9 failed incl. one S1-owned):
- #342 residual B-342-1: after an unknown native outcome, package archival makes the same-key retry return PACKAGE_NOT_FOUND and the
  copy still asserts nothing was charged (production backend 3e9a9a75 checks availability before the key lookup). Fix rule: an
  archived/not-found refusal after an unknown same-key attempt is "not confirmed" (keep the key, plan + support actions), never "not
  charged".
- #343 residual B-343-1: a rejected initStripe / initPaymentSheet await bypasses live() in runSheet's catch; logout/login then rejection
  publishes the old account's notice/reference. Fix rule: every await in the sheet path, fulfilled or rejected, is epoch/account fenced.
Opus Cs that sit on the same lines may be folded in (say which); others stay follow-ups. SIZE: #343 has 67 lines: new tests go to #344
(grandfathered, keep under 3,000); if #344 cannot take them, open a tests-only P4 on #344's branch (at or under 1,500). Merge-only
restack #344 after your #343 push (B-SHEET3-119's FR3 content must survive unchanged; prove patch-ids). Replay both lenses' probes at
your heads. FIX ROUND + READY on #342/#343, READY (restack) on #344 at green heads; write notify/sheet.txt; release the lock. Report:
ops/reports/B-SHEET4-119.md.

## B-HC5-119 (builder, Claude Opus 5.5, T4: health data, identity fences) — mobile Health Connect H4 #362 (+ tests in H5 #363; merge-only restack H6 #364)
Heads: mobile #362 b3bc0ce4d7e62763671881e6babd60aa518203cc (base H3 #361, dual APPROVE: do not touch; 2,835: 165 headroom), #363
2858bac5cdced8ba4941be50b471f4d53908eb42 (982), #364 529ba34524844403eb034dc1519ced21d208346c (2,937: 63 headroom; DUAL APPROVE at this
head, Opus 5983806176, Sol 5983779549). Take lock `hc`. Verdicts on #362: Opus APPROVE 0/0/3 (5983805919); Sol RC 0/2/1 (5983778382).
Close Sol's two Bs (report ops/reports/AUD-SOL-H46-119.md; probes ops/aud-119/AUD-SOL-H46-119/; runs 37229474471, 37229689090):
- B-362-2 (partially open): onDeviceState.ts:158-168 checks the old grant, then awaits key enumeration; a newer consent written while
  enumeration waits is deleted on release (not atomic across storage awaits; also the no-session branch in useWearableConnections).
  Fix rule: local retirement is atomic per grant generation: never delete a consent newer than the one checked.
- B-362-6: useWearableConnections.ts:150-156 performs no session check between either pre-request storage await and the DELETE:
  switching account A -> B during identity capture or local-grant capture still sends A's Disconnect through B's authenticated
  transport. Fix rule: re-check the session/account epoch after every await and before the request; abort if changed.
Opus Cs on the same lines (C-362-6 comment, C-362-8 storage read error) may be folded in; say which. Stack rules: flag off, land H1-H6 as
one, no raw provider error or health value in logs, permission and copy truth, no first person. SIZE: new tests go to #363 (H5);
#362/#364 stay under 3,000. Merge-only restack #363 then #364 (prove #364's own-diff patch-ids unchanged). Replay both lenses' probes.
FIX ROUND + READY on #362 (and #363 for the tests), READY (restack) on #364 at green heads; write notify/hc.txt; release the lock.
Report: ops/reports/B-HC5-119.md.

## AUD-OPUS-T23D-119 (Claude Opus 5.5) / AUD-SOL-T23D-119 (GPT-6.1 Sol) — trials T2 #672 + T3 #673 FIX ROUND 10 + new T4 #706
Heads: #672 62c2c066a9347dcf16ad45d010f5434e85ae1a60 (2,968), #673 904b964250f4b7694b24f78fdef5a5f846957013 (2,947; merges #672), NEW #706
a3f011638f29d80d92115b90ba0897a24f6ae709 (tests only, base #673 branch; 423; new-PR size rule: at or under 1,500). B-TR4-119 FIX ROUND 10
+ READY (#672 5984032484, #673 5984069501, #706 OPENING 5984106695); report ops/reports/B-TR4-119.md (verify every claim; before run
37230366374, after 37231152495 = 280/291 with 11 ruled/expected reds listed in the FIX ROUNDs). Your lens's previous verdicts at
2690c07c / 5fdb5f5c: Opus APPROVE #672 0/0/5 (5983711171), #673 0/0/5 (5983711331); Sol RC #672 0/1/1 (5983682719: B-672-3 customer-card
admission during final preparation), #673 0/2/1 (5983683888: B-673-1 past_due/unpaid treated as never-billed; B-673-2 committed
supersession does not veto an obsolete DELETE). Previous reports ops/reports/AUD-<LENS>-T23-119.md, probes ops/aud-119/AUD-<LENS>-T23-119/.
Audit the round-10 delta deeply (REPEATABLE READ snapshot for purchase + customer card; paid-invoice completeness before cancelling
past_due/unpaid; supersession/deletion/lease takeover vetoes the DELETE), replay your probes, and audit #706's tests. Builder decision
for Sol: its customer-card probe matches "will be charged" inside the correct no-card copy "nothing will be charged": narrow the probe
(operator default; no copy change). C-673-4 stays on the #680 integration round. Post verdicts on #672, #673 and #706. Lands T1 #671 ->
T2 -> T3 -> T4 #706 as one, after recurring. Reports: ops/reports/AUD-OPUS-T23D-119.md, AUD-SOL-T23D-119.md.

## AUD-OPUS-R34D-119 (Claude Opus 5.5) / AUD-SOL-R34D-119 (GPT-6.1 Sol) — recurring R3 #680 + R4 #696 FIX ROUND 7 (+ R5 #701 restack) (MOST CRITICAL OF ALL)
Heads: #680 f267417a3ccd0864d3c8ba848323da16225d7aab (2,779; merge of new #679 23d2c04c first, then the fix), #696
13c9a6c8a8f237f1d2ebf2cf280828f2fed778cb (2,197; merge + new test/b-recur7b-119-authority.spec.ts), #701 d624144c (615; merge-only, keeps
B-RECUR7A's #679 tests). B-RECUR7B-119 FIX ROUND 7 (#680 5984124704, #696 5984124842, #701 RESTACK 5984124986; pushed by the operator from
the builder's commits); report ops/reports/B-RECUR7B-119.md, evidence ops/aud-119/B-RECUR7B-119/ (failing-before 37231939325 = 24 fail;
passing-after + probe replay on d624144c 37231956053 = 303 pass / 8 by-design or known). Your lens's verdicts at 216489ff / 276610a3:
Opus APPROVE #680 0/0/6 (5983750522), #696 0/0/0 (5983750701); Sol RC #680 0/2/1 (5983671709: B-680-1 terminal/revoked purchases can regain
access; B-680-2 a paid write into past_due bypasses the stale-decline fence), Sol APPROVE #696 (5983672143). Previous reports
ops/reports/AUD-<LENS>-R34-119.md, probes ops/aud-119/AUD-<LENS>-R34-119/. Audit the round-7 delta deeply: REVOKED_STATUSES now
includes refunded, chargeback_lost, disputed (no access) and nothing restores access (incl. customer.subscription.updated with
pause_collection: Opus C-680-12 hard obligation); the past_due exemption is removed (any write after the decline read redelivers:
operator accepts this override of the earlier "narrower exemption" default); C-680-11 decline keeps unpaid. Verify #680 and #696 are
green at the exact heads before posting; #701 must be green too (its 5 #679 tests now compose). Known open product question (do not
block on it, record a C if relevant): a full refund on a recurring plan revokes access but Stripe keeps billing (C-680-16; owner
decision pending, default pause billing like R-DISPUTE-PAUSE). Post verdicts on #680, #696 and #701. Reports:
ops/reports/AUD-OPUS-R34D-119.md, AUD-SOL-R34D-119.md.

## AUD-OPUS-FL-119 (Claude Opus 5.5) / AUD-SOL-FL-119 (GPT-6.1 Sol) — fees F4 #684 + F4b #697 round 17/18, F5/F6 restacks, and the LANDING candidate
Heads: #684 9fb9c48f0c8cfb2a76562c0f23ac7f3bbc652379 (FIX ROUND 17; 2,679), #697 c2585c97e013ffbcd5c826d9547a686302e0bae6 (FIX ROUND 18;
2,276; new spec test/s-fee-r17-refund-routing-status-notice-boundaries.spec.ts), #685 a61d50f48a7bc2682c315367203b7301600f5854 (restack,
own-diff patch-id d88942b5b1d2 unchanged), #686 30a118ddfd75339375ea4f6f6288669f3cbebfd5 (fees top; restack, patch-id f14b1e32b05a
unchanged). #681 e9650dc4, #682 70f879a2, #683 cc183e0a are DUAL APPROVE and unchanged. B-FEES18-119 report ops/reports/B-FEES18-119.md
(verify every claim: failing-before 37230855089 = 17 fail; passing-after 37230897422 with every prior probe replayed; scratch fees top +
main 37232435047 green on all five jobs, 12,867 tests).
Previous verdicts at 6b13af56 / 88c72200: #684 Sol RC 0/3/1 (5983705658: B-684-3 payout-notice claim/read vs deadline races; B-684-4
refund.updated not routed; B-684-5 pending charge.refunded then succeeded full refund leaves access), Opus RC 0/2/4 (5983739251: B-684-7 =
Sol B-684-4; B-684-8 a late older event rewrites a failed refund to succeeded and reverses the coach's money); #697 dual APPROVE tests only.
#685/#686 dual APPROVE at c5e282fb / 8cb7b2d4. Previous reports ops/reports/AUD-<LENS>-F4-119.md and AUD-<LENS>-F56-119.md (+ probes).
Do, in order:
1. #684 + #697: audit the round-17/18 delta deeply (every changed line), confirm each B closed with failing-before evidence, replay your
   probes, money list end to end (webhook order and redelivery incl. refund.updated + charge.refund.updated + charge.refunded, monotonic
   refund status, concurrency, terminal states, fail closed on incomplete lists, currency, copy truth). C-686-3 log renames are commit
   05bc6d31 in #684 (internal codes only; verify no personal data is logged). Post verdicts on #684 and #697.
2. #685 + #686: verify the restack merges add no own-diff change (patch-ids), all checks green; post verdicts on both.
3. LANDING candidate: branch wip/op119/land-fees @ 0bc3696d2bd1a25a4e963776db6f7f531881e4eb = merge of origin/main 3e9a9a75 into the
   fees top 30a118dd (git auto-merged src/email/email.service.ts, src/email/email.types.ts, src/notifications/notifications.service.ts),
   plus one commit lowering main's legacy log-exception baseline in test/privacy/no-pii-in-logs.spec.ts (C-686-3 ratchet; patch
   ops/reports/B-FEES18-119-no-pii-baseline.patch). Its tree equals the scratch tree CI-proved in run 37232435047 (tree 317ea5ca).
   Audit the three merged files (no lost template/type/route), the baseline edit (tightening only), migrations (one new:
   20270210000000_s_fee_charge_settlement, additive; production latest 20270301000000; OR-113-4 keeps pending prefixes), and that the
   landed tree = audited fees content + main. Record "LANDING CANDIDATE 0bc3696d: APPROVE / REQUEST CHANGES" in your report and write
   one line to /home/user/workspace/ops/lanes119/notify/fees-landing.txt.
4. The operator lands fees as one when #684/#697/#685/#686 have dual APPROVE: piece branches fast-forward to the candidate and #681's
   head becomes 0bc3696d. Poll `gh pr view 681 --json headRefOid` every 3 minutes for up to 30 minutes after step 3; when it equals
   0bc3696d2bd1a25a4e963776db6f7f531881e4eb, post your #681 verdict at that exact head (judge the whole fees stack + main as landed;
   required checks must be green at that head; if CI is still running, wait for it within the 30 minutes). If it never appears, say so and
   END.
Reports: ops/reports/AUD-OPUS-FL-119.md, AUD-SOL-FL-119.md.

## B-FEES19-119 (builder, Claude Opus 5.5, T4: refunds, payouts, concurrency) — fees F4 #684 (+ tests in #697; merge-only restack #685 -> #686)
Heads: #684 9fb9c48f0c8cfb2a76562c0f23ac7f3bbc652379 (2,679; ceiling 3,000), #697 c2585c97e013ffbcd5c826d9547a686302e0bae6 (2,276; DUAL
APPROVE), #685 a61d50f4 (DUAL APPROVE), #686 30a118dd (fees top; DUAL APPROVE; recurring #678 sits on its branch: do not touch recurring).
#681-#683 DUAL APPROVE: do not touch. Take lock `fees`. JOB ONE, and this is the third round on B-684-3: make it final.
Both lenses RC on #684 at 9fb9c48f (Opus 0/1/2 5984274116; Sol 0/2/1 5984278756; reports ops/reports/AUD-OPUS-FL-119.md,
AUD-SOL-FL-119.md; probes ops/aud-119/AUD-*-FL-119/; runs 37233481399 Opus = 3 race cases fail, 37233585543 Sol = 3 fail):
- B-684-12 (both lenses): refund-dispute-handler.service.ts:550-566,625-648: two refund events for the same refund race; a succeeded
  writer reads pending, waits before SQL, a newer failed writer completes, the older writer's unconditional SQL restores succeeded and
  the under-lock re-read accepts its own bad write: coach 4,630 -> 0 with no alert; one variant ends client access. Fix rule: the status
  transition is atomic: compare-and-set (UPDATE ... WHERE id AND status/version = the value read; 0 rows = re-read and re-decide) or one
  charge-level row lock held across read-decide-write; terminal/monotonic order enforced in SQL, not in memory.
- B-684-3 (Sol; still open after three rounds): payout-notice.service.ts:408-414,470-481: the final email-attempt SQL and the
  NotificationsService token read can finish after the 480,000 ms run budget (probe: 660,000 ms) and the mail/Expo send still starts
  once, with no AbortSignal. Fix rule: re-check the deadline AFTER every awaited read and IMMEDIATELY before every provider call (email
  and push); no provider call may start past the deadline; pass an AbortSignal (or equivalent timeout) to provider calls bounded by the
  remaining budget; a skipped send releases its claim without burning a delivery attempt (C-684-10 behaviour stays fixed).
Do: fix in #684 with failing-before tests that reproduce both lenses' exact probe inputs (their probe bundles must go green unchanged);
regression tests in #697 (incl. C-697-3 race test); merge-only restack #697 -> #685 -> #686 (prove patch-ids unchanged). Keep C-686-3
renames (05bc6d31) intact. Then build a scratch merge of the new #686 top + origin/main + ops/reports/B-FEES18-119-no-pii-baseline.patch in
the CI lane and run the full suite (report the run and the scratch tree id). Money self-check (_COMMON_119 6). FIX ROUND + READY on #684
and #697, READY (restack) on #685 and #686 at green heads; write notify/fees.txt "fees top: #686 @ <sha> (B-FEES19-119, <time>)"; release
the lock. Report: ops/reports/B-FEES19-119.md.

## AUD-OPUS-S123-119 (Claude Opus 5.5) / AUD-SOL-S123-119 (GPT-6.1 Sol) — mobile payment sheet P1 #342 + P2 #343 + P3 #344 (lands with recurring)
Heads: mobile #342 e3226f3b50a1f609aea7805600ec124324cd12aa (FIX ROUND 3; 2,207), #343 691e0cf02a48db3e2d62f7c502673d9f1ef62215 (FIX ROUND 3;
2,935), #344 7e17d142d45cfcf6d922b6e78f79881be2428041 (FIX ROUND 4 = B-SHEET3-119 FR3 content + restack + B-SHEET4 tests; 2,866).
Builder reports ops/reports/B-SHEET4-119.md and B-SHEET3-119.md (verify every claim). Verdicts so far: #342/#343 Opus APPROVE at
0b1985f4/19678ce7 (5983935012, 5983935229), Sol RC (5983977653: residual B-342-1 archived-package refusal claims nothing charged;
5984020426: residual B-343-1 rejected native init republishes retired account notice). #344: never audited at a fixed head since
B-SHEET3-119: earlier Sol RC 5982674874 (B-344-1..4), Opus RC 5982759668 (B-344-5/6) at e7fcc5d2. Previous lens reports:
ops/reports/AUD-<LENS>-S12-119.md, AUD-<LENS>-SH3-118.md (+ probes in ops/aud-119 and ops/aud-118).
Do: decide your lens's prior findings on all three (closing commit + failing-before test), audit the #342/#343 round-3 delta and #344
deeply (B-SHEET3 FR3 plan management: list failure truth, cancel during dunning ends access now, voluntary cancel keeps access to
period end, R-DISPUTE-PAUSE copy (access ended, billing paused, coach restarts), resume result, support action), replay your probes.
Rules from the AUD-*-S12-119 entry above (copy truth, #661 and recurring reply codes, TODAY's production backend fallback, recurring
never one-time-only, no first person). Builder decisions (operator defaults accept): one wording for "no longer offered"; production
backend shows one "message your coach" line for in-app ending of a renewing plan; land #342-#344 as one with final-main Analyze, the
recurring backend deploy and dunning D4 #690 (cancel route). Post verdicts on #342, #343 and #344. Reports:
ops/reports/AUD-OPUS-S123-119.md, AUD-SOL-S123-119.md.

## AUD-OPUS-H46D-119 (Claude Opus 5.5) / AUD-SOL-H46D-119 (GPT-6.1 Sol) — mobile Health Connect H4 #362 FR3 + H5 #363 + H6 #364 delta (T4: health data)
Heads: mobile #362 73dbefbcbe97544710058dcab176ea8713654042 (FIX ROUND 3; 2,913), #363 f62f1bbe5d41332db403fd4e598f6ab864550dc1 (restack +
tests; 1,385), #364 b261f2188f3b6932145f05c45f7763c838bfc6ed (merge-only; own-diff patch-id unchanged, 19 files; 2,937). B-HC5-119 report
ops/reports/B-HC5-119.md (verify: failing-before 37232924285 = 10 fail; probes at #364 top 37233463017 257/257 and #362 37233484280
104/104). Prior verdicts: #362 Opus APPROVE / Sol RC (B-362-2 partial: a Disconnect can delete a grant written after it started;
B-362-6: account switch can still send) at b3bc0ce4; #363 dual APPROVE at 38ea0f81; #364 dual APPROVE at 529ba345. Previous reports
ops/reports/AUD-<LENS>-H46-119.md (+ probes). Audit the round-3 delta deeply (session re-check after every await and at token attach;
disconnect vs later grant; cloud providers covered by the same check), replay your probes, confirm #364's own diff is unchanged.
Operator defaults (accept unless you find harm): aborted Disconnect closes silently; a Disconnect racing Log out is dropped. Post
verdicts on #362, #363, #364. Reports: ops/reports/AUD-OPUS-H46D-119.md, AUD-SOL-H46D-119.md.

## B-TR5-119 (builder, Claude Opus 5.5, T4: trial conversion vs first payment) — trials T3 #673 (+ tests in T4 #706)
Heads: #673 904b964250f4b7694b24f78fdef5a5f846957013 (2,947; ceiling 3,000: 53 lines left), #706 a3f011638f29d80d92115b90ba0897a24f6ae709
(423; new PR, ceiling 1,500; tests only; DUAL APPROVE). #671 c75002c9 / #672 62c2c066 DUAL APPROVE: do not touch. Take lock `trials`.
Sol RC on #673 (5984422742; report ops/reports/AUD-SOL-T23D-119.md; probes ops/aud-119/AUD-SOL-T23D-119/ incl. 673-payment-race.spec.ts;
runs 37234706737, 37234895866): residual B-673-1 at src/packages/trials/trial-conflict.service.ts:265-286: a complete paid-history
response captured before the first open-invoice payment succeeds can arrive afterward while the active webhook is delayed; the worker
then DELETEs a plan that was just paid (4,900 minor units); actual handlers remove paid access. Opus C-673-6 (same race: never-billed
past_due cancel does not void the open invoice first) is now part of this B. Fix rule (Sol default, operator accepts): before the
destructive cancel, settle the open invoice(s) authoritatively: void each applicable open invoice; a "paid" or not-open outcome fails
closed (no DELETE; supersede and resync), bounded and replay-safe; a local lease/status read never stands in for remote truth. Also fold
C-673-7 only if it fits (negative/NaN amount_paid or zero with missing total must read `unknown`, not `none`).
Size: runtime fix in #673 must fit its 53 lines; if it cannot, run SIZE ASSESSMENT first (_COMMON_119 7) and propose the split (a new
piece under 1,500) in your report before writing it; tests go in #706. Failing-before with Sol's exact probe inputs (must go green
unchanged), passing-after, replay both lenses' prior probes. Merge-only restack #706 if #673 changes. Money self-check. FIX ROUND +
READY on #673 and #706 at green heads; notify/trials.txt; release lock. Report: ops/reports/B-TR5-119.md.

## B-SHEET5-119 (builder, Claude Opus 5.5, T3: copy truth, plan management) — mobile payment sheet P3 #344 ONLY
Head: mobile #344 7e17d142d45cfcf6d922b6e78f79881be2428041 (2,866; ceiling 3,000: 134 lines left). #342 e3226f3b and #343 691e0cf0 are
DUAL APPROVE: FROZEN, do not touch. Take lock `sheet`. Both lenses RC on #344 (Opus 0/1/9 5984450917, report AUD-OPUS-S123-119.md;
Sol 0/2/3 5984430303, report AUD-SOL-S123-119.md; probes ops/aud-119/AUD-*-S123-119/ incl. Sol planAuthority.test.tsx; runs Sol
37234565354, Opus P1 probe):
- B-344-7 (Opus): src/lib/planActions.ts:93-96 + YourPlansPanel.tsx:172-186: ending a free trial says "Access continues until <date>,
  the end of the period paid for". Nothing was charged. Fix rule: trial copy says access continues until the trial ends and nothing is
  charged; paid copy unchanged.
- B-344-2 residual (Sol): YourPlansPanel.tsx:218-237,304-311,363-375: End my plan is allowed from a cached active card after a failed
  refresh and unconditionally promises paid-period access; if the server is in dunning, cancel ends access now. Fix rule: no stale action
  without a verified read, OR truthful conditional consent for active/trialing ("if a payment is overdue, access ends now"); the
  dialog text must be true for every server state the action can hit (also covers Opus C-344-13).
- B-344-3 residual (Sol): YourPlansPanel.tsx:142-148,182-185,316-333: an old cancellation receipt string overrides newer authoritative
  plan reads ("Your plan is ended ... nothing more is charged" next to an active plan with a next charge). Fix rule: keep the receipt as
  structured outcome with provenance; reconcile it against each successful authoritative read; keep it during failures but never let it
  contradict current financial state.
Failing-before with both lenses' exact probes (green unchanged after), replay all older probes (_COMMON_119 6). If the fix cannot fit
134 lines, run SIZE ASSESSMENT first and report before writing. FIX ROUND + READY on #344 at a green head; notify/sheet.txt; release lock.
Report: ops/reports/B-SHEET5-119.md.

## B-WIZ2-119 (builder, Claude Opus 5.5, T3: coach setup, saved intents, money input) — mobile wizard W1 #345 + W2 #346 (merge-only restack W3 #347)
Heads: mobile #345 97c9005e644ebc13731d1477bfecc270a10552fd (2,580; ceiling 3,000), #346 2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60 (2,609),
#347 3beab160 (2,592; needs its own W3 round later: do NOT fix W3 findings, merge-only restack only). Take lock `wizard`.
Verdicts at these heads: Opus APPROVE #345 0/0/3, #346 0/0/4 (report ops/reports/AUD-OPUS-W12-119.md); Sol RC (report
ops/reports/AUD-SOL-W12-119.md; probes ops/aud-119/AUD-SOL-W12-119/; runs 37229996097, 37229996072):
- B-345-1 retained (Sol, 5983834812): packageCreateIntent.ts:361-368 (esp. :367): a saved write can be consumed/sent by a remounted
  same-account form before its retired origin's promise settles; the unconditional canceled-write cleanup then erases the now-sent key.
  Fix rule: never remove a saved identity unless exclusive coordinated ownership proves it unsent (key equality alone does not); keep
  ambiguous saved identity.
- B-346-3 (Sol, 5983834774): FirstPackageForm.tsx:174-184,191-218,234-241,419-422: default money input is captured before awaited durable
  hydration; hydration changes displayed fields while captured defaults update/publish the remembered package. Fix rule: explicit
  current-generation hydration readiness before edits/submit, then capture and validate the displayed snapshot.
Failing-before with Sol's exact probes (green unchanged after), replay all older probes of both lenses (ops/aud-118, ops/aud-119).
Tests go where headroom allows (each PR under 3,000). FIX ROUND + READY on #345/#346, RESTACK + READY on #347 at green heads;
notify/wizard.txt; release lock. Report: ops/reports/B-WIZ2-119.md.

## B-HC6-119 (builder, Claude Opus 5.5, T4: health data) — mobile Health Connect H4 #362 (tests in H5 #363; merge-only restack H6 #364) NARROW
Heads: mobile #362 73dbefbcbe97544710058dcab176ea8713654042 (2,913; ceiling 3,000: 87 lines left), #363 f62f1bbe5d41332db403fd4e598f6ab864550dc1
(1,385), #364 b261f2188f3b6932145f05c45f7763c838bfc6ed (2,937). #359-#361 DUAL APPROVE: do not touch. Take lock `hc`.
Verdicts at these heads: Opus APPROVE all three (5984555005 / 5984556343 / 5984556566; C-362-11); Sol RC #362 0/1/1 (5984526636), APPROVE
#363/#364. Reports ops/reports/AUD-OPUS-H46D-119.md, AUD-SOL-H46D-119.md; probes ops/aud-119/AUD-*-H46D-119/ (Sol runs 37235444130,
37235614084).
ONE finding, both lenses agree on the mechanism (Sol B-362-2 partial = Opus C-362-11): onDeviceState.ts (~:176-177 comment claims call-order
writes): an already-invoked asynchronous native storage removal can land after a newer grant write, because Android's storage library does
not guarantee JS-call-order effects; a just-made Connect is lost. Fix rule (narrow, both lenses' rule): route every local grant write and
removal through ONE JS promise chain (serial queue) so each native op starts only after the previous one settled; correct the comment.
Nothing else: no C folding, no refactor. Failing-before with Sol's permitted-scheduler probe (green unchanged after), replay both lenses'
H46/H46D probes. Tests in #363. Merge-only restack #364 (prove own-diff patch-id unchanged). FIX ROUND + READY on #362/#363, RESTACK +
READY on #364 at green heads; notify/hc.txt; release lock. Report: ops/reports/B-HC6-119.md.

## AUD-OPUS-FL2-119 (Claude Opus 5.5) / AUD-SOL-FL2-119 (GPT-6.1 Sol) — fees round 19 (#684 + #697 + #685 + #686) and the LANDING candidate
Heads: #684 c1a07d9cc0a282a4e335035d11bb7eb8b2e0eca5 (FIX ROUND 19; 2,843), #697 be7efc09d8a2caa2252b7ac51081e5ed6b8fa214 (2,791; new spec
test/s-fee-r19-refund-cas-send-window.spec.ts), #685 f0c48049ee7518862ed94924132122fa41da6865 (restack + ONE test line:
test/s-fee-r5-or-111-1.spec.ts:312 `expect.any(AbortSignal)`, because push now gets a signal; 2,959), #686
856831354270725f651b1a26a54cdc4750271108 (fees top; merge-only, patch-id f14b1e32b05a unchanged). #681 e9650dc4, #682 70f879a2, #683
cc183e0a DUAL APPROVE and unchanged. B-FEES19-119 report ops/reports/B-FEES19-119.md (verify: failing-before 37234800001 = 17 fail / 11
controls; passing-after 37234844023 394/394 with every prior probe of both lenses; scratch top + main 37235329330 green on 5 jobs, tree
e4f86d6e). Your previous verdicts at 9fb9c48f / c2585c97 / a61d50f4 / 30a118dd: see ops/reports/AUD-<LENS>-FL-119.md (B-684-12 both lenses;
Sol B-684-3; #697/#685/#686 APPROVE).
Do, in order:
1. #684 + #697: audit the round-19 delta (every changed line): refund status writes are compare-and-set on the status read, at most 5
   retries then the delivery fails with nothing moved (is "fails" a redelivery that converges? no money moved on exhaustion?); deadline
   and claim re-checked after every await; push and email get an AbortSignal bounded by the deadline/claim expiry (what happens if the
   abort lands after the provider accepted: duplicate push risk is a known C). Replay your FL probes (must pass unchanged). Money list end
   to end. Post verdicts on #684 and #697.
2. #685: the restack merge plus the one test line (judge that line); #686: merge-only (patch-id). Post verdicts on both.
3. LANDING candidate: branch wip/op119/land-fees @ d8d062ffea56d5c3d75f479fdc8e62e9cdfedf82 = merge of origin/main 3e9a9a75 into the new
   fees top 85683135 (auto-merged src/email/email.service.ts, email.types.ts, notifications/notifications.service.ts) + one commit applying
   ops/reports/B-FEES18-119-no-pii-baseline.patch (tightening only). Tree e4f86d6e == the CI-proved scratch tree. Audit the merged files,
   the baseline edit and the migration (20270210000000_s_fee_charge_settlement, additive). Record "LANDING CANDIDATE d8d062ff: APPROVE /
   REQUEST CHANGES" in your report and one line in notify/fees-landing.txt.
4. Only if steps 1-3 are all APPROVE from you: poll `gh pr view 681 --json headRefOid` every 3 minutes for up to 30 minutes; when it equals
   d8d062ffea56d5c3d75f479fdc8e62e9cdfedf82, post your #681 verdict at that exact head (whole fees stack + main as landed; required checks,
   incl. main-only CodeQL/danger/banned casts/SBOM, must be green; wait for CI within the 30 minutes). If any of your verdicts is RC, skip
   step 4 and END.
Reports: ops/reports/AUD-OPUS-FL2-119.md, AUD-SOL-FL2-119.md.

## AUD-OPUS-S3D-119 (Claude Opus 5.5) / AUD-SOL-S3D-119 (GPT-6.1 Sol) — mobile payment sheet P3 #344 FIX ROUND 5 delta (lands with recurring)
Head: mobile #344 bc4387ac9f1a35d8ad6746d8ece3cda75fe89ab4 (2,958; 42 lines left). #342 e3226f3b / #343 691e0cf0 DUAL APPROVE, untouched.
B-SHEET5-119 report ops/reports/B-SHEET5-119.md (verify: failing-before 37235851899 = 9 of 124; after 37235878848 451/457, 6 red
explained; required check run 37236117451). Your verdicts at 7e17d142: Opus RC 0/1/9 (B-344-7 trial "period paid for"), Sol RC 0/2/3
(B-344-2 stale-active consent; B-344-3 receipt overrides newer read). Reports ops/reports/AUD-<LENS>-S123-119.md (+ probes).
Audit the round-5 delta (every changed line): trial copy, End my plan blocked after a failed read ("Refresh your plans first", nothing
sent), overdue-payment sentence in every active/trialing end-plan dialog, structured receipt reconciled against newer successful reads.
Replay your probes; judge the 6 replaced/red tests. Builder decisions (operator defaults accept): block on unconfirmed card; overdue
sentence everywhere; land #342-#344 as one with final-main Analyze, the recurring backend deploy, D4 #690 and native card-update. Post a
verdict on #344. Reports: ops/reports/AUD-OPUS-S3D-119.md, AUD-SOL-S3D-119.md.

## AUD-OPUS-H46E-119 (Claude Opus 5.5) / AUD-SOL-H46E-119 (GPT-6.1 Sol) — mobile Health Connect #362 FIX ROUND 4 + #363 tests + #364 restack (SHORT delta)
Heads: mobile #362 df44285d8b60a421277114601efa475744c5fac1 (one file changed; 2,940), #363 51a8dc330ca100df82ee64e2725842b1ff9b93c6 (tests only:
Sol's probe unchanged + 5 cases; 1,626), #364 c084f8dfc40a3c7c473584603bec38c109afd5bf (merge-only; own-diff patch-id e50c714e unchanged).
B-HC6-119 report ops/reports/B-HC6-119.md (verify: failing-before 37236494922 = 5 fail / 13 pass; #362 174/174 37236954828; #364 top 674/675
37236923127, the one red = old Samsung retirement probe superseded by the Samsung-row ruling). Your verdicts at 73dbefbc / f62f1bbe /
b261f218: Opus APPROVE all (C-362-11); Sol RC #362 (B-362-2 partial: in-flight native removal vs newer grant), APPROVE #363/#364. Reports
ops/reports/AUD-<LENS>-H46D-119.md (+ probes). Scope: the serial queue (every grant write, progress write and removal one at a time in
call order): correctness, no deadlock or unbounded wait on a rejected op, no lost write; replay your probes; #364 own diff unchanged.
New C-362-12 (sign-out clears health keys outside the queue, authActions.ts:116; pre-existing): rate it. #363 at 1,626 lines (tests
only, grandfathered 3,000): operator SIZE ASSESSMENT keep. Post verdicts on #362, #363, #364. Reports: ops/reports/AUD-OPUS-H46E-119.md,
AUD-SOL-H46E-119.md.

## B-SHEET6-119 (builder, Claude Opus 5.5, T3: copy truth) — mobile payment sheet P3 #344 ONLY, ONE finding (B-344-3 residual)
Head: mobile #344 bc4387ac9f1a35d8ad6746d8ece3cda75fe89ab4 (2,958; ceiling 3,000: 42 lines left). #342/#343 FROZEN. Take lock `sheet`.
Verdicts at this head: Opus APPROVE 0/0/11 (5984695452); Sol RC 0/1/3 (5984798322; report ops/reports/AUD-SOL-S3D-119.md; probe
ops/aud-119/AUD-SOL-S3D-119/ delta-probes.test.tsx; failing run 37237449265 = 2 fail / 148 pass).
B-344-3 residual: YourPlansPanel.tsx:120-125,168-179,359-361: `agrees()` checks only the cancellation flag and non-ended state, not the
receipt's date/trial facts. Cancel scheduled through Nov 2 -> failed reload -> successful view scheduled through Dec 2 keeps the old Nov 2
receipt; if the original was trialing and the current view is a paid period, it still says the free trial ends Nov 2 and nothing is
charged. Fix rule: a successful read owns current access/financial state; the receipt survives only if its access-end date AND
trial/paid kind match the current view (else drop it); keep failed-read receipts, voided-amount/terminal info, canonical resume and
generation protection. Nothing else (no C folding). Failing-before with Sol's exact probe (green unchanged after), replay both lenses'
S123/S3D probes. If tests do not fit 42 lines, put only the minimal runtime fix in #344 and report the size problem (do not cross 3,000).
FIX ROUND + READY on #344 at a green head; notify/sheet.txt; release lock. Report: ops/reports/B-SHEET6-119.md.

## AUD-OPUS-T3E-119 (Claude Opus 5.5) / AUD-SOL-T3E-119 (GPT-6.1 Sol) — trials T3 #673 FIX ROUND 11 + T4 #706 FIX ROUND 2 (delta)
Heads: #673 dcf095b85f74478f44e1a090f2a93cbbd1c6d496 (2,999: no headroom left), #706 3d95f96e555627d7dd5605a6004c0df633687208 (940; tests only,
restacked). #671 c75002c9 / #672 62c2c066 DUAL APPROVE, untouched. B-TR5-119 report ops/reports/B-TR5-119.md (verify: failing-before
37236196278 = 36 assertion failures incl. Sol's exact probe; after 37237173197 236/236; probe replay 37237162635 70/75, 5 = ruled C
probes). Your verdicts at 904b9642 / a3f01163: Opus APPROVE both; Sol RC #673 (residual B-673-1 paid-conversion race), APPROVE #706.
Reports ops/reports/AUD-<LENS>-T23D-119.md (+ probes). Audit the round-11 delta: for an unbilled past_due/unpaid trial the worker voids
each open invoice and requires Stripe to confirm "void", then re-checks its lease and cancels; payment wins or unconfirmed void -> no
cancel, next run keeps the plan as paid; C-673-7 malformed amounts read `unknown`. Money list (replay-safety, bounded, fail closed).
Builder Cs (rate them): C-673-8 voiding moves past_due -> active; if cancel then fails or the webhook arrives first the client keeps one
unpaid period and support gets a false refund alert (no client money at risk); C-673-9 two or more open invoices exceed the lease ->
retries + support alert; uncollectible invoices not voided. Operator default: any further trials fix goes to a new piece under 1,500 or
the #680 integration round. Post verdicts on #673 and #706. Reports: ops/reports/AUD-OPUS-T3E-119.md, AUD-SOL-T3E-119.md.

## B-HC7-119 (builder, Claude Opus 5.5, T4: health consent boundary) — mobile Health Connect H4 #362 (tests H5 #363; merge-only restack H6 #364) NARROW
Heads: mobile #362 df44285d8b60a421277114601efa475744c5fac1 (2,940; ceiling 3,000: 60 lines left), #363 51a8dc330ca100df82ee64e2725842b1ff9b93c6
(1,626; tests), #364 c084f8dfc40a3c7c473584603bec38c109afd5bf (merge-only). #359-#361 DUAL APPROVE: do not touch. Take lock `hc`.
Verdicts at these heads: Opus APPROVE all three (5984831539 / 5984831702 / 5984831909; C-362-12, C-362-13); Sol RC #362 0/1/1 (5984939067),
APPROVE #363/#364. Reports ops/reports/AUD-OPUS-H46E-119.md, AUD-SOL-H46E-119.md; Sol's reusable spec
ops/aud-119/AUD-SOL-H46E-119/authActions.healthQueue.sol119e.test.ts (runs 37238210443, 37238472946).
B-362-7 (Sol; = disclosed C-362-12): src/services/authActions.ts:112-116,242-246,364,398 clears health keys with a raw prefix sweep outside
the storage chain; onDeviceState.ts:109-115,138,259 queued writes can finish after the sweep: a Connect in flight at sign-out leaves a
grant, and a same-account login with no new Connect auto-refreshes (imported, expected not_authorized). Fix rule: keep the synchronous
session stop first; then drain pending/queued health writes and enumerate/remove health keys THROUGH THE SAME CHAIN before signOut
resolves (also on account deletion); dropping stale queued writes must also invalidate later automatic authorization. Fold Opus C-362-13
(a failed grant save still counts as newer, so an earlier Disconnect keeps the old grant) ONLY if it is the same lines and fits; else leave
it. Failing-before with Sol's exact spec (green unchanged after); replay both lenses' H46D/H46E probes. Tests in #363 (stay under 3,000);
#362 must stay under 3,000. Merge-only restack #364 (patch-id unchanged). FIX ROUND + READY on #362/#363, RESTACK + READY on #364 at green
heads; notify/hc.txt; release lock. Report: ops/reports/B-HC7-119.md.

## B-RECUR8-119 (builder, Claude Opus 5.5, T4: recurring money) — restack recurring R1-R5 onto main (fees landed) + type #701 casts (B-701-1)
Precondition (operator confirms before launch): fees landed on main via #681 (main = f48267f9d7a58e517db390ed8bfdde3a18825746 (merge of #681 @ d8d062ff, 15:23 PDT)); #678's base retargeted to
main by the operator. Heads: #678 09e159d8 (2,594), #679 23d2c04c (2,943), #680 f267417a (2,779), #696 13c9a6c8 (2,197), #701 d624144c (615).
#678/#679/#680/#696 DUAL APPROVE; #701 Sol APPROVE, Opus RC B-701-1. Take lock `recurring`.
Do, bottom-up, merge-only (no content edits) except #701:
1. #678 <- origin/main (merge commit only); #679 <- #678; #680 <- #679; #696 <- #680; #701 <- #696. git merge-tree was clean for all five
   against d8d062ff (operator check 15:09). Overlap files with the fees delta: src/checkout/checkout-webhook-handler.service.ts,
   src/connect/fees/charge-settlement.service.ts: prove each restacked file equals "recurring side + fees side" (no hunk lost), per
   ops/reports/AUD-OPUS-R34D-119.md HANDOFF list (REVOKED_STATUSES, purchaseHasEnded gates, decline fence, unpaid, lock order) and
   ops/reports/AUD-SOL-R34D-119.md HANDOFF list; record patch-ids of each PR's own diff before/after (must be unchanged for #678-#696).
2. #701 B-701-1 (Opus 5984321334): type the 5 `as any` doubles (min. b-recur7a-119-r2.spec.ts:45,47); no `as unknown as` / `as never`;
   prove R75 banned-cast passes on #701's range AND on the composed top vs main. Tests only.
3. Full suite on the composed #701 top in the CI lane (all jobs incl. lint, type-check, R75, no-pii-in-logs), plus replay of both lenses'
   R12/R12D/R34/R34D probes (expected reds only as documented). Also check C-680-19 against the landed fees refund/dispute status writes.
4. Push fast-forward only; RESTACK + READY on #678/#679/#680/#696 and FIX ROUND + READY on #701 at green heads (each comment lists
   old head -> new head, merge parents, patch-id proof, run links). notify/recurring.txt; release lock. Report: ops/reports/B-RECUR8-119.md.

## AUD-OPUS-S3E-119 (Claude Opus 5.5) / AUD-SOL-S3E-119 (GPT-6.1 Sol) — mobile payment sheet P3 #344 FIX ROUND 6 (SHORT delta, one finding)
Head: mobile #344 88659e21806ace4fc0c883d624de1abc07413b6d (2,973; round 6 = +20/-5: test 2420854, fix 88659e2). B-SHEET6-119 report
ops/reports/B-SHEET6-119.md (verify: failing-before 37238293419 = 5 fails incl. Sol's 2 unmodified probe cases; after 37238384052 522/529,
Sol probe 7/7; required check 37238658638). Your verdicts at bc4387ac: Opus APPROVE 0/0/11 (5984695452), Sol RC 0/1/3 (5984798322,
B-344-3 residual). Scope: a scheduled cancel receipt survives only when a newer successful read shows the same access-end date and the
same trial/paid kind; failed reads keep it; voided-amount info, resume, generation protection unchanged. Opus: your probe D6 now fails
because its data contradicts itself (newer read Nov 2, cancel answer Dec 2; the read wins); the builder's consistent-data variant passes
(run 37238619376): confirm or refute. Post a verdict on #344. Reports: ops/reports/AUD-OPUS-S3E-119.md, AUD-SOL-S3E-119.md.

## B-TR6-119 (builder, Claude Opus 5.5, T4: trial conversion vs payment) — NEW runtime piece T5 on top of #706 (payable invoice domain)
Base: branch agent119/trials-split-4-tests (#706 3d95f96e, tests only, DUAL APPROVE). New branch agent119/trials-split-5-payable-domain, new
draft PR, ceiling 1,500 lines (new PR). #673 dcf095b8 (2,999) has NO headroom: do not edit #673 or #706. #671/#672 DUAL APPROVE. Lock `trials`.
Sol RC on #673 (5985038558; report ops/reports/AUD-SOL-T3E-119.md; probes ops/aud-119/AUD-SOL-T3E-119/; run 37239136442 = 2 behavioral
failures): B-673-1 narrowed: the void domain covers only `open` invoices (src/connect/stripe-connect-api.service.ts:322-326,
src/packages/trials/trial-conflict.service.ts:273-296,455-462); an `uncollectible` invoice can still be paid during paid-history
preparation while another open invoice is voided -> DELETE -> paid access lost. Fix rule: before paid-history preparation, establish
complete bounded coverage of every still-payable invoice class (at least open AND uncollectible), settle/fence each member to a confirmed
non-payable status (void) before DELETE, fail closed if the full set/lease/void proof is unavailable; a payment or ambiguous outcome keeps
the plan and supersedes/reconciles, never cancels. Two-or-more-open lease refusal stays a C (fails closed). Opus approved #673/#706 at these
heads (5984958541/5984958823; C-673-8..10). Failing-before with Sol's exact probes (green unchanged after); replay all prior trials
probes. OPENING + READY on the new PR at a green head (PR body: tier header, stack position T5, lands with #671-#706 as one). notify/trials.txt;
release lock. Report: ops/reports/B-TR6-119.md.

## AUD-OPUS-H46F-119 (Claude Opus 5.5) / AUD-SOL-H46F-119 (GPT-6.1 Sol) — mobile Health Connect #362 FIX ROUND 5 + #363 + #364 (SHORT delta)
Heads: mobile #362 261e7d4c37429c65bf8e84468c5521380ff5b0cc (2,983), #363 5266d6587cdccb4f01d9a3f33bb1c80a402be747 (1,944; tests only),
#364 1266038cd311f3dcfd8e472c04e3241a3061866b (merge-only; patch-id e50c714e unchanged). B-HC7-119 report ops/reports/B-HC7-119.md
(verify: Sol's spec failed both cases before ("imported" vs "not_authorized"); after 612/613 at H5 and 748/750 at the #364 top, reds =
Opus's C-362-13 probe that tested the old behaviour + superseded Samsung test). Your verdicts at df44285d / 51a8dc33 / c084f8df: Opus
APPROVE all (C-362-12, C-362-13); Sol RC #362 (B-362-7 sign-out sweep outside the queue), APPROVE #363/#364. Reports
ops/reports/AUD-<LENS>-H46E-119.md (+ probes). Scope: sign-out = stop health work first, drop queued writes, void earlier grants, await
the in-flight write, remove all health keys through the same queue; sign-out and account deletion resolve only after that. C-362-13 fold
(failed grant save no longer counts as newer). Opus: flip the expected value in your C-362-13 probe if the new behaviour is right. New
C-362-14 (key removal failure + restart restores old grant): rate it. #363 at 1,944 (tests only, grandfathered): operator keep. Post
verdicts on #362, #363, #364. Reports: ops/reports/AUD-OPUS-H46F-119.md, AUD-SOL-H46F-119.md.

## B-CM6-119 (builder, Claude Opus 5.5, T4: refunds, reversals, coach money) — coach M1 #674 main refresh after fees landed (+ restack #676 -> #677 -> #703)
Heads: #674 8cc17809 (2,975; base main), #676 ecaf75fd (2,984), #677 6340993b (2,918), #703 d60a6d58 (460; new PR, 1,500 ceiling). All
FIX ROUND 4 READY from B-CM5-119 (report ops/reports/B-CM5-119.md); NO lens has audited these heads yet. Take lock `coach`.
Fees landed on main at 15:23 (main f48267f9 = merge of #681 @ d8d062ff). git merge-tree of #674 vs main CONFLICTS in
src/checkout/checkout.module.ts, src/checkout/refund-dispute-handler.service.ts, src/connect/fees/split-ledger.service.ts,
src/connect/fees/transfer-orchestrator.service.ts, src/connect/stripe-connect-api.service.ts (operator check 15:31).
Do:
1. Merge origin/main into #674 and resolve every conflict so that BOTH sides' behaviour survives: fees (B-684-12 compare-and-set refund
   status writes with bounded retry; B-684-3 deadline/claim re-checks + AbortSignal; charge settlement; refund.updated routing; C-686-3
   log renames; no-pii baseline) AND coach (B-674-13 send-time clock, B-674-14 list completeness, C-674-12, B-676-5). Where both sides
   changed the same refund/reversal logic, keep ONE implementation and record the choice per hunk in your report (file:line, why).
   Re-run main's no-pii-in-logs ratchet (B-CM5 lowered refund-dispute-handler legacy count; fees changed it too: reconcile to the actual
   count, tightening only).
2. SIZE ASSESSMENT (_COMMON_119 7) on #674 after the merge (diff vs main): ceiling 3,000; if over, move tests up to #703 (1,500) first.
3. Merge-only restack #676 <- #674, #677 <- #676, #703 <- #677 (resolve only mechanical conflicts; prove own-diff patch-ids unchanged or
   explain each change).
4. Full suite on the #703 top in the CI lane (all jobs); replay B-CM5's lanes and both lenses' 118 probes (ops/aud-118) plus the fees
   FL/FL2 probes that touch refund-dispute-handler (ops/aud-119/AUD-*-FL*-119/): all green except documented by-design reds.
5. MAIN REFRESH + READY on #674 (list every conflict hunk and its resolution), RESTACK + READY on #676/#677/#703 at green heads.
   notify/coach.txt; release lock. Report: ops/reports/B-CM6-119.md.

## B-HC8-119 (builder, Claude Opus 5.5, T4: health consent across sign-out and restart) — NEW piece H7 on top of #364
Base: branch agent115/wear-split-6-retire-samsung (#364 1266038c, DUAL APPROVE). New branch agent119/wear-split-7-signout-durable, new
draft PR, ceiling 1,500 lines. #362 261e7d4c (2,983) has 17 lines left: do NOT edit #359-#364. Take lock `hc`.
Sol RC on #362 (5985235823; report ops/reports/AUD-SOL-H46F-119.md; failure suites ops/aud-119/AUD-SOL-H46F-119/
authActions.healthQueueFailures.sol119f.test.ts and authActions.restartGrant.sol119f.test.ts; runs 37240405511, 37240314801); Opus
APPROVE all (5985217014; rated these C-362-14/15).
- B-362-8 (= C-362-14): onDeviceState.ts:120-122,173-175,221-228: if getAllKeys or the health-prefix removeMany rejects at sign-out,
  signOut resolves but the persisted grant stays; after an app restart (fresh JS) the same account auto-refreshes (imported, expected
  not_authorized) without a new Connect. Fix rule: durable revocation (e.g. a persisted revoked/needs-Connect marker written first, or
  grant bound to a session id that sign-out rotates) and/or startup cleanup retry; uncertain invalidation fails closed and requires a
  new Connect. Cover both failure modes plus persistence-positive and successful-clear controls.
- B-362-9: authActions.ts:299,386-409,447: a Promise.all rejection from clearUserCache/clearAllStorage skips waiting for
  healthStateRetired, so signOut emits logout and resolves while a grant write is held and the sweep is queued. Fix rule: always await
  the already-started health retirement (finally) before logout and resolution, independent of other cleanup failures; keep the
  synchronous session stop and queued-write dropping. Deletion path uses the same signOut.
- C-362-13 remainder (overlapping failed grant writes) ONLY if the same lines; else leave it.
Runtime + tests in the new piece. Failing-before with Sol's exact suites (green unchanged after); replay all H46/H46D/H46E/H46F probes of
both lenses. OPENING + READY on the new PR at a green head (PR body: tier header, stack position H7, lands with #359-#364 as one).
notify/hc.txt; release lock. Report: ops/reports/B-HC8-119.md.

## QUEUE (operator launches as slots free; cap 15 concurrent, owner 12:28 PDT 10-04)
1. R5 pair #701 72eb096b. 2. HC pair m#362 b3bc0ce4 + m#364 529ba345 (then m#363 2858bac5 delta). 3. Lockout pair m#352 ac244d22 +
m#353 05d84f27 (then m#354 f084cc0f). 4. Wizard pair m#345 97c9005e + m#346 2baea5b8 (then #347 W3 fix round). 5. B-SHEET3-119 (m#344:
Sol B-344-1..4 5982674874 + Opus B-344-5/6 5982759668; lands with recurring and dunning D4 #690). 6. B-DUNB-119 (JOBS118 QUEUED item 8,
on the B-DUNSPLIT-119 D2 top). 7. Coach M4 #677 pair; dunning D1-D4 + D5 (#691 + #642) pairs; programs m#355-#358; remainder.
Operator after fees verdicts: land fees as one (rule 11) + deploy; merge-only restack recurring #678 -> #679 -> #680 -> #696 -> #701 onto
the final fees top; short lens deltas.
