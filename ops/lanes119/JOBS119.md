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
2. SPLIT #688 into stacked pieces under 1,500 changed lines where possible (MODEL_ROUTING 8.2: each piece compiles, passes CI, carries
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
new tests go to #677; if #677 would pass 3,000, open a tests-only piece M5 on #677's branch (byte-identical moves, tier header) and say
so. Never push a PR over 3,000. Replay every prior probe from both lenses (threads, ops/aud-118/AUD-*-CM-118/); money self-check per
_COMMON_119 6 (owner-only authz, reversal idempotency under redelivery and concurrency, coach-visible money equals the ledger to the cent,
MRR rule). FIX ROUND + READY on #674 and #676, READY (restack) on #677 (and M5 if opened) at green heads; write notify/coach.txt; release
the lock. Report: ops/reports/B-CM5-119.md.

## QUEUE (operator launches as slots free; cap 15 concurrent, owner 12:28 PDT 10-04)
1. R5 pair #701 72eb096b. 2. HC pair m#362 b3bc0ce4 + m#364 529ba345 (then m#363 2858bac5 delta). 3. Lockout pair m#352 ac244d22 +
m#353 05d84f27 (then m#354 f084cc0f). 4. Wizard pair m#345 97c9005e + m#346 2baea5b8 (then #347 W3 fix round). 5. B-SHEET3-119 (m#344:
Sol B-344-1..4 5982674874 + Opus B-344-5/6 5982759668; lands with recurring and dunning D4 #690). 6. B-DUNB-119 (JOBS118 QUEUED item 8,
on the B-DUNSPLIT-119 D2 top). 7. Coach M4 #677 pair; dunning D1-D4 + D5 (#691 + #642) pairs; programs m#355-#358; remainder.
Operator after fees verdicts: land fees as one (rule 11) + deploy; merge-only restack recurring #678 -> #679 -> #680 -> #696 -> #701 onto
the final fees top; short lens deltas.
