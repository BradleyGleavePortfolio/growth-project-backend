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

## QUEUE (operator launches as slots free; cap 15 concurrent, owner 12:28 PDT 10-04)
1. R5 pair #701 72eb096b. 2. HC pair m#362 b3bc0ce4 + m#364 529ba345 (then m#363 2858bac5 delta). 3. Lockout pair m#352 ac244d22 +
m#353 05d84f27 (then m#354 f084cc0f). 4. Wizard pair m#345 97c9005e + m#346 2baea5b8 (then #347 W3 fix round). 5. B-SHEET3-119 (m#344:
Sol B-344-1..4 5982674874 + Opus B-344-5/6 5982759668; lands with recurring and dunning D4 #690). 6. B-DUNB-119 (JOBS118 QUEUED item 8,
on the B-DUNSPLIT-119 D2 top). 7. Coach M4 #677 pair; dunning D1-D4 + D5 (#691 + #642) pairs; programs m#355-#358; remainder.
Operator after fees verdicts: land fees as one (rule 11) + deploy; merge-only restack recurring #678 -> #679 -> #680 -> #696 -> #701 onto
the final fees top; short lens deltas.
