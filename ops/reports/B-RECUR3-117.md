# B-RECUR3-117 (builder, agent 117) — recurring #680 round + new tests-only R4 piece; restack #678/#679/#680/R4

Start 04:32 UTC 2026-10-04 (21:32 PDT 10-03). Heads (gh api): #686 6f1b94a9 (not yet in #678), #678 ebbd170e, #679 f83dbdd2, #680 929f3968.
Open #680 findings at start: Sol RC 0/4/0 @ 2b10687c (5976246125): B-680-1..4. Opus RC 0/2/5 @ 2b10687c (5976299710): B-680-1, B-680-2, C-680-3..7.
Worktree: /home/user/workspace/wt/B-RECUR3-117-1 (branch b-recur3-117/680, from 929f3968 + cherry-pick of WIP 09e139b1, clean apply).

## Log
- 04:35 UTC worktree created; WIP 09e139b1 cherry-picked onto 929f3968 without conflict.
- 04:40-04:47 UTC finished B-680-2 on the WIP (isNeverEntitledPaymentAttempt, settled/unreadable invoice, PI path last_error only while never entitled), C-680-4 PI id via the expanded live read (retrieveSubscriptionForCheckout in the prefetch), updated the 4 specs that assumed the 23-hour cutoff (b-recur-fix-round-1 R1-6 x3, trial-card unreadable SetupIntent, fix-round-3 sub_1).
- 04:47 UTC new spec test/b-recur3-117-webhook-order.spec.ts; failing-before CI lane run 37177995713 (ci/B-RECUR3-117-680-before @ a2838992 = 929f3968 + spec): 19 failed / 4 controls passed, all assertion failures.
- 04:52 UTC race found in review: final decline and deletion together could reopen a canceled plan as past_due. Fix: past_due write re-reads under the package lock on the webhook tx. Race case added; failing-before run 37178249913 (ci/B-RECUR3-117-680-before-2 @ af259f31): 20 failed / 4 passed.
- Local targeted jest on the R3 tree: 14 recurring suites 223/223; 5 billing/webhook suites 163/163 (with overlap); eslint clean; banned casts net -2.
- #680 commits: test d10fb8c4 (spec byte-identical to af259f31's), fix 693015fa, size move 1753f176 (fix-round-3 + http specs out). #680 size 2,927 (+2,860/-67) vs #679. Pushed 1753f176 (fast-forward from 929f3968).
- R4 branch agent117/recur-split-4-service-specs: 04fee228 (both specs byte-for-byte from 693015fa, +790).
- 04:55 UTC fees.txt: "fees top: #686 @ e6893c97". Lock recur taken; merges: #678 2174eb7c (merge e6893c97, clean; R1 content identical to 6f1b94a9...ebbd170e), #679 0e1cfde0 (clean; R2 content identical), #680 d1c62ee1 (clean; R3 content identical), R4 48e690cd (clean; +790 only). All pushed; lock released ~04:57 UTC.
- R4 opened as #696 (base agent115/recur-split-3-webhooks-fixes, T4 tier header), converted to draft like the other pieces.
- 05:10 UTC CI: #678 12 pass / 1 skipping. #679 build-and-test jest OOM (community-message-shape.live) -> rerun 37178353868. #680 and #696 build-and-test SBOM flake (delivery-artifact assert-prod-sbom, 1 test of 12,9xx) -> reruns 37178359487, 37178390642.
- Operator 22:01 PDT mail: fees round 13 (B-FEES-117) will write a new fees top; one more merge-only restack if still running, otherwise the next recurring job. Do not touch #681-#686.
- Comment drafts: ops/aud-117/B-RECUR3-117/c678-fix-round-4.md, c679-fix-round-4.md, c680-fix-round-4.md; R4 body r4-body.md.
- 05:20 UTC #678 and #679 green; posted FIX ROUND 4 + READY FOR AUDIT: #678 5976827553 @ 2174eb7c, #679 5976827674 @ 0e1cfde0; bodies updated (builder, owner, evidence, Fix rounds row 4).
- 05:31 UTC #680 green (10 pass, 1 skipping after the SBOM-flake rerun); posted FIX ROUND 4 + READY FOR AUDIT 5976866903 @ d1c62ee1; body updated.
- #696 attempt 2 of run 37178390642 hit a different known flake (jest heap OOM in test/openapi-spec.spec.ts; 12,701 passed, 0 assertion failures); rerun as attempt 3 (one rerun per flake class).
- 05:45 UTC #696 attempt 3 of run 37178390642: jest heap OOM again (test/health.controller.spec.ts failed to run; 12,705 passed, 0 assertion failures). Not rerun a third time (no brute force). Posted PIECE OPENED on #696 without READY FOR AUDIT: 5976947082 @ 48e690cd; body Fix rounds row updated.
- 05:47 UTC deleted ci/B-RECUR3-117-680-before and -before-2; removed both worktrees (no node_modules symlinks left) and the local restack branches. fees.txt still "e6893c97" (no new fees top while running).

## HANDOFF
- Heads (all pushed; fast-forward or merge commits only; no force-push):
  - #678 agent115/recur-split-1-terms-foundation @ 2174eb7cd13c7560f0bb447b6fa560e9070de05b — FIX ROUND 4 + READY FOR AUDIT (5976827553); checks green 12/1 skipping. Needs fresh Opus + Sol (R1 changed since the b89c199d approvals).
  - #679 agent115/recur-split-2-subscription-checkout @ 0e1cfde00f6293c0ddf4ee9e2c99f5321bbe2cb8 — FIX ROUND 4 + READY FOR AUDIT (5976827674); checks green 10/1 skipping. B-679-1..7, C-679-1, C-679-2 closed (B-RECUR2-116 content).
  - #680 agent115/recur-split-3-webhooks-fixes @ d1c62ee100e4abd72c21295c32f8b32e450981da — FIX ROUND 4 + READY FOR AUDIT (5976866903); checks green 10/1 skipping. B-680-1..4, C-680-3..6 closed, plus a decline/deletion race; size 2,927.
  - #696 (new R4, tests only) agent117/recur-split-4-service-specs @ 48e690cdd46e9f0d77f03322d6b7e2c969cb2828, base #680 branch, draft, T4 — PIECE OPENED (5976947082), NOT ready: build-and-test red on runner flakes only (SBOM, then OOM twice; 0 assertion failures). 790 lines.
- Fees top used for the restack: #686 @ e6893c97. Operator 22:01 PDT: B-FEES-117 round 13 will write a new fees top; the next recurring job does one merge-only restack #678 -> #679 -> #680 -> #696 under lock `recur` (no new top seen while this job ran).
- Lock recur: released (~04:57 UTC). No worktrees or ci/ branches left.
- Open items / operator decisions (defaults in brackets):
  1. #696 build-and-test: one more `gh run rerun 37178390642 --failed`, then post READY FOR AUDIT at 48e690cd if green [next recurring job or operator does it; if the new fees top lands first, the restack round carries READY instead].
  2. C-680-7 unindexed setup_intent lookup (stripe_client_secret startsWith): needs a migration (SetupIntent id column or index, timestamp after 20270316000000) [follow-up migration after the stack lands; not in this stack].
  3. Main-era items outside the diff, not changed: maybeEmitFirstPayment P2002 can abort an outer tx; invoice.paid prefetch warning logs the error message [follow-up ticket].
  4. Landing obligations unchanged: never-entitled helper unified by dunning #691 (isNeverEntitledPaymentAttempt has its signature); C-661-3 credential clearing by the second of #661 / recurring; trials #673 converges to one trial ledger.
- Lens notes: probes that drive invoice.paid through the real handler need coachFirstPaymentNotification.findUnique in the fake tx; subscription events call retrieveSubscriptionForCheckout in prefetchForOuterTx. Comment copies: ops/aud-117/B-RECUR3-117/c678-fix-round-4.md, c679-fix-round-4.md, c680-fix-round-4.md, c696-ready.md, r4-body.md.
