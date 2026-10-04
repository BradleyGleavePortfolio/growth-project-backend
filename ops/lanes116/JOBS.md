# Agent 116 job board — one agent per job, one or two PRs per job

Owner 2026-10-03 19:20 PDT: "start with 15 paralized agents on the biggest jobs". 19:25 PDT: "dont use agents on multiple PR's - it
takes away from the depth of scrutiny if they just did one or two PR's per turn". Read _COMMON_116.md first, then only your entry.
Heads verified 19:15-19:30 PDT 10-03; re-read the head before acting. The operator posted READY FOR AUDIT (and a SIZE ASSESSMENT where
over 1,500 lines) on every split piece at these heads at 19:26 PDT. All jobs are T4 unless stated.
Builders: Claude Opus 5.5. Lenses: Claude Opus 5.5 (AUD-OPUS-*) or GPT-6.1 Sol (AUD-SOL-*). Each lens pair = same PRs, independent.

Launch path (HANDOFF_AGENT_116.md 0.1): 1 privacy -> 2 money chain (fees -> deploy -> recurring -> deploy -> trials -> deploy) ->
3 coach onboarding + Money -> 4 failed payments -> 5 Health Connect day 1 -> 6 approved remainder + Programs -> 7 builds and review.

## WAVE 1 (launched 19:27 PDT)

### AUD-OPUS-PRIV-116 / AUD-SOL-PRIV-116 — backend #611, then mobile #315 (launch step 1, store blocker)
1. backend #611 @ 5eac8f21bb70460da7dea7be5ce9f84f40870afb (accurate privacy policy, consumer health notice). Both lenses APPROVED
   1af96efa; FIX ROUND 7 (B-MOB-A, agent 115) applied the owner's answers O-611-1..6 (_COMMON 10). Audit 1af96efa..5eac8f21 line by
   line: public legal text, so every sentence must be true of the code, the vendors and their retention settings; then re-confirm the
   rest still holds at this head. History: handoffs/op-115/reports/B-MOB-A-115.md and the #611 comment thread.
2. STAY: after both APPROVE, the operator refreshes #611 with main and mobile #315 (8fff3f8f, trust center opens the real policy;
   dual APPROVE earlier) with main; audit both refreshed heads as merge-only deltas (#315: confirm it links the exact policy URL #611
   serves). Then end. They merge together.

### AUD-OPUS-F12-116 / AUD-SOL-F12-116 — fees pieces F1 #681 and F2 #682
### AUD-OPUS-F34-116 / AUD-SOL-F34-116 — fees pieces F3 #683 and F4 #684
### AUD-OPUS-F56-116 / AUD-SOL-F56-116 — fees pieces F5 #685 and F6 #686 (+ the stack tree check)
Fees = coach net payouts: price minus the actual Stripe fee minus 2 percent, separate charges and transfers, refund/chargeback netting
(OR-111-1). Split of backend #627 @ 66162285 (merged with main d23fa317) into F1 #681 (5a19178d, base main) -> F2 #682 (007d3dcb)
-> F3 #683 (e2af8ca1) -> F4 #684 (42e9ca13) -> F5 #685 (858d3716, tests only) -> F6 #686 (7be7d396, tests only). Read all six PR
bodies first (scope of each piece), then audit YOUR two pieces to full depth.
- Prior evidence on #627: Opus APPROVE 0/0/1 @ 3a5338d7; Sol REQUEST CHANGES 0/1/0 @ 3a5338d7 (B-627-10); FIX ROUND 10 @ 66162285
  claims B-627-10 fixed and merged main 0d33c4d4. Decide your lens's open items for code inside your pieces; audit everything in your
  pieces that changed in 3a5338d7..66162285 (or since d23fa317's merge) deeply; evidence reuse per _COMMON 8.
- RED BY DESIGN: #682 and #683 build-and-test (F2 swaps the transfer orchestrator under main's purchase-split handler; main's
  purchase-split, webhook fee-split and checkout specs stay red until F4 #684 carries their updates). Verify the failing specs are
  exactly those. #681 is green but must not land alone. Land as one after the last APPROVE (rule 11), deploy with mobile #321.
- F56 only: also verify the tree at #686 equals #627 @ 66162285 merged with main d23fa317 (`git diff` empty apart from main's
  commits) and that F5/F6 tests assert the money invariants they claim (not tautologies, no mocked-away boundary).
- Open follow-up C-627-10 (nullable column) is a separate PR after merge; do not re-raise it as B.

### B-RECUR-116 (builder) — recurring stack round: backend #679 and #680 (#678 only as a mechanical restack)
Recurring packages are "LITERALLY MOST CRITICAL OF ALL". Stack: #678 (b89c199d, base fees F6 branch) -> #679 (517def8c) -> #680
(7e55cfcb); split of #654 @ 02c48de7 merged with #627 @ 66162285. Close the three findings of the unposted Sol draft at 02c48de7
(summarized in handoffs/op-115/reports/AUD-SOL-MONEY-115.md #654 entries and AUD-SOL-MONEY-2-115.md "Transferred #654"):
(a) B-654-5 narrowed: blindly replaying an uncertain subscription create after Stripe's 24-hour idempotency retention can create a
second subscription (also Opus C-654-8): never re-create blindly; read Stripe by the pinned terms/attempt metadata first; (b) C-654-10:
errorLabel lets arbitrary Error.name and code shapes into logs (closed allow-list; unknown -> a fixed label); (c) B-654-8: an
unavailable or failed cancellation marks a payable attempt expired while the provider object may still charge (stay retryable, or
reconcile from Stripe before expiring). Plus every cheap open Opus C (APPROVE 0/0/3 @ 02c48de7). Failing-before tests through the CI
lane (the old probe files are gone; rebuild from the report text). If a fix must live in #678, put it there and restack #679/#680.
Post FIX ROUND + READY FOR AUDIT on #679 and #680 (and a restack round on #678 if it moved, or a READY FOR AUDIT on #678 at its
current head if it did not). History: handoffs/op-115/reports/B-RECUR-3-115.md. Then end.

### B-661-116 (builder) — backend #661 round 3
#661 @ f4679fd8 (never return or keep client PaymentSheet credentials). Sol REQUEST CHANGES B-661-3 at that head: a late-delivered
earlier decline marks a paid retried purchase failed and drops access. Fix plan in handoffs/op-115/reports/B-FEE-9-115.md. Close it plus
every open Opus/Sol C you can (C-661-2 backfill SQL stays a report item; C-661-3: whichever of #661/#654 merges second carries the
credential clearing on subscription end/activation, state it in the body). READY FOR AUDIT when green, then end.

### AUD-OPUS-CM1-116 / AUD-SOL-CM1-116 — coach Money backend M1 #674 and M3 #676
Split of #641 @ f60ed603 merged with main d23fa317: M1 #674 (9a512028, base main, migration 20270314000000: head-coach transfer
reversal once, review and held-reversal admin endpoints) -> M3 #676 (564f33bf: Money read API, payout reason, HTTPS onboarding) ->
M4 #677 (tests) ; M2 #675 is separate. Prior at 02cd3f88: Sol REQUEST CHANGES 0/4/1, Opus REQUEST CHANGES 0/1/1 (B-641-12:
concurrent refunds on one transfer lose one locally; a live-DB test was preferred). FIX ROUND 5 @ f60ed603 was never audited: decide
your lens's findings, audit 02cd3f88..f60ed603 deeply for code in your pieces, then the rest of your pieces. Check owner-only authz on
the admin endpoints, idempotency of reversals, and that coach-visible money matches the ledger to the cent. History:
handoffs/op-115/reports/B-COACH-5-115.md.

### AUD-OPUS-D12-116 / AUD-SOL-D12-116 — dunning backend D1 #687 and D2 #688
Split of #628 @ dc47e0ef (tree at #691 = #628 head): D1 #687 (c2a901a8, base main: schema, cadence, dispatcher, Stripe billing
adapter) -> D2 #688 (6627044c: dunning v2 service) -> D3 #689 -> D4 #690 (first live change) -> D5 #691 (tests). Prior at 33e0696a:
Opus REQUEST CHANGES 0/1/2 (B-628-13 next declined renewal overwrites the dispute-cycle marker), Sol REQUEST CHANGES 0/1/0; FIX ROUND 8
@ dc47e0ef claims B-628-11, B-628-13, C-628-14/15. Rulings: retries Days 1/3/7, Day-10 lockout, 1A card update auto-charges the open
invoice and unlocks on success, 2A cancel during dunning voids the invoice and ends access now, voluntary cancel keeps access to period
end, free/code grants never enter dunning. #654/#628 never-entitled check: the second to merge unifies one helper. History:
handoffs/op-115/reports/B-DUNNING-7-115.md.

### B-CI-116 (builder) — one backend PR: stop the jest worker out-of-memory crashes in build-and-test
Evidence of the problem: main run 37144478819; #654's first attempt; reruns on #679/#685. Find the root cause (which suites balloon,
why the worker heap is exhausted) and fix it with the least change: jest `workerIdleMemoryLimit`, bounded `maxWorkers`, NODE_OPTIONS
heap sizing, or splitting heavy live suites. NEVER rename or remove a required check job (build-and-test keeps its exact name or every
merge blocks); never weaken a gate. Proof: the failing runs plus at least two green build-and-test runs on your branch with timings.
CI gate file = T4. Title `ci(...)`. READY FOR AUDIT when green, then end.

## QUEUED JOBS (operator launches these as wave-1 agents end; order = priority; heads re-verified at launch)
- AUD pair 661+CI: backend #661 (B-661-116's round-3 head) and B-CI-116's PR.
- AUD pair R12 / R3: recurring #678 + #679, then #680, at B-RECUR-116's READY heads. Prior: Opus APPROVE 0/0/3 @ 02c48de7; Sol draft
  RC 0/3/0 @ 02c48de7 (reports above). Stacked on fees F6: CodeQL/danger/banned casts/SBOM run only when the stack lands.
- AUD pair CM2: coach #677 (4aaee4ed, tests) + #675 (d1c98430, idempotent package create, base main; shares packages files with #672).
- AUD pair D34: dunning #689 (9e77159a) + #690 (f72668c2). AUD pair D5: dunning #691 (70bcaa43, tests).
- AUD pair T12: trials #671 (a6a2b589) + #672 (e06b5b13); AUD pair T3: trials #673 (5743e51f). Split of #656 @ 86223987. Opus: FULL
  audit (no Opus lens fully audited #656). Sol: prior RC 0/4/1 @ b9939d02, FIX ROUND 5 @ 86223987.
- Builders per fees/coach/dunning/trials findings: one builder per one or two pieces, bottom-up, stack lock for restacks.
- Merge-only delta pairs (operator refreshes first): backend #664 + #652; backend #642 + mobile #312.
- B-335 (mobile #335 C-335-4 fold: copy true when a coach lost access) and B-FLAG (backend PR: FEATURE_WEARABLES_INGEST_POST "true" in
  .github/fly-env-desired-state.json + docs/runbooks/launch-flags.md), then one AUD pair for both.
- Health Connect (mobile, split of #317 @ d0407b62; tree at #364 = #317 head + clinic pin "0" -> "1"; prior Opus APPROVE merge-only,
  Sol RC 0/1/0 only for two stale expectations #364 fixes): pairs W12 #359 + #360, W34 #361 + #362, W56 #363 + #364.
- Lockout (mobile, split of #322 @ 23435ec2, dual APPROVE): L12 #352 + #353, L3 #354.
- Programs (mobile, split of #328 @ fb76721f, dual APPROVE): G12 #355 + #356, G34 #357 + #358.
- Coach setup (mobile, split of #329; Sol BLOCK 1/1/0 history; FIX ROUND 5 claims B-329-1, C-329-8): S12 #345 + #346, S3 #347.
- Coach Money (mobile, split of #332; Opus RC 0/4/7 history, FIX ROUND 3 unaudited): N12 #348 + #349, N34 #350 + #351. RED BY
  DESIGN: #349 and #350 Typecheck, lint, test (main's paymentsConnectPackages and coachSaasBlockers suites expect the Earnings routes
  N2 removes; N4 #351 deletes the files and carries both updated suites).
- Payment sheet (mobile, split of #334, pairs with #680): P12 #342 + #343, P3 #344. OR-112-22: a Day 1 sheet failure is a blocker.
- B-339 (mobile #339 Sol B-339-1 copy truthfulness) and its AUD pair.

## NOT NOW (until the owner says otherwise)
Roman (#667-#670, #331), S-SCHED-2 (#634, #653, #365-#367, #336), push delivery (#692-#693, needs the FCM key), annex (#655,
#657-#660, #337), flag PRs #643/#650, #341, #340 (until re-based onto #351), older candidate stacks and Dependabot PRs.
